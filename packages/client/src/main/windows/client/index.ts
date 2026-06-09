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
import fs from 'fs';

/**
 * Builds one consistent browser identity used by the JS fingerprint AND every network
 * header — matching what an ordinary Chrome on this same machine reports. We present
 * the REAL platform (just stripping "Electron"/"EvilLite" and adding the "Google
 * Chrome" brand), NOT a faked Windows one. A real browser on this box passes reCAPTCHA;
 * faking Windows on a Linux machine was an inconsistency reCAPTCHA could detect, so we
 * stop lying about the OS and stay honest + consistent across JS and the wire.
 */
function buildBrowserIdentity(nativeUa: string): { ua: string; secChUa: string; platform: string; major: string } {
    const ua = (nativeUa || '')
        .replace(/Electron\/[0-9.]+\s?/g, '')
        .replace(/EvilLite\/[0-9.]+\s?/gi, '')
        .trim();
    const major = ua.match(/Chrome\/(\d+)/)?.[1] ?? '138';
    // Real platform, derived from the (Electron-stripped) UA.
    let platform = '"Linux"';
    if (/Windows/i.test(ua)) platform = '"Windows"';
    else if (/Mac OS X|Macintosh/i.test(ua)) platform = '"macOS"';
    const secChUa = `"Not_A Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`;
    return { ua, secChUa, platform, major };
}

function localMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
        '.json': 'application/json', '.webm': 'video/webm',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    };
    return map[ext] ?? 'application/octet-stream';
}

import './modules/userPasswordManagement';
import './modules/windowEventManagement';
import { settingsService } from '../../modules/settingsManagement';
import { registerDevLogin } from '../../devLogin';

