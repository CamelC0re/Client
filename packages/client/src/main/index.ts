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

import { app, BrowserWindow, ipcMain } from 'electron';
import { electronApp } from '@electron-toolkit/utils';
import { createUpdateWindow } from './windows/updater';
import { createConsoleWindow } from './windows/console';
import { createClientWindow } from './windows/client';
import log from 'electron-log';
import registerScreenshotIPC from './modules/screenshotManagement/index';

log.initialize({ spyRendererConsole: true });
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// Remove Electron's automation fingerprint so reCAPTCHA scores us as a real browser
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// Dev-only: expose CDP so we can inspect/drive the renderer (EQ_DEBUG=1).
if (process.env.EQ_DEBUG === '1') {
    app.commandLine.appendSwitch('remote-debugging-port', '9222');
    app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:9222');
}

// Dev-only GPU enablement (EQ_GPU=1). On this dev box, launching through Xwayland
// makes Chromium fall back to SwiftShader (software GL); native Wayland + the DRI
// render node uses the real GPU (the recipe Google Chrome uses here). Shipped users
// auto-detect their GPU, so this is gated to dev.
if (process.env.EQ_GPU === '1') {
    // Hardware GL via ANGLE/EGL on the DRI render node, while keeping the X11
    // presentation path (Wayland ozone renders fine but does NOT present frames to
    // the visible window here — a grey-screen quirk). This gives the real GPU + a
    // window that actually paints.
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('use-gl', 'angle');
    app.commandLine.appendSwitch('use-angle', 'gl-egl');
    app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}

// Keep a reference to the hidden console window so we can close it when no other windows remain

let consoleWindowRef: BrowserWindow | null = null;

app.whenReady().then(async () => {
    // Report whether hardware GL is actually active (vs SwiftShader software fallback).
    // Query AFTER the GPU process settles (the immediate value is unreliable).
    setTimeout(async () => {
        try {
            const status = app.getGPUFeatureStatus();
            console.log(`[GPU] webgl=${status.webgl} webgl2=${status.webgl2} gpu_compositing=${status.gpu_compositing}`);
            const info: any = await app.getGPUInfo('complete');
            const aux = info?.auxAttributes ?? info;
            console.log(`[GPU] renderer=${aux?.glRenderer ?? '?'} | vendor=${aux?.glVendor ?? '?'} | driver=${aux?.driverVersion ?? '?'}`);
        } catch (e) { console.log('[GPU] info unavailable', e); }
    }, 6000);

    // Globally strip Electron and EvilLite from User-Agent so reCAPTCHA JS doesn't see it in navigator.userAgent
    app.userAgentFallback = app.userAgentFallback.replace(/Electron\/[0-9\.]+\s?/g, '').replace(/EvilLite\/[0-9\.]+\s?/g, '').trim();
    
    electronApp.setAppUserModelId('com.ryelite.desktop');
    const updateWindow: BrowserWindow = await createUpdateWindow();

    consoleWindowRef = await createConsoleWindow();
    consoleWindowRef.on('closed', () => {
        consoleWindowRef = null;
    });

    registerScreenshotIPC();
    ipcMain.once('delay-update', async () => {
        await createClientWindow();
        updateWindow.close();
    });

    ipcMain.on('no-update-available', async () => {
        await createClientWindow();
        updateWindow.close();
    });

    // For any future windows created elsewhere, attach a closed handler
    // to determine when only the console window is left.
    app.on('browser-window-created', (_event, win) => {
        if (win !== consoleWindowRef) {
            win.on('closed', () => {
                const others = BrowserWindow.getAllWindows().filter(w => w !== consoleWindowRef);
                if (others.length === 0 && consoleWindowRef && !consoleWindowRef.isDestroyed()) {
                    consoleWindowRef.close();
                    consoleWindowRef = null;
                }
            });
        }
    });

    app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) {
            createClientWindow();
        }
    });
});

app.on('second-instance', (_event, _argv, _workingDirectory) => {
    // Someone tried to run a second instance, open a new window in response.
    createClientWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
