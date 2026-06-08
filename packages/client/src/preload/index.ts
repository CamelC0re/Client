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
// IMPORTANT: keep the brand/version numbers consistent with each other and with the
// network User-Agent set in the main process (Chrome 120 / Windows).
webFrame.executeJavaScript(`
(function () {
    var def = function (obj, prop, getter) { try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (e) {} };

    // Present ONE consistent desktop **Windows** Chrome identity across JS + every
    // network header (the main process forces the same Windows UA + Client-Hint
    // headers). Windows is the common, high-trust profile for reCAPTCHA v3; a
    // consistent Linux profile scores lower. The Chrome major version is taken from
    // the real engine so it matches.
    var major = (navigator.userAgent.match(/Chrome\\/(\\d+)/) || [])[1] || '138';
    var fullVer = major + '.0.0.0';
    var winUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + fullVer + ' Safari/537.36';

    // 0. Kill the automation flag explicitly (belt-and-suspenders alongside the
    //    disable-blink-features switch).
    def(navigator, 'webdriver', function () { return false; });

    // 1. User-Agent family — all Windows, all consistent.
    def(navigator, 'userAgent', function () { return winUa; });
    def(navigator, 'appVersion', function () { return winUa.replace('Mozilla/', ''); });
    def(navigator, 'platform', function () { return 'Win32'; });
    def(navigator, 'vendor', function () { return 'Google Inc.'; });
    // Match the US-English locale our Windows identity implies (consistency, not a spoof).
    def(navigator, 'languages', function () { return ['en-US', 'en']; });
    def(navigator, 'language', function () { return 'en-US'; });

    // 1b. Notification/permissions consistency. The classic headless tell is
    //     Notification.permission === 'default' while permissions.query(notifications)
    //     resolves to 'denied'. Real Chrome returns 'prompt'. Keep them aligned.
    try {
        if (window.Notification && Notification.permission === 'default' && navigator.permissions && navigator.permissions.query) {
            var origQuery = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = function (desc) {
                if (desc && desc.name === 'notifications') return Promise.resolve({ state: 'prompt', name: 'notifications', onchange: null });
                return origQuery(desc);
            };
        }
    } catch (e) {}

    // 2. Client Hints — Windows, with the Google Chrome brand (Electron omits it).
    var brands = [
        { brand: 'Not_A Brand', version: '8' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major }
    ];
    var uaData = {
        brands: brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function () {
            return Promise.resolve({
                architecture: 'x86', bitness: '64', brands: brands,
                fullVersionList: [
                    { brand: 'Not_A Brand', version: '8.0.0.0' },
                    { brand: 'Chromium', version: fullVer },
                    { brand: 'Google Chrome', version: fullVer }
                ],
                mobile: false, model: '', platform: 'Windows',
                platformVersion: '15.0.0', uaFullVersion: fullVer, wow64: false
            });
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: 'Windows' }; }
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

    // 4. WebGL — report a real Windows GPU (consistent with the Windows identity);
    //    masks the dev box's software renderer, which is a bot signal.
    try {
        var VENDOR = 37445, RENDERER = 37446; // UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL
        var spoofVendor = 'Google Inc. (NVIDIA)';
        var spoofRenderer = 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)';
        var patchGL = function (proto) {
            if (!proto || proto.__eqGlPatched) return;
            var orig = proto.getParameter;
            proto.getParameter = function (p) {
                if (p === VENDOR) return spoofVendor;
                if (p === RENDERER) return spoofRenderer;
                return orig.apply(this, arguments);
            };
            proto.__eqGlPatched = true;
        };
        if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);
    } catch (e) {}
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
