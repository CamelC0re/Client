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

import { app, BrowserWindow, ipcMain, shell, session, protocol, net } from 'electron';
import path from 'path';
import { format } from 'url';

protocol.registerSchemesAsPrivileged([
    { scheme: 'eq', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } }
]);

import './modules/userPasswordManagement'; // Import user password management module
import './modules/windowEventManagement'; // Import window event management module

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Reroute any calls to the old website (highlite.dev) to the new one (ryelite.org).
//  For use with legacy plugins.
app.on("ready", () => {
    const filter = { 
        urls: [
            "*://highlite.dev/*", 
            "*://localhost:*/eq-assets/*", 
            "*://localhost:*/data/*", 
            "*://localhost:*/maps/*", 
            "*://localhost:*/ui/*", 
            "*://localhost:*/api/*"
        ] 
    };
  
    session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
        if (details.url.includes("highlite.dev")) {
            const newUrl = details.url.replace("highlite.dev", "evillite.net");
            callback({ redirectURL: newUrl });
        } else if (details.url.match(/http:\/\/localhost:\d+\/assets\//)) {
            // intercept Vite's absolute chunk requests in dev mode
            const newUrl = details.url.replace(/http:\/\/localhost:\d+\/assets\//, "eq://evilquest.net/assets/");
            callback({ redirectURL: newUrl });
        } else if (details.url.includes("/eq-assets/")) {
            // we redirect eq-assets to eq://evilquest.net/assets/
            const newUrl = details.url.replace(/\/eq-assets\//, "/assets/").replace(/http:\/\/localhost:\d+/, "eq://evilquest.net");
            callback({ redirectURL: newUrl });
        } else if (details.url.match(/http:\/\/localhost:\d+\/(data|maps|ui|api)\//)) {
            const newUrl = details.url.replace(/http:\/\/localhost:\d+/, "eq://evilquest.net");
            callback({ redirectURL: newUrl });
        } else {
            callback({});
        }
    });

    protocol.handle('eq', async (request) => {
        let url = request.url.replace('eq://', 'https://');
        
        try {
            const response = await net.fetch(url, {
                method: request.method,
                headers: request.headers,
                body: request.body
            });
            
            let body = await response.text();
            
            if (url.endsWith('.js') && response.status === 200) {
                const classRegex = /\bclass\s+([A-Za-z0-9_]+)/g;
                const classes = [];
                let match;
                while ((match = classRegex.exec(body)) !== null) {
                    classes.push(match[1]);
                }
                
                let exposeCode = `\nif (!document.client) document.client = new Map();\n`;
                for (const cls of classes) {
                    exposeCode += `try { document.client.set('${cls}', ${cls}); } catch(e){}\n`;
                }
                
                exposeCode += `if (!window.__eqSourceCode) window.__eqSourceCode = "";\n`;
                exposeCode += `window.__eqSourceCode += ${JSON.stringify(body + "\n")};\n`;
                exposeCode += `if (window.onEqModuleLoaded) window.onEqModuleLoaded();\n`;
                
                body += exposeCode;
                
                // Rewrite CSS and data URLs to use eq://
                body = body.replace(/url\(['"]?\/ui\//g, "url('eq://evilquest.net/ui/");
                body = body.replace(/(["'])\/data\//g, "$1eq://evilquest.net/data/");
                body = body.replace(/(["'])\/maps\//g, "$1eq://evilquest.net/maps/");
            }
            
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            
            return new Response(body, {
                headers: newHeaders,
                status: response.status,
                statusText: response.statusText
            });
        } catch (err) {
            console.error('[Protocol] Failed to fetch', url, err);
            return new Response('Fetch failed', { status: 500 });
        }
    });
});

export async function createClientWindow() {
    const mainWindow = new BrowserWindow({
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: false, // Disable sandboxing for compatibility with some libraries
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,

            webSecurity: app.isPackaged, // Disable web security only in development for CORS
        },
        minHeight: 500,
        minWidth: 500,
        icon: path.join(__dirname, 'icons/icon.png'),
        titleBarStyle: 'hidden',
        show: true,
    });

    mainWindow.setMenu(null);
    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
        const devUrl = `${process.env['ELECTRON_RENDERER_URL']}/client.html`;
        console.log('Loading dev URL:', devUrl);
        mainWindow.loadURL(devUrl);
    } else {
        const fileUrl = format({
            protocol: 'file',
            slashes: true,
            pathname: path.join(__dirname, '../renderer/client.html'),
            query: { windowId: mainWindow.id },
        });

        mainWindow.loadURL(fileUrl);
    }

    // Open Links in External Browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Allow pressing F12 to open dev tools
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            event.preventDefault();
            mainWindow.webContents.toggleDevTools();
        }
    });

    // Enable Zooming Page In and Out
    mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
        if (zoomDirection === 'in') {
            // Increase zoom factor by 0.1 and dispatch a resize event to adjust the layout
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() + 0.1
            );
        } else if (zoomDirection === 'out') {
            // Decrease zoom factor by 0.1 and dispatch a resize event to adjust the layout
            mainWindow.webContents.setZoomLevel(
                mainWindow.webContents.getZoomLevel() - 0.1
            );
        }
    });

    mainWindow.webContents.on('console-message', (event) => {
        ipcMain.emit('add-console-message', {
            level: event.level,
            text: event.message,
            lineNumber: event.lineNumber,
            source: event.sourceId
        });
    });

    // In development, modify requests to High Spell servers
    if (!app.isPackaged) {
        // Set user agent and origin for High Spell compatibility
        mainWindow.webContents.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
            (details, callback) => {
                if (details.url.includes('evilquest.net')) {
                    details.requestHeaders['Origin'] = 'https://evilquest.net';
                    details.requestHeaders['Referer'] =
                        'https://evilquest.net/';
                }
                callback({ requestHeaders: details.requestHeaders });
            }
        );
    }

    mainWindow.on('ready-to-show', () => {
        // Always start with zoom reset to 0.0
        mainWindow.webContents.setZoomLevel(0);
    });

    

    return mainWindow;
}
