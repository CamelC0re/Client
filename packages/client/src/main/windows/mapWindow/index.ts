// Copyright (C) 2025  HighLite
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import path from 'path';
import fs from 'fs';

// The detached World Map window. The World Map plugin (in the game renderer) generates a
// self-contained interactive viewer (the same one used for the HTML export) and streams it
// live data over IPC. We host it in a normal, movable/resizable BrowserWindow so the user
// can keep playing the game underneath.
let mapWindow: BrowserWindow | null = null;
// The game renderer that opened the map window — input forwarded from the map window
// (click-to-move, floor change) is relayed back to it.
let gameSender: WebContents | null = null;

function focusExisting(): BrowserWindow | null {
    if (mapWindow && !mapWindow.isDestroyed()) {
        if (mapWindow.isMinimized()) mapWindow.restore();
        mapWindow.focus();
        return mapWindow;
    }
    return null;
}

export function registerMapWindowIPC(): void {
    // Lets the renderer ask whether the detached window is still open. After the game's
    // 5-min AFK kick the renderer (client.html) reloads, so the new plugin instance has
    // forgotten the window — it queries this on startup to re-attach instead of leaving an
    // orphaned, frozen window the user has to close and reopen.
    ipcMain.handle('map-window:exists', () => !!(mapWindow && !mapWindow.isDestroyed()));

    // Open the map window. `html` is the full self-contained viewer document. If a window is
    // already open (normal reopen, or a re-attach after a renderer reload), reload it with
    // the fresh content and re-point the input relay at the current renderer rather than
    // returning early — this is what un-freezes an orphaned window after an AFK reload.
    ipcMain.on('map-window:open', async (event, html: string) => {
        try {
            const file = path.join(app.getPath('userData'), 'world-map-window.html');
            await fs.promises.writeFile(file, String(html ?? ''), 'utf-8');

            const sender: WebContents = event.sender;
            gameSender = sender; // always follow the current (possibly reloaded) renderer

            if (mapWindow && !mapWindow.isDestroyed()) {
                await mapWindow.loadFile(file); // refresh content (re-attach / reopen)
                focusExisting();
                return;
            }
            const win = new BrowserWindow({
                width: 980, height: 760, minWidth: 360, minHeight: 280,
                title: 'EvilLite — World Map',
                backgroundColor: '#111111',
                webPreferences: {
                    preload: path.join(__dirname, '../preload/index.js'),
                    sandbox: false,
                    webSecurity: app.isPackaged,
                },
                icon: path.join(__dirname, 'icons/icon.png'),
                show: false,
            });
            win.setMenu(null);
            win.once('ready-to-show', () => win.show());
            win.on('closed', () => {
                mapWindow = null;
                // Tell the game renderer to stop streaming.
                try { if (!sender.isDestroyed()) sender.send('map-window:closed'); } catch { /* gone */ }
            });
            mapWindow = win;
            await win.loadFile(file);
        } catch (e) {
            console.error('[MapWindow] open failed:', e);
        }
    });

    // Relay live data (player position / full snapshots) to the map window.
    ipcMain.on('map-window:update', (_event, data) => {
        if (mapWindow && !mapWindow.isDestroyed()) {
            try { mapWindow.webContents.send('map-window:update', data); } catch { /* closing */ }
        }
    });

    // Relay input forwarded from the map window (click-to-move, floor) to the game renderer.
    ipcMain.on('map-window:input', (_event, msg) => {
        if (gameSender && !gameSender.isDestroyed()) {
            try { gameSender.send('map-window:input', msg); } catch { /* gone */ }
        }
    });

    ipcMain.on('map-window:focus', () => { focusExisting(); });

    ipcMain.on('map-window:close', () => {
        if (mapWindow && !mapWindow.isDestroyed()) mapWindow.close();
    });
}