// DEV-ONLY: seamless browser-login session relay (Ctrl+Shift+L in the client).
// Pops out real Chrome to log in past reCAPTCHA, captures the session, injects it.
registerDevLogin();

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.on("ready", async () => {
    await session.defaultSession.clearStorageData();

    // Intercept ALL https requests so we can:
    //   1. Serve /__evillite__/* from local renderer files
    //   2. Rewrite game JS files (class exposure, URL patching)
    //   3. Pass everything else (Google, CDNs, etc.) through to the network
    protocol.handle('https', async (request) => {
        const url = new URL(request.url);

        // ── 1. Serve EvilLite's own renderer files ─────────────────────────
        // In dev mode: proxy to Vite dev server for TypeScript transforms + HMR
        // In production: serve from the built renderer output on disk
        if (url.hostname === 'evilquest.net' && url.pathname.startsWith('/__evillite__/')) {
            const filePart = url.pathname.replace('/__evillite__/', '');
            if (!app.isPackaged) {
                // Dev mode: proxy to Vite
                const viteUrl = `http://localhost:5173/${filePart}${url.search}`;
                try {
                    return await net.fetch(viteUrl, { bypassCustomProtocolHandlers: true } as any);
                } catch (err) {
                    console.error('[Protocol] Vite proxy failed for', filePart, err);
                    return new Response('Vite proxy failed', { status: 502 });
                }
            } else {
                // Production: serve from disk
                const localPath = path.join(__dirname, '../renderer', filePart);
                try {
                    const content = fs.readFileSync(localPath);
                    return new Response(content, {
                        headers: { 'Content-Type': localMimeType(localPath), 'Access-Control-Allow-Origin': '*' }
                    });
                } catch {
                    return new Response('EvilLite asset not found: ' + filePart, { status: 404 });
                }
            }
        }

        // Proxy Vite dev server internal paths (HMR, node_modules, source files)
        if (!app.isPackaged && url.hostname === 'evilquest.net' &&
            (url.pathname.startsWith('/@') || 
             url.pathname.startsWith('/node_modules/') ||
             url.pathname.startsWith('/client/') ||
             url.pathname.startsWith('/console/') ||
             url.pathname.startsWith('/settings/') ||
             url.pathname.startsWith('/updater/') ||
             url.pathname.startsWith('/icons/'))) {
            const viteUrl = `http://localhost:5173${url.pathname}${url.search}`;
            try {
                return await net.fetch(viteUrl, { bypassCustomProtocolHandlers: true } as any);
            } catch {
                return new Response('Vite proxy failed', { status: 502 });
            }
        }

        // ── 2. Proxy evilquest.net requests (game assets, API, /play) ────────
        if (url.hostname === 'evilquest.net') {
            const fullUrl = request.url;
            const isApi = url.pathname.startsWith('/api/') || url.pathname === '/play';
            const isAsset = url.pathname.startsWith('/assets/');

            if (isAsset) {
                console.log(`[Protocol-ASSET] ${request.method} ${fullUrl.slice(0, 120)}`);
            }

            try {
                // Inject session cookies
                const cookies = await session.defaultSession.cookies.get({ domain: 'evilquest.net' });
                const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

                if (isApi) {
                    console.log(`[Protocol] ${request.method} ${fullUrl}`);
                    console.log(`[Protocol] cookies sent (${cookies.length}): ${cookies.map(c => c.name).join(', ') || 'none'}`);
                }

                const outHeaders = new Headers(request.headers);
                if (cookieHeader) outHeaders.set('Cookie', cookieHeader);
                outHeaders.set('Origin', 'https://evilquest.net');
                outHeaders.set('Referer', 'https://evilquest.net/');
                
                let outUa = outHeaders.get('User-Agent') || '';
                if (outUa) {
                    outUa = outUa.replace(/Electron\/[0-9\.]+\s?/g, '').replace(/EvilLite\/[0-9\.]+\s?/g, '').trim();
                    outHeaders.set('User-Agent', outUa);
                }

                // Use bypassCustomProtocolHandlers to avoid infinite recursion
                const response = await net.fetch(fullUrl, {
                    method: request.method,
                    headers: outHeaders,
                    body: request.body,
                    duplex: 'half',
                    bypassCustomProtocolHandlers: true,
                } as any);

                if (isApi) {
                    console.log(`[Protocol] response ${response.status} for ${fullUrl}`);
                }

                // Persist Set-Cookie headers
                const setCookieValues = response.headers.getSetCookie?.() ?? [];
                for (const raw of setCookieValues) {
                    const parts = raw.split(';').map(s => s.trim());
                    const [name, ...rest] = parts[0].split('=');
                    if (isApi) console.log(`[Protocol] storing cookie: ${name.trim()}`);
                    const cookieDetails: Electron.CookiesSetDetails = {
                        url: 'https://evilquest.net',
                        name: name.trim(),
                        value: rest.join('=').trim(),
                        httpOnly: parts.some(p => p.toLowerCase() === 'httponly'),
                        secure: parts.some(p => p.toLowerCase() === 'secure'),
                    };
                    const maxAgePart = parts.find(p => p.toLowerCase().startsWith('max-age='));
                    const expiresPart = parts.find(p => p.toLowerCase().startsWith('expires='));
                    if (maxAgePart) {
                        const seconds = parseInt(maxAgePart.split('=')[1], 10);
                        if (!isNaN(seconds)) cookieDetails.expirationDate = Date.now() / 1000 + seconds;
                    } else if (expiresPart) {
                        const d = new Date(expiresPart.split('=').slice(1).join('='));
                        if (!isNaN(d.getTime())) cookieDetails.expirationDate = d.getTime() / 1000;
                    }
                    await session.defaultSession.cookies.set(cookieDetails).catch(() => {});
                }

                const newHeaders = new Headers(response.headers);
                newHeaders.set('Access-Control-Allow-Origin', '*');

                if (fullUrl.endsWith('.js') && response.status === 200) {
                    // JS files: class exposure + URL rewriting
                    let body = await response.text();

                    const classRegex = /\bclass\s+([A-Za-z0-9_]+)/g;
                    const classes: string[] = [];
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

                    // Instrument et() failure to log the exact error
                    body = body.replace(
                        /P=null,R=\{pct:0,status:"Failed to prepare game"\}/,
                        'P=null,R={pct:0,status:"Failed to prepare game"},console.error("[et-FAIL]",e&&e.message,e&&e.stack)'
                    );

                    return new Response(body, { headers: newHeaders, status: response.status, statusText: response.statusText });
                } else if (isApi) {
                    // API responses: log body for diagnostics
                    const body = await response.text();
                    if (response.status >= 400) {
                        console.log(`[Protocol] error body: ${body.slice(0, 400)}`);
                    } else {
                        console.log(`[Protocol] response body: ${body.slice(0, 600)}`);
                    }
                    return new Response(body, { headers: newHeaders, status: response.status, statusText: response.statusText });
                } else {
                    // Binary resources (images, fonts, audio)
                    const body = await response.arrayBuffer();
                    return new Response(body, { headers: newHeaders, status: response.status, statusText: response.statusText });
                }
            } catch (err) {
                console.error('[Protocol] Failed to fetch', fullUrl, err);
                return new Response('Fetch failed', { status: 500 });
            }
        }

        // ── 3. Pass through all other HTTPS requests (Google, CDNs, etc.) ────
        const passHeaders = new Headers(request.headers);
        const currentReferer = passHeaders.get('Referer') || '';
        if (currentReferer.includes('__evillite__')) {
            passHeaders.set('Referer', 'https://evilquest.net/');
        }
        
        // Normalise to one consistent Google-Chrome identity (matches the JS fingerprint).
        {
            // EXPERIMENT: let native Client-Hint headers flow (matching the now-native JS);
            // only keep the UA Electron-stripped (setUserAgent already does this natively).
            const id = buildBrowserIdentity(passHeaders.get('User-Agent') || app.userAgentFallback);
            passHeaders.set('User-Agent', id.ua);
        }

        // Inject cookies for this domain
        const cookies = await session.defaultSession.cookies.get({ url: request.url });
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        if (cookieHeader) passHeaders.set('Cookie', cookieHeader);
        
        if (request.url.includes('recaptcha/api2/reload')) {
            console.log(`[reCAPTCHA] Headers sent to Google:`);
            passHeaders.forEach((value, key) => console.log(`  ${key}: ${value}`));
        }
        
        const response = await net.fetch(request.url, { 
            method: request.method,
            headers: passHeaders,
            body: request.body,
            duplex: request.method !== 'GET' && request.method !== 'HEAD' ? 'half' : undefined,
            bypassCustomProtocolHandlers: true 
        } as any);

        // Persist Set-Cookie headers for Google
        const setCookieValues = response.headers.getSetCookie?.() ?? [];
        for (const raw of setCookieValues) {
            const parts = raw.split(';').map(s => s.trim());
            const [name, ...rest] = parts[0].split('=');
            const cookieDetails: Electron.CookiesSetDetails = {
                url: request.url,
                name: name.trim(),
                value: rest.join('=').trim(),
                httpOnly: parts.some(p => p.toLowerCase() === 'httponly'),
                secure: parts.some(p => p.toLowerCase() === 'secure'),
                sameSite: parts.find(p => p.toLowerCase().startsWith('samesite='))?.split('=')[1].toLowerCase() as any || 'unspecified'
            };
            const maxAgePart = parts.find(p => p.toLowerCase().startsWith('max-age='));
            const expiresPart = parts.find(p => p.toLowerCase().startsWith('expires='));
            if (maxAgePart) {
                const seconds = parseInt(maxAgePart.split('=')[1], 10);
                if (!isNaN(seconds)) cookieDetails.expirationDate = Date.now() / 1000 + seconds;
            } else if (expiresPart) {
                const d = new Date(expiresPart.split('=').slice(1).join('='));
                if (!isNaN(d.getTime())) cookieDetails.expirationDate = d.getTime() / 1000;
            }
            await session.defaultSession.cookies.set(cookieDetails).catch(() => {});
        }

        return response;
    });
});

