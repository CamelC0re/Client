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

import type { Plugin } from '../../interfaces/highlite/plugin/plugin.class';
import type { PluginConfig } from '../../interfaces/highlite/plugin/PluginConfig.interface';
import { PanelManager } from './panelManager';
import { DatabaseManager } from './databaseManager';
import { SettingsManager } from './settingsManager';

// Highlite mirror endpoints
const HIGHLITE_MANIFEST_URL = 'https://www.ryelite.org/api/plugins/manifest.json';
const HIGHLITE_MIRROR_BASE = 'https://www.ryelite.org/api/plugins';

export interface ManagedPlugin {
    config: PluginConfig | undefined;
    class: (new () => Plugin) | undefined;
    instance: Plugin | undefined;
    blob?: Blob | undefined;
    url?: string | undefined; // object URL for imported blob
    installedConfig?: PluginConfig | undefined; // stored config of installed version
}

export class PluginManager {
    private static instance: PluginManager;
    private panelManager: PanelManager = new PanelManager();
    private databaseManager: DatabaseManager = new DatabaseManager();
    private settingsManager: SettingsManager = new SettingsManager();
    private panelContent!: HTMLDivElement;
    private listContainer!: HTMLDivElement;
    private searchInput!: HTMLInputElement;
    private currentFilter: string = '';
    private didInitialSync = false;
    private managedPlugins: ManagedPlugin[] = [];
    private isLoggedIn: boolean = false;

    public get plugins(): ManagedPlugin[] {
        return this.managedPlugins;
    }


    public setLoginState(isLoggedIn: boolean) {
        this.isLoggedIn = isLoggedIn;
    };

    constructor() {
        if (PluginManager.instance) return PluginManager.instance;
        if (document.highlite.managers.PluginManager) {
            PluginManager.instance = document.highlite.managers.PluginManager;
            return document.highlite.managers.PluginManager;
        }
        PluginManager.instance = this;
        document.highlite.managers.PluginManager = this;
    }

    async initialize() {
        this.panelContent = this.panelManager.requestMenuItem('🗃️', 'Plugin Hub')[1] as HTMLDivElement;
        this.panelContent.style.display = 'flex';
        this.panelContent.style.flexDirection = 'column';
        this.panelContent.style.padding = '8px';
        this.panelContent.style.gap = '8px';
        this.panelContent.style.background = 'var(--theme-background)';
        this.panelContent.style.overflowY = 'auto';
        this.panelContent.style.overflowX = 'hidden';
        this.panelContent.style.width = '-webkit-fill-available';

        // Toolbar with search
        const toolbar = document.createElement('div');
        toolbar.style.display = 'flex';
        toolbar.style.alignItems = 'center';
        toolbar.style.gap = '8px';
        toolbar.style.position = 'sticky';
        toolbar.style.top = '0';
        toolbar.style.background = 'var(--theme-background)';
        toolbar.style.zIndex = '1';
        toolbar.style.padding = '4px 0';

        const searchWrapper = document.createElement('div');
        searchWrapper.style.flex = '1';
        searchWrapper.style.width = '-webkit-fill-available';
        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.placeholder = 'Search plugins by name…';
        this.searchInput.style.width = '100%';
        this.searchInput.style.padding = '8px 12px';
        this.searchInput.style.border = '1px solid var(--theme-border)';
        this.searchInput.style.borderRadius = '6px';
        this.searchInput.style.background = 'var(--theme-background-mute)';
        this.searchInput.style.color = 'var(--theme-text-primary)';
        this.searchInput.style.width = '-webkit-fill-available';
        this.searchInput.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        this.searchInput.style.fontSize = '14px';
        this.searchInput.addEventListener('input', () => {
            this.currentFilter = this.searchInput.value.trim().toLowerCase();
            // Re-render list only (avoid re-sync)
            this.populatePluginHub();
        });
        searchWrapper.appendChild(this.searchInput);
        toolbar.appendChild(searchWrapper);

        // Container for plugin cards
        this.listContainer = document.createElement('div');
        this.listContainer.style.display = 'flex';
        this.listContainer.style.flexDirection = 'column';
        this.listContainer.style.gap = '8px';

        this.panelContent.appendChild(toolbar);
        this.panelContent.appendChild(this.listContainer);

        const pluginConfigs = await this.obtainPluginConfigs();
        for (const pluginConfig of pluginConfigs) {
            const managedPlugin: ManagedPlugin = {
                config: pluginConfig,
                class: undefined,
                instance: undefined,
            };
            this.managedPlugins.push(managedPlugin);
        }
        await this.populatePluginHub();
    }

