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

import { webFrame, contextBridge, ipcRenderer } from 'electron';

// ─── Anti-detection / fingerprint normalisation (runs before page scripts) ───
// Make Electron present as ordinary desktop Chrome so reCAPTCHA v3 scores it as a
// real browser. Runs in the MAIN world (contextIsolation is on). Every override is
// individually try/caught so one failure never aborts the rest.
//
// EXPERIMENT: all JS fingerprint overrides are DISABLED. Incognito Chrome (no spoofing)
// passes on this exact IP while our spoofed client fails — which means our overrides are
// the tell: overriding navigator props leaves non-native getters/functions that reCAPTCHA
// can detect, and a clean browser has none. So present pure, untampered Electron/Chromium.
false && webFrame.executeJavaScript(`
(function () {
    var def = function (obj, prop, getter) { try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {} };

    // Present the REAL, honest platform — exactly what an ordinary Chrome on this same
    // machine reports — instead of faking Windows. A real Chrome browser on this box
    // logs in fine; our previous Windows spoof on a Linux machine was an inconsistency
    // reCAPTCHA could detect (claimed Windows, but real WebGL/engine behaviour = Linux).
    // So we DON'T override userAgent/platform/WebGL anymore — we only (a) ensure the
    // automation flag is off, (b) add the "Google Chrome" brand to Client Hints (Electron
    // reports "Chromium" only) at the REAL version + REAL platform, and (c) fill window.chrome.
    var ua = navigator.userAgent || '';
    var major = (ua.match(/Chrome\\/(\\d+)/) || [])[1] || '138';
    var fullVer = (ua.match(/Chrome\\/([\\d.]+)/) || [])[1] || (major + '.0.0.0');
    var isWin = /Windows/i.test(ua), isMac = /Mac OS X|Macintosh/i.test(ua);
    var chPlatform = isWin ? 'Windows' : (isMac ? 'macOS' : 'Linux');
    var platVer = isWin ? '15.0.0' : (isMac ? '13.6.0' : '6.8.0');

    // 0. Automation flag off (matches a real browser; belt-and-suspenders with the switch).
    def(navigator, 'webdriver', function () { return false; });
    def(navigator, 'vendor', function () { return 'Google Inc.'; });
    def(navigator, 'languages', function () { return ['en-US', 'en']; });
    def(navigator, 'language', function () { return 'en-US'; });
    // NOTE: we deliberately do NOT override navigator.userAgent / appVersion / platform —
    // they're the real values (the main process only strips "Electron"), so they stay
    // consistent with the actual engine, exactly like a normal Chrome.

    // 1b. Notification/permissions consistency (the classic headless tell: permission
    //     'default' but query() resolves 'denied'; real Chrome returns 'prompt').
    try {
        if (window.Notification && Notification.permission === 'default' && navigator.permissions && navigator.permissions.query) {
            var origQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = function (desc) {
                if (desc && desc.name === 'notifications') return Promise.resolve({ state: 'prompt', name: 'notifications', onchange: null });
                return origQuery(desc);
            };
        }
    } catch (e) {}

    // 2. Client Hints — keep the REAL platform/version, just add the "Google Chrome"
    //    brand (Electron's brand list has Chromium but not Google Chrome).
    var brands = [
        { brand: 'Not_A Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major }
    ];
    var uaData = {
        brands: brands,
        mobile: false,
        platform: chPlatform,
        getHighEntropyValues: function () {
            return Promise.resolve({
                architecture: 'x86', bitness: '64', brands: brands,
                fullVersionList: [
                    { brand: 'Not_A Brand', version: '8.0.0.0' },
                    { brand: 'Chromium', version: fullVer },
                    { brand: 'Google Chrome', version: fullVer }
                ],
                mobile: false, model: '', platform: chPlatform,
                platformVersion: platVer, uaFullVersion: fullVer, wow64: false
            });
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: chPlatform }; }
    };
    def(navigator, 'userAgentData', function () { return uaData; });

    // 3. window.chrome — real Chrome always exposes these; Electron's stub is partial.
    try {
        var c = window.chrome || {};
        if (!c.runtime) c.runtime = {};
        if (typeof c.runtime.connect !== 'function') c.runtime.connect = function () { return { onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} }; };
        if (typeof c.runtime.sendMessage !== 'function') c.runtime.sendMessage = function () {};
        if (!c.app) c.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        if (typeof c.csi !== 'function') c.csi = function () { return { startE: Date.now(), onloadT: Date.now(), pageT: (performance && performance.now ? performance.now() : 0), tran: 15 }; };
        if (typeof c.loadTimes !== 'function') c.loadTimes = function () {
            var t = (performance && performance.timeOrigin ? performance.timeOrigin / 1000 : Date.now() / 1000);
            return { requestTime: t, startLoadTime: t, commitLoadTime: t, finishDocumentLoadTime: t, finishLoadTime: t, firstPaintTime: t, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' };
        };
        try { window.chrome = c; } catch (e) {}
    } catch (e) {}

    // 4. WebGL — NO spoof. With hardware GL we report the real GPU, exactly like the
    //    real browser. (Faking a Windows D3D11 GPU on a Linux machine was the tell.)
})();
`);

// 1. Removed JS patch for navigator.webdriver (detectable). Now handled natively.

// 2. Removed JS patch for navigator.plugins. Detectable spoofing causes lower reCAPTCHA scores.

// 3. Removed JS patch for navigator.languages. Detectable spoofing causes lower reCAPTCHA scores.

// ─── Exposed APIs (contextBridge) ────────────────────────────────────────────

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
    try { contextBridge.exposeInMainWorld('electron', electronAPI); } catch (error) { console.error(error); }
    try { contextBridge.exposeInMainWorld('settings', settingsAPI); } catch (error) { console.error(error); }
    try { contextBridge.exposeInMainWorld('screenshot', screenshotAPI); } catch (error) { console.error(error); }
    // 'chrome' already exists as Electron's Chromium stub — we enhance it via
    // an inline <script> in client.html instead of contextBridge.
} else {
    // @ts-ignore
    window.electron = electronAPI;
    // @ts-ignore
    window.settings = settingsAPI;
    // @ts-ignore
    window.screenshot = screenshotAPI;
}
