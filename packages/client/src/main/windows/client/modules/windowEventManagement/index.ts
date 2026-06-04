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

import { ipcMain, BrowserWindow } from 'electron';

// Window Controls Handling
ipcMain.on('minimize-window', event => {
    // Get the BrowserWindow instance from the event
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && window.isMinimizable()) {
        window.minimize();
    }
});

ipcMain.on('toggle-maximize-window', event => {
    // Get the BrowserWindow instance from the event
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        if (window.isMaximized()) {
            window.unmaximize();
        } else {
            window.maximize();
        }
    }
});

ipcMain.on('close-window', event => {
    // Get the BrowserWindow instance from the event
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
        if (window.getTitle() === "Console") {
            window.hide();
            return;
        }
        window.close();
    }
});

// UI Ready Handling
ipcMain.on('ui-ready', event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.show();
    }
});

// Dev Tools Handling
ipcMain.on('show-dev-tools', event => {
    // Get the BrowserWindow instance from the event
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.webContents.toggleDevTools();
    }
});