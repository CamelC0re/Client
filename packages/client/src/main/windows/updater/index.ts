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

import { ipcMain, BrowserWindow, app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import path from 'path';
import { settingsService } from '../../modules/settingsManagement';

async function configureAutoUpdater() {
    autoUpdater.autoDownload = false; // Disable auto download to control it manually
    await settingsService.load();

    if (settingsService.getByName('Release Channel') == 'Beta') {
        log.info('Using Beta channel for updates');
        autoUpdater.allowDowngrade = false;
        autoUpdater.allowPrerelease = true;
    }

    if (settingsService.getByName('Release Channel') === 'Stable') {
        log.info('Using Stable channel for updates');
        autoUpdater.allowDowngrade = true;
        autoUpdater.allowPrerelease = false;
    }

    return Promise.resolve();
}


export async function createUpdateWindow() {
    await configureAutoUpdater();
    const updateWindow = new BrowserWindow({
        title: 'Updating RyeLite...',
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: false, // Disable sandboxing for compatibility with some libraries
        },
        frame: true,
        resizable: false,
        icon: path.join(__dirname, 'icons/icon.png'),
        titleBarStyle: 'hidden',
        width: 600,
        height: 400,
    });

    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
        updateWindow.loadURL(
            `${process.env['ELECTRON_RENDERER_URL']}/update.html`
        );
    } else {
        updateWindow.loadFile(path.join(__dirname, '../renderer/update.html'));
    }

    updateWindow.on('ready-to-show', async () => {
        if (!app.isPackaged) {
            ipcMain.emit('delay-update');
        } else {
            autoUpdater.checkForUpdates();
        }
    });

    autoUpdater.on('download-progress', progressObj => {
        log.info('Download progress:', progressObj.percent);
        updateWindow.webContents.send('download-progress', progressObj.percent);
    });

    autoUpdater.on('update-downloaded', async () => {
        log.info('Update downloaded');
        updateWindow.webContents.send('update-downloaded');
    });

    autoUpdater.on('update-available', async updateInfo => {
        log.info('Update available:', updateInfo.releaseName);
        updateWindow.webContents.send('update-available', updateInfo);
    });

    autoUpdater.on('update-not-available', async () => {
        log.info('Update not available');
        ipcMain.emit('no-update-available');
    });

    ipcMain.once('install-update', async () => {
        log.info('Installing update...');
        autoUpdater.quitAndInstall();
    });

    ipcMain.once('download-update', async () => {
        log.info('Downloading update...');
        autoUpdater.downloadUpdate();
    });

    ipcMain.once('delay-update', async () => {
        log.info('Update delayed');
    });

    // Open Links in External Browser
    updateWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    return updateWindow;
}
