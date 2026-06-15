/*! 

Copyright (C) 2025  HighLite

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

*/

import { ContextMenuManager } from './managers/game/contextMenuManager';
import { HookManager } from './managers/highlite/hookManager';
import { NotificationManager } from './managers/highlite/notificationManager';
import { PanelManager } from './managers/highlite/panelManager';
import { PluginManager } from './managers/highlite/pluginManager';
import { PluginDataManager } from "./managers/highlite/pluginDataManager";
import { UIManager } from './managers/highlite/uiManager';
import { SettingsManager } from './managers/highlite/settingsManager';
import { DatabaseManager } from './managers/highlite/databaseManager';
import { SoundManager } from './managers/highlite/soundsManager';
import { Reflector } from './reflector/reflector';

export class Highlite {
    hookManager: HookManager;
    contextMenuManager: ContextMenuManager;
    notificationManager: NotificationManager;
    pluginManager: PluginManager;
    uiManager: UIManager;
    panelManager: PanelManager;
    settingsManager: SettingsManager;
    databaseManager: DatabaseManager;
    soundManager: SoundManager;
    pluginDataManager: PluginDataManager;

    constructor() {
        console.info('[Ryelite] Core Initializing!');

        document.highlite = {
            managers: {},
            gameHooks: {},
            gameLookups: {}
        };

        this.pluginManager = new PluginManager();
        this.hookManager = new HookManager();

        this.contextMenuManager = new ContextMenuManager();
        this.notificationManager = new NotificationManager();

        this.uiManager = new UIManager();
        this.panelManager = new PanelManager();
        this.soundManager = new SoundManager();
        this.settingsManager = new SettingsManager();
        this.databaseManager = new DatabaseManager();
        this.pluginDataManager = new PluginDataManager();

        // Register the core sidebar icons (Plugin Hub, Settings) at page load so the sidebar
        // is populated on the main menu / logged out, and these sit before plugin icons.
        // Their content is still built later (Hub in start(), Settings on login). Guarded so
        // the login-time init reuses these instead of re-registering.
        try {
            this.pluginManager.ensureHubIcon();
            this.settingsManager.ensureSettingsIcon();
        } catch (e) { console.warn('[EvilLite] early sidebar icon registration failed', e); }
    }


    // NOTE: The login screen buttons attempt to open up in the ryelite window without these.
    async loginHooks(fnName: string, ...args: any[]) {
        if (fnName === 'LoginScreen_handleRegisterButtonClicked') {
            window.open('https://highspell.com/register', '_blank');
        }
        if (fnName === 'LoginScreen_handleHomeButtonClicked') {
            window.open('https://highspell.com/', '_blank');
        }
    }

    // NOTE: This is used to delay plugin-starting until after the login is complete.
    // This is because we want to associate user-settings with the user account.
    async startHook(fnName: string, ...args: any[]) {
        await this.settingsManager.init();
        await this.settingsManager.registerPlugins();
        await this.pluginDataManager.initialize();
        for (const plugin of this.pluginManager.plugins) {
            if (plugin.instance) {
                await this.pluginDataManager.addPlugin(plugin.instance);
            }
        }
        this.pluginManager.initAll();
        this.pluginManager.postInitAll();
        this.pluginManager.startAll();
        this.pluginManager.setLoginState(true);
    }

    async stopHook(fnName: string, ...args: any[]) {
        console.warn(`[Ryelite] Stopping all plugins due to: ${fnName}`);
        this.panelManager.forceClose();
        this.settingsManager.deinit();
        this.pluginManager.stopAll();
        this.pluginManager.setLoginState(false);
    }

    initialize() {
        console.info("[Ryelite] Core Initializing")

        // Bind the classes from the hook manager (registerClass)
        // Read all the found signature binding 
        Reflector.bindClassHooks(this.hookManager);

        // Bind the enums to the hook manager (registerEnum)
        // These are the lookup tables
        Reflector.bindEnumHooks(this.hookManager);

        // Function Hook-ins
        this.hookManager.registerClassOverrideHook('LoginScreen', '_handleRegisterButtonClicked', this.loginHooks);
        this.hookManager.registerClassOverrideHook('LoginScreen', '_handleHomeButtonClicked', this.loginHooks);

        // Start Plugins and Settings after Login
        this.hookManager.registerClassHook('SocketManager', '_loggedIn', this.startHook.bind(this));

        // Stop Plugins and Settings during logout events
        this.hookManager.registerClassHook('SocketManager', '_handleLostConnection', this.stopHook.bind(this));
        this.hookManager.registerClassHook('SocketManager', '_handleReconnectFailed', this.stopHook.bind(this));
        this.hookManager.registerClassHook('SocketManager', '_handleConnectFailed', this.stopHook.bind(this));
        this.hookManager.registerClassHook('SocketManager', '_handleLoggedOut', this.stopHook.bind(this));
        this.hookManager.registerClassHook('SocketManager', '_loginFailed', this.stopHook.bind(this));

        // TODO: Find a better way to handle manager hook-ins
        this.contextMenuManager.registerContextHook('ContextMenuItemManager','_createInventoryItemContextMenuItems', this.contextMenuManager.inventoryContextHook);
        this.contextMenuManager.registerContextHook('ContextMenuItemManager','_createGameWorldContextMenuItems', this.contextMenuManager.gameWorldContextHook);
        this.hookManager.registerStaticClassHook('TargetActionManager', 'handleTargetAction');
        this.hookManager.registerStaticClassHook('TargetActionManager','getActionsAndEntitiesAtMousePointer',this.contextMenuManager.ActionSorting);


    // Plugin Hub UI will be initialized after DB is ready in start()
    }

    async start() {
        console.info('[Ryelite] Core Started!');
        await this.databaseManager.initDB();
        if (!this.databaseManager.database) {
            console.error('[Ryelite] Database not initialized!');
            return;
        } else {
            console.info('[Ryelite] Database initialized!');
        }
        await this.notificationManager.askNotificationPermission();
    // Initialize Plugin Hub now that DB is ready
    await this.pluginManager.initialize();
    }

    stop() {
        console.info('[Ryelite] Core Stopped!');
        this.pluginManager.stopAll();
    }

    reload() {
        console.info('[Ryelite] Core Reloading');
        this.stop();
        this.start();
    }
}
