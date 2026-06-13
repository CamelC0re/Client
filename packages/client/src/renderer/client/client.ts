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

import { Highlite } from '@evillite/core'
import { Reflector } from '@evillite/core'
import { HighliteResources } from '@evillite/core';
import '@iconify/iconify';
import '@static/css/index.css';
import '@static/css/overrides.css';
import '@static/css/item-tooltip.css';

import './helpers/titlebarHelpers.js';
import { setupWorldSelectorObserver } from './helpers/worldSelectHelper';

// Note: With the page running on https://evilquest.net, relative paths like
// /assets/..., /data/..., /maps/..., /ui/..., /api/... resolve naturally to
// https://evilquest.net/... which our protocol.handle('https') intercepts.
// No fetch/XHR/createElement patching is needed for URL rewriting.


// Window layout scaffold (titlebar + plugin sidebar). Built here — BEFORE the
// body.appendChild patch below — so it uses the native appendChild. #main must exist
// before PanelManager.setup() runs: the plugin sidebar (highlite_bar) is appended to
// #main, so without it the sidebar is silently never created. game-wrapper lives inside
// #main as a flex sibling of the sidebar. Layout *mode* (Reserve Space vs Overlay) +
// titlebar auto-hide are applied from settings once they load (setupLayout(), below).
document.body.classList.add('eq-layout-reserve');
{
    const gw = document.getElementById('game-wrapper');
    let main = document.getElementById('main');
    if (!main) { main = document.createElement('div'); main.id = 'main'; document.body.appendChild(main); }
    if (gw && gw.parentElement !== main) main.appendChild(gw);
}

// Sandbox dynamically injected game UI elements into the game wrapper
const originalBodyAppendChild = document.body.appendChild.bind(document.body);
document.body.appendChild = function<T extends Node>(node: T): T {
    const wrapper = document.getElementById('game-wrapper');
    if (wrapper && (node as any).tagName?.toLowerCase() !== 'script' && !(node as any).classList?.contains('highlite_titlebar') && !(node as any).classList?.contains('highlite-ui')) {
        return wrapper.appendChild(node);
    }
    return originalBodyAppendChild(node);
};

const originalBodyInsertBefore = document.body.insertBefore.bind(document.body);
document.body.insertBefore = function<T extends Node>(node: T, child: Node | null): T {
    const wrapper = document.getElementById('game-wrapper');
    if (wrapper && (node as any).tagName?.toLowerCase() !== 'script' && !(node as any).classList?.contains('highlite_titlebar') && !(node as any).classList?.contains('highlite-ui')) {
        const targetChild = (child && child.parentNode === wrapper) ? child : null;
        return wrapper.insertBefore(node, targetChild);
    }
    return originalBodyInsertBefore(node, child);
};


// Load settings via centralized API (values are available via window.settings)
await window.settings.getAll();

// Apply the window-layout settings now that they're loaded.
await (async function setupLayout() {
    const body = document.body;
    const tbSel = () => document.querySelector('.highlite_titlebar') as HTMLElement | null;

    const applyMode = (mode: string, autoHide: boolean) => {
        const overlay = mode === 'Overlay';
        body.classList.toggle('eq-layout-overlay', overlay);
        body.classList.toggle('eq-layout-reserve', !overlay);
        body.classList.toggle('eq-titlebar-autohide', autoHide);
        // Static titlebar (auto-hide off) must never carry the hidden state.
        tbSel()?.classList.toggle('eq-titlebar-hidden', autoHide);
        // The game re-fits its canvas to the new container on resize.
        window.dispatchEvent(new Event('resize'));
    };

    const mode = ((await window.settings.getByName('Layout Mode')) as string) || 'Reserve Space';
    const autoHide = !!(await window.settings.getByName('Auto-hide Titlebar'));
    applyMode(mode, autoHide);

    // Auto-hide reveal: only acts while the titlebar is in auto-hide mode (gated by the
    // body class), so a static titlebar is never yanked away by the cursor.
    const REVEAL_Y = 8, HIDE_Y = 60;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const isAutoHide = () => body.classList.contains('eq-titlebar-autohide');
    const setHidden = (h: boolean) => { if (isAutoHide()) tbSel()?.classList.toggle('eq-titlebar-hidden', h); };
    window.addEventListener('mousemove', (e) => {
        if (!isAutoHide()) return;
        const tb = tbSel();
        const overBar = tb ? e.clientY <= tb.offsetHeight + 4 : false;
        if (e.clientY <= REVEAL_Y || overBar) {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            setHidden(false);
        } else if (e.clientY > HIDE_Y && !hideTimer) {
            hideTimer = setTimeout(() => { setHidden(true); hideTimer = null; }, 400);
        }
    }, { passive: true });

    // Live-apply when the user saves settings (broadcast from settings:apply in main).
    window.electron?.ipcRenderer?.on?.('settings:applied', async () => {
        const m = ((await window.settings.getByName('Layout Mode')) as string) || 'Reserve Space';
        const a = !!(await window.settings.getByName('Auto-hide Titlebar'));
        applyMode(m, a);
    });
})();