ipcMain.handle('reset-captcha-session', async () => {
    console.log('[ReCAPTCHA] Force resetting session cookies and cache...');
    await session.defaultSession.clearStorageData();
    await session.defaultSession.clearCache();
    await session.defaultSession.clearAuthCache();
    return true;
});

// Reliable renderer→main diagnostic channel (renderer console.* doesn't always reach the log).
ipcMain.on('eq-diag', (_e, msg: string) => console.log('[EQ-DIAG]', msg));

export async function createClientWindow() {
    // If RECAPTCHA_PROXY is set (e.g. "socks5://user:pass@host:1080"), route
    // all traffic through it so reCAPTCHA sees a residential IP.
    const proxyUrl = process.env.RECAPTCHA_PROXY;
    if (proxyUrl) {
        console.log(`[Proxy] Using proxy for reCAPTCHA: ${proxyUrl.replace(/:([^@]+)@/, ':***@')}`);
        await session.defaultSession.setProxy({ proxyRules: proxyUrl }).catch(console.error);
    }

    // reCAPTCHA cookie handling is toggleable (Settings → Login).
    //  ON  → wipe Google's cookies/cache each launch: a cold, fresh session. Good for
    //        recovering from a flagged/burned session, but reCAPTCHA never builds trust.
    //  OFF → keep the cookie so reCAPTCHA accumulates trust across logins (recommended).
    // Either way we only touch Google's cookies, never evilquest's session.
    const clearRecaptcha = settingsService.get('Login', 'Clear reCAPTCHA session each launch') || process.env.EQ_FRESH === '1';
    if (clearRecaptcha) {
        try {
            await session.defaultSession.clearCache();
            for (const domain of ['google.com', 'www.google.com', 'gstatic.com', 'www.gstatic.com', 'recaptcha.net']) {
                const cks = await session.defaultSession.cookies.get({ domain });
                for (const c of cks) {
                    const host = c.domain?.replace(/^\./, '') ?? domain;
                    await session.defaultSession.cookies.remove(`https://${host}${c.path ?? '/'}`, c.name).catch(() => {});
                }
            }
            console.log('[ReCAPTCHA] cleared Google cookies + cache (Settings: clear-each-launch ON)');
        } catch (e) {
            console.error('[ReCAPTCHA] failed to clear Google session', e);
        }
    } else {
        console.log('[ReCAPTCHA] keeping Google cookies so reCAPTCHA can build trust (Settings: clear-each-launch OFF)');
    }

    const mainWindow = new BrowserWindow({
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            sandbox: false, // Must be false for @electron-toolkit/preload to work
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            webSecurity: true, // MUST be true for reCAPTCHA to function correctly
        },
        minHeight: 500,
        minWidth: 500,
        icon: path.join(__dirname, 'icons/icon.png'),
        titleBarStyle: 'hidden',
        show: true,
    });

    mainWindow.setMenu(null);
    // Load via https:// so the page origin is genuinely https://evilquest.net
    // Our protocol.handle('https') intercepts /__evillite__/ and serves local files
    mainWindow.loadURL('https://evilquest.net/__evillite__/client.html');

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            event.preventDefault();
            mainWindow.webContents.toggleDevTools();
        }
    });

    mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
        if (zoomDirection === 'in') {
            mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.1);
        } else if (zoomDirection === 'out') {
            mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.1);
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

    // Present a consistent desktop Windows Chrome identity (real major version) on the
    // top frame too, so navigator.userAgent matches the headers and the JS fingerprint.
    mainWindow.webContents.setUserAgent(buildBrowserIdentity(mainWindow.webContents.getUserAgent()).ua);

    // 1. Spoof User-Agent and Client Hints for ALL requests globally to pass reCAPTCHA
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
        (details, callback) => {
            const isWs = (details as any).resourceType === 'websocket'
                || details.requestHeaders['Upgrade'] === 'websocket'
                || details.requestHeaders['upgrade'] === 'websocket';
                
            if (isWs) {
                details.requestHeaders['Origin'] = 'https://evilquest.net';
                details.requestHeaders['Referer'] = 'https://evilquest.net/';
            }

            // Normalise to the SAME consistent Google-Chrome identity used by the
            // https proxy and the JS fingerprint (real version + platform, no Electron).
            const id = buildBrowserIdentity(details.requestHeaders['User-Agent'] || app.userAgentFallback);
            details.requestHeaders['User-Agent'] = id.ua;

            callback({ requestHeaders: details.requestHeaders });
        }
    );

    // Log all network errors
    mainWindow.webContents.session.webRequest.onErrorOccurred(
        (details) => {
            if (!details.url.includes('fonts.g') && !details.url.includes('gstatic')) {
                console.log(`[WebRequest ERROR] ${details.resourceType ?? ''} ${details.url} → ${details.error}`);
            }
        }
    );

    // Log all completed requests, except quiet assets
    mainWindow.webContents.session.webRequest.onCompleted(
        (details) => {
            const skip = ['.css', '.woff', '.webm', '.svg', '.ttf', 'fonts.googleapis', 'fonts.gstatic'];
            const isQuiet = skip.some(ext => details.url.includes(ext));
            // Always log errors; log non-quiet requests
            if (!isQuiet || details.statusCode >= 400) {
                console.log(`[WebRequest] ${details.method} ${details.url.slice(0, 120)} → ${details.statusCode}`);
            }
        }
    );

    mainWindow.on('ready-to-show', () => {
        mainWindow.webContents.setZoomLevel(0);
    });

    return mainWindow;
}
