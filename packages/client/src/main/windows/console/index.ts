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

import { app, BrowserWindow } from 'electron';
import path from 'path';
import { ipcMain } from 'electron';
export async function createConsoleWindow() {
    const consoleWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: false, // Disable sandboxing for compatibility with some libraries
            webSecurity: app.isPackaged, // Disable web security only in development for CORS
            
        },
        icon: path.join(__dirname, 'icons/icon.png'),
        titleBarStyle: 'hidden',
        show: false, // Start hidden, show when ready
    });

   if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
       consoleWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/console.html`);
   } else {
       consoleWindow.loadFile(path.join(__dirname, '../renderer/console.html'));
   }

   consoleWindow.setMenu(null);
    ipcMain.on('show-console', () => {
        if (consoleWindow) {
            if (consoleWindow.isMinimized()) {
                consoleWindow.restore();
            }
            consoleWindow.show();
        } else {
            console.error('Console window is not initialized');
        }
    });

    ipcMain.on('add-console-message', (data) => {
        if (consoleWindow) {
            consoleWindow.webContents.send('add-console-message', data);
        } else {
            console.error('Console window is not initialized');
        }
    });

    return consoleWindow;
}