// Honor the game's logout. EVERY logout path — the manual button, the server's 5-min
// AFK kick, and session-expiry — clears localStorage.evilquest_token to return to the
// login screen. Hook that removal and clear our OAuth session SYNCHRONOUSLY (sendSync,
// no race) so the silent auto-login on the following reload can't bounce the user back
// in and bypass the game's logout / AFK timer.
const _eqRemoveItem = localStorage.removeItem.bind(localStorage);
localStorage.removeItem = function (key: string) {
    if (key === 'evilquest_token') {
        try {
            (window.electron.ipcRenderer as any).sendSync('oauth:logged-out');
        } catch {
            try { window.electron.ipcRenderer.send('oauth:logged-out'); } catch { /* ignore */ }
        }
    }
    return _eqRemoveItem(key);
};

// PRIMARY login: OAuth 2.0 + PKCE. Try a silent refresh BEFORE the game loads so the
// SPA authenticates on first paint (no reCAPTCHA, no reload). Sets the same localStorage
// token the SPA validates on load; cookies are set in the main process during refresh.
// Falls through to the login screen (+ "Log in with EvilQuest" button) on first run.
try {
    const auto = await window.electron.ipcRenderer.invoke('oauth:auto-login');
    if (auto?.ok && auto.token) {
        localStorage.setItem('evilquest_token', auto.token);
        localStorage.setItem('evilquest_username', auto.username || '');
        localStorage.setItem('evilquest_saved_username', auto.username || '');
        console.log('[EvilLite] OAuth silent login ok (' + (auto.clientId || '') + ')');
    } else {
        console.log('[EvilLite] OAuth auto-login: ' + (auto?.reason || 'no session'));
    }
} catch (e) {
    console.warn('[EvilLite] OAuth auto-login error', e);
}

// OAuth activity heartbeat: while the user is logged in + in-world, ping the main process
// so it keeps the session "active". This is what lets a reload/reopen within 5 minutes
// silently re-login (matching EvilQuest's AFK window); once these pings stop (app closed
// or AFK-kicked), a later cold start requires a manual login — the first login of a
// session is never silent. See oauth:heartbeat / oauth:auto-login in oauthLogin.ts.
setInterval(() => {
    const u = (document as any).highlite?.gameHooks?.GameManager?.Instance?.username ?? (window as any).gm?.username;
    if (u) { try { window.electron.ipcRenderer.send('oauth:heartbeat'); } catch { /* ignore */ } }
}, 60 * 1000);

