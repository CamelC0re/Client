// Copyright (C) 2025  HighLite

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.


import { contextBridge, ipcRenderer } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';

const settingsAPI = {
    get: async (section, key) => ipcRenderer.invoke('settings:get', section, key),
    set: async (section, key, value) => ipcRenderer.invoke('settings:set', section, key, value),
    getAll: async () => ipcRenderer.invoke('settings:getAll'),
    getByName: async (label) => ipcRenderer.invoke('settings:getByName', label),
    selectDirectory: async (options) => ipcRenderer.invoke('settings:select-directory', options),
    validateDirectory: async (dirPath) => ipcRenderer.invoke('settings:validate-directory', dirPath),
};

const screenshotAPI = {
    capture: async () => ipcRenderer.invoke('screenshot:capture') as Promise<{ ok: boolean; path?: string; error?: string }>,
};

if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI);
        contextBridge.exposeInMainWorld('settings', settingsAPI);
        contextBridge.exposeInMainWorld('screenshot', screenshotAPI);
    } catch (error) {
        console.error(error);
    }
} else {
    // @ts-ignore (define in dts)
    window.electron = electronAPI;
    // @ts-ignore
    window.settings = settingsAPI;
    // @ts-ignore
    window.screenshot = screenshotAPI;
}
