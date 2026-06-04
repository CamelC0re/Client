/*! 
Copyright (C) 2025  HighLite

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

*/

// TODO: Centralize settings syncing and ensurement here to clean up access requirements across main process


import { settingsSchema } from "../../../preload/settings";
import { createSettingsModal } from "../../windows/settings/index";
import { BrowserWindow, ipcMain, dialog, app } from "electron";
import fs from 'fs';
import path from 'path';

// Centralized Settings Service
class SettingsService {
    private static instance: SettingsService;
    private settingsPath: string;

    private constructor() {
        this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
    }

    private ensureDynamicDefaults() {
        try {
            const pictures = app.getPath('pictures');
            // Set default for Screenshot Directory dynamically
            const screenshotsSection = (settingsSchema.settings as any)?.['Screenshots'];
            if (screenshotsSection && Array.isArray(screenshotsSection.fields)) {
                const dirField = screenshotsSection.fields.find((f: any) => f && f.label === 'Screenshot Directory');
                if (dirField) {
                    dirField.default = pictures;
                }
            }
        } catch (e) {
            // If app.getPath fails (shouldn't after ready), ignore
        }
    }

    static getInstance() {
        if (!SettingsService.instance) {
            SettingsService.instance = new SettingsService();
        }
        return SettingsService.instance;
    }

    async load(): Promise<any> {
        try {
            this.ensureDynamicDefaults();
            const data = await fs.promises.readFile(this.settingsPath, 'utf-8');
            // Load the full schema JSON to preserve structure/validation bindings
            settingsSchema.loadFromJSON(data);
            return JSON.parse(data);
        } catch {
            // If file doesn't exist, return defaults
            this.ensureDynamicDefaults();
            return this.getAll();
        }
    }

    // Persist the current in-memory schema to disk
    async saveCurrent(): Promise<void> {
        const schemaJson = JSON.stringify((settingsSchema as any).settings, null, 2);
        await fs.promises.mkdir(path.dirname(this.settingsPath), { recursive: true });
        await fs.promises.writeFile(this.settingsPath, schemaJson, 'utf-8');
    }

    // Save from a full schema JSON string (compat path)
    async saveFromSchemaJSON(schemaJSONString: string): Promise<void> {
        settingsSchema.loadFromJSON(schemaJSONString);
        await fs.promises.mkdir(path.dirname(this.settingsPath), { recursive: true });
        await fs.promises.writeFile(this.settingsPath, schemaJSONString, 'utf-8');
    }

    getAll(): any {
        // Return current settings as plain object
    this.ensureDynamicDefaults();
        const out: Record<string, any> = {};
        Object.entries(settingsSchema.settings).forEach(([sectionKey, section]: any) => {
            out[sectionKey] = {};
            (section.fields || []).forEach((field: any) => {
                out[sectionKey][field.label] = field.value ?? field.default;
            });
        });
        return out;
    }

    get(section: string, key: string): any {
        const sec = (settingsSchema.settings as any)?.[section];
        if (!sec || !Array.isArray(sec.fields)) return undefined;
        const field = sec.fields.find((f: any) => f && f.label === key);
        return field ? (field.value ?? field.default) : undefined;
    }

    async set(section: string, key: string, value: any): Promise<void> {
        const sec = (settingsSchema.settings as any)?.[section];
        if (!sec || !Array.isArray(sec.fields)) return;
        const field = sec.fields.find((f: any) => f && f.label === key);
        if (field) {
            field.value = value;
            await this.saveCurrent();
        }
    }

    getByName(label: string): any {
        const entries = Object.entries(settingsSchema.settings || {});
        for (const [, section] of entries) {
            if (!section || !Array.isArray((section as any).fields)) continue;
            const field = (section as any).fields.find((f: any) => f && f.label === label);
            if (field) return field.value ?? field.default;
        }
        return undefined;
    }
}


// Export for main process use
export const settingsService = SettingsService.getInstance();



// IPC Handlers for settings API
let settingsWindowRef : BrowserWindow | null = null;
ipcMain.on('settings:open', async (event) => {
    console.warn("Here");
    const parent = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    if (!parent) return;
    if (settingsWindowRef?.isDestroyed() || !settingsWindowRef) {
        settingsWindowRef = await createSettingsModal(parent);
    }
});

ipcMain.handle('settings:close', async () => {
    if (settingsWindowRef && !settingsWindowRef.isDestroyed()) {
        settingsWindowRef.close();
        settingsWindowRef = null;
    }
});

ipcMain.handle('settings:get', async (_event, section: string, key: string) => {
    return settingsService.get(section, key);
});

ipcMain.handle('settings:set', async (_event, section: string, key: string, value: any) => {
    await settingsService.set(section, key, value);
    return true;
});

ipcMain.handle('settings:getAll', async () => {
    return settingsService.getAll();
});

ipcMain.handle('settings:getByName', async (_event, label: string) => {
    return settingsService.getByName(label);
});

ipcMain.handle('settings:load', async () => {
    return await settingsService.load();
});

ipcMain.handle('settings:apply', async (_event, newSettings) => {
    try {
    // Expect newSettings as a full schema JSON string
    await settingsService.saveFromSchemaJSON(String(newSettings));
        return true;
    } catch (e) {
        console.error('Failed to save settings:', e);
        return false;
    }
});

ipcMain.handle('settings:select-directory', async (event, options?: { title?: string; defaultPath?: string }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent ? await dialog.showOpenDialog(parent, {
        properties: ['openDirectory', 'createDirectory'],
        title: options?.title ?? 'Select Directory',
        defaultPath: options?.defaultPath ?? undefined,
    }) : await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: options?.title ?? 'Select Directory',
        defaultPath: options?.defaultPath ?? undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('settings:validate-directory', async (_event, dirPath: string) => {
    try {
        await fs.promises.access(dirPath, fs.constants.F_OK);
        await fs.promises.access(dirPath, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
});