async function obtainGameClient() {
    // For EvilQuest, the game scripts like babylon-core.js and GameManager.js are loaded
    // dynamically. We will need to set up interception for these scripts to apply Reflector hooks.
    console.log('[EvilLite] Preparing game client interception...');
    
    // Parse the game source and bind hooks — exactly once, after all modules
    // have loaded. The game ships several minified ESM bundles that load in
    // dependency order; onEqModuleLoaded can fire unpredictably (or only once,
    // for whichever module happens to finish after this handler is installed),
    // so we DON'T parse on the callback directly. Instead a poller below waits
    // for __eqSourceModules to stop growing, then parses the complete set.
    const runReflectorParse = () => {
        if ((window as any).__eqHooksBound || (window as any).__eqIsParsing) return;
        const eqModules: string[] = (window as any).__eqSourceModules
            ?? ((window as any).__eqSourceCode ? [(window as any).__eqSourceCode] : []);
        if (!eqModules.length) return;
        (window as any).__eqIsParsing = true;
        console.log('[EvilLite] Reflector parsing', eqModules.length, 'module(s)...');
        // Run in the background — its IndexedDB saveHooks() call can stall.
        Reflector.loadHooksFromModules(eqModules).then(() => {
            const hm = (document as any).highlite?.managers?.HookManager;
            // bindClassHooks is idempotent (registerClass skips already-bound classes),
            // so re-running on a later/fuller module set safely binds the stragglers.
            if (hm) {
                Reflector.bindClassHooks(hm);
                Reflector.bindEnumHooks(hm);
            }
            const bound = Object.keys((document as any).highlite?.gameHooks || {});
            console.log('[EvilLite] Reflector bound:', bound.join(',') || '(none)');
            // Only consider hooks "done" once GameManager (the critical one) is bound.
            // EvilQuest can chunk-load the GameManager bundle AFTER the first settle, so
            // if it's missing we leave this open and the poller re-parses with more modules.
            if (bound.includes('GameManager')) (window as any).__eqHooksBound = true;
        }).catch(e => {
            console.warn('[EvilLite] Reflector threw an error (ignoring):', e);
        }).finally(() => {
            (window as any).__eqIsParsing = false;
        });
    };

    // Start the core + plugins via the canonical login sequence, ONCE, after the
    // user is actually logged in. EvilQuest's socket class doesn't expose the
    // method names core hooks for login (_loggedIn, etc.), so the normal
    // SocketManager._loggedIn -> startHook() path never fires here. We drive it
    // ourselves: register hooks (initialize), init the DB (start), then run
    // startHook() — which resolves the username, populates each plugin's reactive
    // plugin.data from IndexedDB (addPlugin), and runs initAll/postInitAll/startAll.
    // Gating on a resolved username guarantees per-user data is keyed correctly and
    // that plugin.data is loaded BEFORE plugins start reading it.
    let coreInitDone = false;
    let coreStarted = false;
    const startPluginsOnce = async () => {
        const hi = (window as any).highliteInstance;
        if (!hi || (window as any).highliteInstanceStarted || (window as any).__eqPluginsStarting) return;

        // Register hooks once (binds gameHooks methods + login/logout hooks).
        if (!coreInitDone) { hi.initialize(); coreInitDone = true; }

        // Username = the user is logged in + in-world. Prefer the Reflector-captured
        // GameManager.Instance, but fall back to the raw window.gm — the Reflector can
        // flake (e.g. when EvilQuest ships a new bundle) and we must NOT let that stop the
        // client from starting. window.gm.username is the reliable signal either way.
        const username = document.highlite?.gameHooks?.GameManager?.Instance?.username
            ?? (window as any).gm?.username;
        if (!username) return; // not logged in yet — the login poller retries

        (window as any).__eqPluginsStarting = true;
        try {
            console.log('[EvilLite] Login-ready (' + username + ') — starting core + plugins...');
            // start() (DB init + plugin-hub bar icon) is NOT idempotent — only once.
            if (!coreStarted) { await hi.start(); coreStarted = true; }
            await hi.startHook('login');  // settings + plugin.data + initAll/postInitAll/startAll
            (window as any).highliteInstanceStarted = true;
            console.log('[EvilLite] Plugins started for ' + username);
        } catch (e) {
            console.warn('[EvilLite] Plugin start failed:', e);
            (window as any).__eqPluginsStarting = false; // allow a later retry
        }
    };

    // Poller A: parse + bind hooks once the module set has settled AND the game core is
    // up. window.gm existing guarantees the GameManager bundle has executed and is in
    // __eqSourceModules, so the parse can actually find it (the old "settle on a timer"
    // raced and often parsed before GameManager chunk-loaded -> zero hooks bound).
    // Re-parses whenever more modules have arrived since the last attempt, and only
    // stops once GameManager is bound.
    let lastCount = -1;
    let stableTicks = 0;
    let lastParsedCount = -1;
    const settleTimer = setInterval(() => {
        const modules = (window as any).__eqSourceModules;
        const count = Array.isArray(modules) ? modules.length : 0;
        if (count === lastCount && count > 0) {
            stableTicks++;
            if (stableTicks >= 3 && !(window as any).__eqHooksBound && (window as any).gm && count > lastParsedCount) {
                lastParsedCount = count;
                console.log('[EvilLite] Parsing at', count, 'modules (game core ready)...');
                runReflectorParse();
            }
        } else {
            stableTicks = 0;
        }
        lastCount = count;
        if ((window as any).__eqHooksBound) clearInterval(settleTimer);
    }, 300);

    // Poller B: drive the login sequence. Runs until plugins have started (login can
    // happen well after hooks bind, so this must outlive Poller A).
    const loginTimer = setInterval(() => {
        startPluginsOnce();
        if ((window as any).highliteInstanceStarted) clearInterval(loginTimer);
    }, 500);

    // Legacy signal: harmless nudge.
    (window as any).onEqModuleLoaded = () => { startPluginsOnce(); };
    
    return Promise.resolve("");
}