    private async obtainPluginConfigs(): Promise<PluginConfig[]> {
        const pluginConfigs: PluginConfig[] = [];
        try {
            const res = await fetch(HIGHLITE_MANIFEST_URL, { cache: 'no-cache' });
            if (!res.ok) throw new Error(`Manifest request failed: ${res.status}`);
            const manifest = await res.json();
            for (const configuration of manifest) pluginConfigs.push(configuration as PluginConfig);
        } catch (e) {
            console.error('[Highlite] Failed to fetch plugin configs from mirror', e);
        }
        return pluginConfigs;
    }

    private async populatePluginHub() {
        // Clear only the list content; keep toolbar/search
        this.listContainer.innerHTML = '';

        // Filter to those with configs (renderable in hub)
        const withConfig = this.managedPlugins.filter((p) => p.config);
        if (withConfig.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.textContent = 'No plugins available.';
            emptyMessage.style.textAlign = 'center';
            emptyMessage.style.color = 'var(--theme-text-muted)';
            emptyMessage.style.fontStyle = 'italic';
            emptyMessage.style.padding = '40px 20px';
            emptyMessage.style.background = 'var(--theme-background-soft)';
            emptyMessage.style.border = '1px solid var(--theme-border)';
            emptyMessage.style.borderRadius = '8px';
            emptyMessage.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            this.listContainer.appendChild(emptyMessage);
            return;
        }

        const filter = this.currentFilter;
        const filtered = withConfig.filter((p) => {
            const name = (p!.config!.display_name ?? p!.config!.repository_name ?? '').toLowerCase();
            return !filter || name.includes(filter);
        });

        // Default alphabetical sort (case-insensitive) by plugin display/repo name
        const sorted = filtered.sort((a, b) => {
            const an = (a!.config!.display_name ?? a!.config!.repository_name ?? '').toString();
            const bn = (b!.config!.display_name ?? b!.config!.repository_name ?? '').toString();
            return an.localeCompare(bn, undefined, { sensitivity: 'base' });
        });

        if (sorted.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.textContent = 'No matching plugins.';
            emptyMessage.style.textAlign = 'center';
            emptyMessage.style.color = 'var(--theme-text-muted)';
            emptyMessage.style.fontStyle = 'italic';
            emptyMessage.style.padding = '40px 20px';
            emptyMessage.style.background = 'var(--theme-background-soft)';
            emptyMessage.style.border = '1px solid var(--theme-border)';
            emptyMessage.style.borderRadius = '8px';
            emptyMessage.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            this.listContainer.appendChild(emptyMessage);
            return;
        }

        for (const plugin of sorted) {
            if (!plugin.config) continue;
            const card = document.createElement('div');
            card.style.border = '1px solid var(--theme-border)';
            card.style.borderRadius = '8px';
            card.style.padding = '16px';
            card.style.marginBottom = '8px';
            card.style.background = 'var(--theme-background-mute)';
            card.style.color = 'var(--theme-text-primary)';
            card.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.3)';
            card.style.transition = 'all 0.2s ease';

            const title = document.createElement('h3');
            title.textContent = plugin.config.display_name ?? plugin.config.repository_name;
            title.style.margin = '0 0 4px 0';
            title.style.fontSize = '16px';
            title.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            title.style.fontWeight = '600';
            title.style.color = 'var(--theme-text-primary)';

            const author = document.createElement('p');
            author.textContent = `By ${plugin.config.display_author ?? plugin.config.repository_owner}`;
            author.style.margin = '0 0 8px 0';
            author.style.fontStyle = 'italic';
            author.style.fontSize = '12px';
            author.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            author.style.fontWeight = '400';
            author.style.color = 'var(--theme-text-muted)';

            const description = document.createElement('p');
            description.textContent = plugin.config.display_description ?? 'No description provided.';
            description.style.margin = '0 0 12px 0';
            description.style.fontSize = '14px';
            description.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            description.style.fontWeight = '400';
            description.style.color = 'var(--theme-text-secondary)';

            // Version line (shortened sha)
            const version = document.createElement('p');
            version.textContent = `Version: ${this.shortSha(plugin.config.asset_sha)}`;
            version.style.margin = '0 0 12px 0';
            version.style.fontSize = '12px';
            version.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
            version.style.fontWeight = '500';
            version.style.color = 'var(--theme-text-muted)';

            const installBtn = document.createElement('button');
            installBtn.textContent = 'Install';
            this.stylePrimaryButton(installBtn);
            // Disable if DB not ready yet
            if (!this.databaseManager.database) {
                installBtn.disabled = true;
                installBtn.title = 'Database not initialized yet';
            }

            const uninstallButton = document.createElement('button');
            uninstallButton.textContent = 'Uninstall';
            this.styleDangerButton(uninstallButton);

            const updateButton = document.createElement('button');
            updateButton.textContent = 'Update';
            this.styleSuccessButton(updateButton);
            updateButton.style.display = 'none';

            const githubButton = document.createElement('button');
            githubButton.textContent = 'View on GitHub';
            this.styleSecondaryButton(githubButton);
            githubButton.onclick = () => {
                const url = `https://github.com/${plugin.config!.repository_owner}/${plugin.config!.repository_name}`;
                window.open(url, '_blank');
            };

            installBtn.onclick = async () => {
                installBtn.disabled = true;
                try {
                    if (!plugin.config) return;
                    const matchingAssetUrl = await this.downloadAndVerifyAsset(plugin.config);
                    if (!matchingAssetUrl) throw new Error(`No asset matched SHA: ${plugin.config.asset_sha}`);
                    const pluginModule = await import(/* @vite-ignore */ matchingAssetUrl);
                    const PluginClass = pluginModule.default;
                    if (typeof PluginClass !== 'function') throw new Error('Default export is not a valid plugin class');

                    // Associate the class to this managedPlugin before registering to avoid duplicates
                    plugin.class = PluginClass;
                    this.registerPlugin(PluginClass);

                    // Persist
                    await this.databaseManager.database?.put(
                        'plugins',
                        {
                            config: plugin.config,
                            blob: plugin.blob!,
                        },
                        plugin.config.display_name ?? plugin.config.repository_name
                    );

                    await this.settingsManager.refresh();
                    uninstallButton.disabled = false;
                    // mark installed version in-memory
                    plugin.installedConfig = plugin.config;
                    if (actionsRow.contains(installBtn)) actionsRow.removeChild(installBtn);
                    // After install, no update button is needed (we just installed latest)
                    updateButton.style.display = 'none';
                    actionsRow.appendChild(uninstallButton);
                } catch (error) {
                    console.error(`[Highlite] Failed to install plugin:`, error);
                    installBtn.textContent = 'Failed';
                    installBtn.classList.add('error');
                } finally {
                    installBtn.disabled = false;
                }
            };

            uninstallButton.onclick = async () => {
                try {
                    if (!plugin.config) return;
                    await this.databaseManager.database?.delete(
                        'plugins',
                        plugin.config.display_name ?? plugin.config.repository_name
                    );
                    if (plugin.class) {
                        const installedPlugin = this.findPluginByClass(plugin.class);
                        if (installedPlugin) {
                            this.unregisterPlugin(installedPlugin);
                        }
                    }
                    if (plugin.url) {
                        URL.revokeObjectURL(plugin.url);
                        plugin.url = undefined;
                    }
                    plugin.blob = undefined;
                    plugin.installedConfig = undefined;
                    await this.settingsManager.refresh();
                    installBtn.disabled = false;
                    if (actionsRow.contains(uninstallButton)) actionsRow.removeChild(uninstallButton);
                    updateButton.style.display = 'none';
                    actionsRow.appendChild(installBtn);
                } catch (error) {
                    console.error(`[Highlite] Failed to uninstall plugin:`, error);
                    uninstallButton.textContent = 'Failed';
                }
            };

            updateButton.onclick = async () => {
                updateButton.disabled = true;
                try {
                    if (!plugin.config) return;
                    const matchingAssetUrl = await this.downloadAndVerifyAsset(plugin.config);
                    if (!matchingAssetUrl) throw new Error(`No asset matched SHA: ${plugin.config.asset_sha}`);
                    const pluginModule = await import(/* @vite-ignore */ matchingAssetUrl);
                    const PluginClass = pluginModule.default;
                    if (typeof PluginClass !== 'function') throw new Error('Default export is not a valid plugin class');

                    // Stop/unregister current instance if present
                    if (plugin.instance) {
                        this.unregisterPlugin(plugin.instance);
                    }
                    plugin.class = PluginClass;
                    this.registerPlugin(PluginClass);
                    // Persist new version
                    await this.databaseManager.database?.put(
                        'plugins',
                        {
                            config: plugin.config,
                            blob: plugin.blob!,
                        },
                        plugin.config.display_name ?? plugin.config.repository_name
                    );
                    // Update UI state
                    plugin.installedConfig = plugin.config;
                    version.textContent = `Version: ${this.shortSha(plugin.config.asset_sha)}`;
                    updateButton.style.display = 'none';
                    await this.settingsManager.refresh();
                } catch (error) {
                    console.error(`[Highlite] Failed to update plugin:`, error);
                    updateButton.textContent = 'Failed';
                } finally {
                    updateButton.disabled = false;
                }
            };

            card.appendChild(title);
            card.appendChild(author);
            card.appendChild(description);
            card.appendChild(version);
            const actionsRow = document.createElement('div');
            actionsRow.style.display = 'flex';
            actionsRow.style.gap = '8px';
            actionsRow.style.flexWrap = 'wrap';
            actionsRow.appendChild(githubButton);
            // On first render, sync with DB; afterwards rely on cached state
            const isInstalled = this.didInitialSync ? plugin.blob : await this.syncPluginState(plugin.config);
            if (isInstalled) {
                plugin.blob = isInstalled;
                // Show uninstall; and show update if installed sha differs from latest
                actionsRow.appendChild(uninstallButton);
                const upToDate = plugin.installedConfig && plugin.installedConfig.asset_sha.toLowerCase() === plugin.config.asset_sha.toLowerCase();
                updateButton.style.display = upToDate ? 'none' : 'inline-flex';
                if (!upToDate) actionsRow.appendChild(updateButton);
            } else {
                actionsRow.appendChild(installBtn);
            }
            card.appendChild(actionsRow);
            this.listContainer.appendChild(card);
        }
        this.didInitialSync = true;
    }

    private async syncPluginState(plugin: PluginConfig): Promise<Blob | undefined> {
        if (!this.databaseManager.database) return undefined; // DB guard
        const installedPlugin = await this.databaseManager.database.get(
            'plugins',
            plugin.display_name ?? plugin.repository_name
        );
        if (installedPlugin) {
            const blob = installedPlugin.blob as Blob;
            const url = URL.createObjectURL(blob);
            try {
                const pluginModule = await import(url);
                const pluginClass = pluginModule.default;
                // Associate to managed plugin by name
                const managed = this.managedPlugins.find((mp) => (mp.config?.display_name ?? mp.config?.repository_name) === (plugin.display_name ?? plugin.repository_name));
                if (managed) {
                    managed.class = pluginClass;
                    managed.blob = blob;
                    managed.url = url;
                    managed.installedConfig = installedPlugin.config;
                }
                this.registerPlugin(pluginClass);
            } catch (e) {
                console.error('[Highlite] Failed to load installed plugin', e);
                URL.revokeObjectURL(url);
                return undefined;
            }
            return blob;
        }
        return undefined;
    }

    private shortSha(sha: string, length: number = 8): string {
        const val = sha ?? '';
        const clean = val.includes(':') ? val.split(':').pop() as string : val;
        return clean.slice(0, Math.max(1, length));
    }

    private async downloadAndVerifyAsset(config: PluginConfig): Promise<string | null> {
        // If DB is not ready, fail fast
        if (!this.databaseManager.database) throw new Error('Database not initialized');

        // Download exclusively from Highlite mirror and verify against manifest sha
        const mirrorUrl = `${HIGHLITE_MIRROR_BASE}/${config.repository_owner}/${config.display_name ?? config.repository_name}/`;
        const resp = await fetch(mirrorUrl, { headers: { Accept: 'application/octet-stream' }, cache: 'no-cache' });
        if (!resp.ok) throw new Error(`Mirror download failed (${resp.status})`);
        const buffer = await resp.arrayBuffer();
        if (config.asset_sha) {
            const hex = "sha256:" + await this.sha256Hex(buffer);
            const expected = (config.asset_sha ?? '').toLowerCase();
            if (hex !== expected) throw new Error(`[Highlite] Mirror asset sha mismatch for ${config.repository_name}. expected=${expected} actual=${hex}`);
        }
        const blob = new Blob([buffer], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const managed = this.managedPlugins.find((mp) => (mp.config?.display_name ?? mp.config?.repository_name) === (config.display_name ?? config.repository_name));
        if (managed) {
            managed.blob = blob;
            managed.url = url;
        }
        return url;
    }

    private async sha256Hex(buffer: ArrayBuffer): Promise<string> {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const bytes = new Uint8Array(digest);
        let hex = '';
        for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return hex;
    }

    private stylePrimaryButton(btn: HTMLButtonElement) {
        btn.style.padding = '8px 16px';
        btn.style.background = 'var(--theme-accent)';
        btn.style.color = 'var(--theme-text-dark)';
        btn.style.border = '1px solid var(--theme-accent-dark)';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '14px';
        btn.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        btn.style.fontWeight = '500';
        btn.style.transition = 'all 0.2s ease';
    }

    private styleDangerButton(btn: HTMLButtonElement) {
        btn.style.padding = '8px 16px';
        btn.style.background = 'var(--theme-danger)';
        btn.style.color = 'white';
        btn.style.border = '1px solid var(--theme-danger-dark)';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '14px';
        btn.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        btn.style.fontWeight = '500';
        btn.style.transition = 'all 0.2s ease';
    }

    private styleSecondaryButton(btn: HTMLButtonElement) {
        btn.style.padding = '8px 16px';
        btn.style.background = 'var(--theme-background-mute)';
        btn.style.color = 'var(--theme-text-primary)';
        btn.style.border = '1px solid var(--theme-border)';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '14px';
        btn.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        btn.style.fontWeight = '500';
        btn.style.transition = 'all 0.2s ease';
    }

    private styleSuccessButton(btn: HTMLButtonElement) {
        btn.style.padding = '8px 16px';
        btn.style.background = 'var(--theme-accent)';
        btn.style.color = 'var(--theme-text-dark)';
        btn.style.border = '1px solid var(--theme-accent-dark)';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '14px';
        btn.style.fontFamily = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        btn.style.fontWeight = '500';
        btn.style.transition = 'all 0.2s ease';
    }

    registerPlugin<T extends Plugin>(pluginClass: new () => T): boolean {
        const pluginInstance = new pluginClass();
        console.info(`[Highlite] New plugin ${pluginInstance.pluginName} registered`);
        // Find or create managed entry by class
        let managedPlugin = this.managedPlugins.find((mp) => mp.class === pluginClass);
        if (!managedPlugin) {
            managedPlugin = { config: undefined, class: pluginClass, instance: pluginInstance };
            this.managedPlugins.push(managedPlugin);
        } else {
            managedPlugin.class = pluginClass;
            managedPlugin.instance = pluginInstance;
        }


        // Check if we are logged in
        if (this.isLoggedIn) {
            if (pluginInstance.init) {
                pluginInstance.init();
            }

            if (pluginInstance.postInit) {
                pluginInstance.postInit();
            }

            if (pluginInstance.start) {
                pluginInstance.start();
            }
        }

        return true;
    }

    initAll(): void {
        for (const plugin of this.plugins) {
            try {
                plugin.instance?.init();
            } catch (error) {
                console.error(`[Highlite] Error initializing plugin ${plugin.instance?.pluginName}:`, error);
            }
        }
    }

    postInitAll(): void {
        for (const plugin of this.plugins) {
            try {
                if (plugin.instance?.postInit) plugin.instance.postInit();
            } catch (error) {
                console.error(`[Highlite] Error post-initializing plugin ${plugin.instance?.pluginName}:`, error);
            }
        }
    }

    startAll(): void {
        for (const plugin of this.plugins) {
            if (plugin.instance?.settings.enable.value) {
                try {
                    plugin.instance?.start();
                } catch (error) {
                    console.error(`[Highlite] Error starting plugin ${plugin.instance?.pluginName}:`, error);
                }
            }
        }
    }

    stopAll(): void {
        for (const plugin of this.plugins) {
            if (plugin.instance?.settings.enable.value) {
                try {
                    plugin.instance?.stop();
                } catch (error) {
                    console.error(`[Highlite] Error stopping plugin ${plugin.instance?.pluginName}:`, error);
                }
            }
        }
    }

    findPluginByName(pluginName: string): Plugin | undefined {
        return this.plugins.find((managedPlugin) => managedPlugin.instance?.pluginName === pluginName)?.instance;
    }

    findPluginByClass(pluginClass: new () => Plugin): Plugin | undefined {
        return this.plugins.find((managedPlugin) => managedPlugin.class && managedPlugin.instance && managedPlugin.instance.constructor === pluginClass)?.instance;
    }

    unregisterPlugin(plugin: Plugin): boolean {
        try {
            if (plugin.settings.enable.value) {
                plugin.stop();
            }

            const index = this.managedPlugins.findIndex((mp) => mp.instance === plugin);
            if (index !== -1) {
                this.managedPlugins[index].instance = undefined;
                this.managedPlugins[index].class = undefined;
            }
            return true;
        } catch (error) {
            console.error(`[Highlite] Error unregistering plugin ${plugin.pluginName}:`, error);
            return false;
        }
    }
}
