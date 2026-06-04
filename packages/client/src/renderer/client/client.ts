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

// Fix Vite dynamic imports creating absolute absolute paths resolving to the local filesystem
const originalCreateElement = document.createElement.bind(document);
document.createElement = function(tagName: string) {
    const el = originalCreateElement(tagName) as HTMLElement;
    if (tagName.toLowerCase() === 'link') {
        const originalSetAttribute = el.setAttribute.bind(el);
        el.setAttribute = function(name: string, value: string) {
            if (name === 'href' && value) {
                if (value.startsWith('/assets/')) value = 'eq://evilquest.net' + value;
            }
            return originalSetAttribute(name, value);
        };
        Object.defineProperty(el, 'href', {
            set: function(val) {
                if (typeof val === 'string' && val.startsWith('/assets/')) val = 'eq://evilquest.net' + val;
                originalSetAttribute('href', val);
            },
            get: function() { return el.getAttribute('href'); }
        });
    }
    return el as any;
};

// Patch fetch and XHR for Babylon.js asset loading
const originalFetch = window.fetch;
window.fetch = function(input, init) {
    if (typeof input === 'string') {
        if (input.startsWith('/assets/') || input.startsWith('/data/') || input.startsWith('/maps/') || input.startsWith('/ui/')) {
            input = 'eq://evilquest.net' + input;
        }
    } else if (input instanceof URL) {
        if (input.pathname.startsWith('/assets/') || input.pathname.startsWith('/data/') || input.pathname.startsWith('/maps/')) {
            input = new URL('eq://evilquest.net' + input.pathname + input.search);
        }
    }
    return originalFetch(input, init);
};

const originalXhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
    let urlStr = url instanceof URL ? url.pathname + url.search : url;
    if (urlStr.startsWith('/assets/') || urlStr.startsWith('/data/') || urlStr.startsWith('/maps/') || urlStr.startsWith('/ui/')) {
        urlStr = 'eq://evilquest.net' + urlStr;
    }
    return (originalXhrOpen as any).call(this, method, urlStr, ...args);
};

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

async function obtainGameClient() {
    // For EvilQuest, the game scripts like babylon-core.js and GameManager.js are loaded
    // dynamically. We will need to set up interception for these scripts to apply Reflector hooks.
    console.log('[EvilLite] Preparing game client interception...');
    
    // We will hook into the module loaded event injected by our eq:// protocol interceptor
    (window as any).onEqModuleLoaded = () => {
        if ((window as any).__eqSourceCode) {
            if ((window as any).__eqTimeout) clearTimeout((window as any).__eqTimeout);
            (window as any).__eqTimeout = setTimeout(async () => {
                try {
                    // Reflector parses the concatenated AST of all loaded modules
                    await Reflector.loadHooksFromSource((window as any).__eqSourceCode);
                    
                    // If Core is already started, re-bind the newly discovered hooks
                    if ((document as any).highlite?.managers?.HookManager) {
                        Reflector.bindClassHooks((document as any).highlite.managers.HookManager);
                        Reflector.bindEnumHooks((document as any).highlite.managers.HookManager);
                        
                        // Re-initialize manual hooks since classes are now mapped
                        if ((window as any).highliteInstance) {
                            (window as any).highliteInstance.initialize();
                            if (!(window as any).highliteInstanceStarted) {
                                (window as any).highliteInstanceStarted = true;
                                await (window as any).highliteInstance.start();
                            }
                        }
                    }
                } catch (err) {
                    console.error('[EvilLite] Reflector failed to parse modules:', err);
                }
            }, 500); // debounce by 500ms
        }
    };
    
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
                child.setAttribute('href', href.replace('/assets/', 'eq://evilquest.net/assets/'));
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
                child.setAttribute('href', href.replace('/assets/', 'eq://evilquest.net/assets/'));
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
            newScript.setAttribute('src', src.replace('/assets/', 'eq://evilquest.net/assets/'));
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
        const pluginModules = import.meta.glob('./plugins/*.js', { eager: true });

        for (const [path, moduleLoader] of Object.entries(pluginModules)) {
            try {
                const pluginName = path.split('/').pop()?.replace('.js', '') || 'UnknownPlugin';
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

    // Defer start until game hooks are available
    if ((window as any).__eqSourceCode && Object.keys(document.highlite?.gameHooks || {}).length > 0) {
        highlite.initialize();
        (window as any).highliteInstanceStarted = true;
        await highlite.start();
    }
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