// GET Request to https://evilquest.net/play
const response = await fetch('https://evilquest.net/play');
const text = await response.text();

const parser = new DOMParser();
const doc = parser.parseFromString(text, 'text/html');
const clientJS = doc.querySelector('script[src*="/js/client/client"]');
if (clientJS) {
    clientJS.remove();
}

// Replace head and body content (non-script)
Array.from(doc.head.children).forEach(child => {
    if (child.tagName.toLowerCase() !== 'script') {
        // If child has a relative href, update it to absolute
        if (child.hasAttribute('href')) {
            const href = child.getAttribute('href');
            if (href && href.startsWith('/assets/')) {
                child.setAttribute('href', href.replace('/assets/', 'https://evilquest.net/assets/'));
            } else if (href && href.startsWith('/')) {
                child.setAttribute('href', 'https://evilquest.net' + href);
            }
        }
        document.head.appendChild(child.cloneNode(true));
    }
});

const gameWrapper = document.getElementById('game-wrapper');

Array.from(doc.body.children).forEach(child => {
    if (child.tagName.toLowerCase() !== 'script') {
        // If child has a relative href, update it to absolute
        if (child.hasAttribute('href')) {
            const href = child.getAttribute('href');
            if (href && href.startsWith('/assets/')) {
                child.setAttribute('href', href.replace('/assets/', 'https://evilquest.net/assets/'));
            } else if (href && href.startsWith('/')) {
                child.setAttribute('href', 'https://evilquest.net' + href);
            }
        }

        // Append the child
        if (gameWrapper) {
            gameWrapper.appendChild(child.cloneNode(true));
        } else {
            document.body.appendChild(child.cloneNode(true));
        }
    }
});

// Process and inject scripts manually
const scripts = doc.querySelectorAll('script');
console.log(`[EvilLite] Found ${scripts.length} scripts in /play HTML`);
scripts.forEach(script => {
    const newScript = document.createElement('script');
    Array.from(script.attributes).forEach(attr => {
        newScript.setAttribute(attr.name, attr.value);
    });
    newScript.textContent = script.textContent;

    // update script src if relative
    if (newScript.hasAttribute('src')) {
        const src = newScript.getAttribute('src');
        if (src && src.startsWith('/assets/')) {
            newScript.setAttribute('src', src.replace('/assets/', 'https://evilquest.net/assets/'));
        } else if (src && src.startsWith('/')) {
            newScript.setAttribute('src', 'https://evilquest.net' + src);
        }
    }

    // if script was in head, append to head
    if (
        script.parentNode &&
        (script.parentNode as Element).tagName?.toLowerCase() === 'head'
    ) {
        document.head.appendChild(newScript);
    } else {
        // if script was in body, append to body
        if (gameWrapper) {
            gameWrapper.appendChild(newScript);
        } else {
            document.body.appendChild(newScript);
        }
    }
});
console.log('[EvilLite] Script injection complete');

/* Find DOM elements with the attribute to= */
const toElements = document.querySelectorAll('[to]');
toElements.forEach(element => {
    // Skip if it's the titlebar, we want to leave it alone since it's already in the layout
    if (element.classList.contains('highlite_titlebar')) {
        return;
    }
    
    const to = element.getAttribute('to');
    if (!to) return;
    const targetElement = document.querySelector(to);

    // Check if the element has a before or after attribute
    const before = element.getAttribute('before');
    const after = element.getAttribute('after');

    // If before is set, insert the element before the target element
    if (before && !after) {
        const beforeElement = document.querySelector(before);
        if (beforeElement && beforeElement.parentNode) {
            element.remove();
            beforeElement.parentNode.insertBefore(element, beforeElement);
        }
    } else if (after && !before) {
        // If after is set, insert the element after the target element
        const afterElement = document.querySelector(after);
        if (afterElement && afterElement.parentNode) {
            element.remove();
            afterElement.parentNode.insertBefore(
                element,
                afterElement.nextSibling
            );
        }
    } else if (!after && !before) {
        // If neither before nor after is set, append the element to the target element
        // This is the default behavior
        if (targetElement) {
            element.remove();
            targetElement.appendChild(element);
        }
    } else if (after && before) {
        // If both before and after are set, log a warning
        console.warn(
            'Element has both before and after attributes. Peforming default behavior.'
        );
        if (targetElement) {
            element.remove();
            targetElement.appendChild(element);
        }
    }
});

// Inject World Selector into Login Screen
setupWorldSelectorObserver();

// Page Setup Completed, init hooks
await obtainGameClient();

// Page Setup Completed, Add User Helper Script
import('./helpers/userHelper').then(module => {
    module.createUserHelper();
});

if (await window.settings.getByName('Enable Plugins')) {
    let highlite = new Highlite();

    // Load and register all plugins using dynamic imports
    console.log('[EvilLite] Loading plugins...');
    const loadedPlugins: Array<{ class: any; name: string; }> = [];

    try {
        const pluginModules = import.meta.glob('./plugins/*.{js,ts}', { eager: true });

        for (const [path, moduleLoader] of Object.entries(pluginModules)) {
            try {
                const pluginName = path.split('/').pop()?.replace(/\.(js|ts)$/, '') || 'UnknownPlugin';
                // Dynamically import the plugin module
                const PluginClass = (moduleLoader as any).default;

                if (PluginClass) {
                    highlite.pluginManager.registerPlugin(PluginClass);
                    loadedPlugins.push({
                        class: PluginClass,
                        name: pluginName,
                    });
                } else {
                    console.error(`[EvilLite] Plugin class not found in module: ${pluginName}`);
                }
            } catch (error) {
                console.error(`[EvilLite] Failed to load plugin from ${path}:`, error);
            }
        }
    } catch (error) {
        console.error('[EvilLite] Error loading plugins:', error);
    }
    
    (window as any).highliteInstance = highlite;

} else {
    for (const element of document.getElementsByClassName('highlite-ui')) {
        element.remove();
    }
}

window.electron.ipcRenderer.send('ui-ready');
document.dispatchEvent(
    new Event('DOMContentLoaded', {
        bubbles: true,
        cancelable: true,
    })
);

// Fix for mouse click offsets when the side-panel toggles
// The game engine only listens to window resize, so when our client sidebar
// resizes the #game-container, the canvas stretches and coordinates desync.
// This forces the game engine to recalculate its resolution.
const setupGameResizeObserver = () => {
    const observer = new MutationObserver((mutations, obs) => {
        const gameContainer = document.getElementById('game-wrapper');
        if (gameContainer) {
            obs.disconnect(); // Only need to attach once
            const resizeObserver = new ResizeObserver(() => {
                const gm = (window as any).gm;
                if (gm && typeof gm.handleViewportResize === 'function') {
                    gm.handleViewportResize();
                } else if (gm && gm.scene) {
                    gm.scene.getEngine().resize();
                }
            });
            resizeObserver.observe(gameContainer);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
};
setupGameResizeObserver();

// Lightweight on-screen toast for dev-login status (no copy-paste UI needed).
function devToast(msg: string, kind: 'info' | 'ok' | 'err' = 'info') {
    let el = document.getElementById('evillite-dev-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'evillite-dev-toast';
        el.style.cssText = [
            'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
            'padding:10px 14px', 'border-radius:8px', 'font:13px/1.4 system-ui,sans-serif',
            'color:#fff', 'max-width:340px', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
            'pointer-events:none', 'white-space:pre-wrap',
        ].join(';');
        document.body.appendChild(el);
    }
    el.style.background = kind === 'ok' ? '#1e7e34' : kind === 'err' ? '#a02020' : '#222';
    el.textContent = msg;
    el.style.opacity = '1';
}

// PRIMARY login action: open the system browser via OAuth, then drop the returned
// session token into localStorage and reload so the SPA logs in.
async function oauthLogin() {
    devToast('Opening your browser to log in with EvilQuest…');
    try {
        const r: any = await window.electron.ipcRenderer.invoke('oauth:login');
        if (r?.ok && r.token) {
            localStorage.setItem('evilquest_token', r.token);
            localStorage.setItem('evilquest_username', r.username || '');
            localStorage.setItem('evilquest_saved_username', r.username || '');
            devToast('Logged in as ' + (r.username || '?') + ' — loading game…', 'ok');
            document.getElementById('evillite-oauth-authorize')?.remove();
            window.location.reload();
        } else {
            devToast('OAuth login failed: ' + (r?.error || 'unknown error'), 'err');
        }
    } catch (e) {
        devToast('OAuth login error: ' + e, 'err');
    }
}

// Transform the game's own login screen into the OAuth one: hide the native username/
// password fields, remember/tabs/reCAPTCHA, and the submit button (manual login can't
// pass reCAPTCHA from Electron), and reuse the native submit button itself — same menu
// styling — as our "Authorize EvilQuest Login" button.
function setupOAuthLoginScreen() {
    const transform = () => {
        const card = document.querySelector('.eq-login-card');
        if (!card || card.querySelector('#evillite-oauth-authorize')) return;

        // Hide the native login controls.
        card.querySelectorAll('.eq-login-field, .eq-login-remember, .eq-login-tabs, .eq-login-recaptcha-notice, .eq-login-error')
            .forEach((el) => ((el as HTMLElement).style.display = 'none'));

        const submit = card.querySelector('#login-submit') as HTMLElement | null;
        if (submit) {
            // Reuse the native submit button (keeps the exact menu style); clone to strip
            // its form-submit handler, retitle, and wire OAuth.
            const ours = submit.cloneNode(true) as HTMLElement;
            ours.id = 'evillite-oauth-authorize';
            ours.setAttribute('type', 'button');
            ours.textContent = 'Authorize EvilQuest Login';
            (ours as any).disabled = false;
            ours.style.display = '';
            ours.addEventListener('click', (e) => { e.preventDefault(); void oauthLogin(); });
            submit.parentElement?.replaceChild(ours, submit);
        } else {
            // Fallback if the submit button isn't found: a plain styled button.
            const btn = document.createElement('button');
            btn.id = 'evillite-oauth-authorize';
            btn.className = 'eq-login-submit';
            btn.type = 'button';
            btn.textContent = 'Authorize EvilQuest Login';
            btn.onclick = () => void oauthLogin();
            card.appendChild(btn);
        }
    };
    const obs = new MutationObserver(transform);
    obs.observe(document.body, { childList: true, subtree: true });
    transform();
}

// Always watch for the login screen — on first load OR after a logout / AFK kick (which
// shows the login screen client-side, without a reload). When we're silently auto-logged
// in the login screen never appears, so this stays a no-op.
setupOAuthLoginScreen();

// Emergency bypass for 'M' key testing while reCAPTCHA is blocked
window.addEventListener('keydown', (e) => {
    // 0. PRIMARY login: Ctrl+Shift+O — OAuth (system browser, sanctioned path).
    if (e.ctrlKey && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        void oauthLogin();
        return;
    }
    // 1. Session Reset Hotkey: Ctrl+Shift+R
    if (e.ctrlKey && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        console.log('[EvilLite] Triggering reCAPTCHA session reset...');
        window.electron.ipcRenderer.invoke('reset-captcha-session').then(() => {
            window.location.reload();
        });
        return;
    }

    // 2. DEV Browser Login: Ctrl+Shift+L
    //    Pops out real Chrome to log in past reCAPTCHA, captures the session,
    //    injects it back into this client, and reloads — no copy-paste.
    if (e.ctrlKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        devToast('Opening Chrome — log in there. Capturing your session…');
        window.electron.ipcRenderer.invoke('dev-login:start').then((res: any) => {
            if (res?.ok) {
                devToast('Logged in! Captured: ' + (res.captured || []).join(', ') + '\nReloading…', 'ok');
            } else {
                devToast('Dev login failed: ' + (res?.error || 'unknown error'), 'err');
            }
        }).catch((err: any) => devToast('Dev login error: ' + err, 'err'));
        return;
    }
}, { capture: true });

