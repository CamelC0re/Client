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

import { Plugin } from "../../interfaces/highlite/plugin/plugin.class";
import { DatabaseManager } from "./databaseManager";
import onChange from 'on-change';
export class PluginDataManager {
    private static instance: PluginDataManager;
    private databaseManager!: DatabaseManager;
    private username!: string;

    private inMemoryCache: Record<string, any> = {};
    private writeTimeout: ReturnType<typeof setTimeout> | null = null;
    private initialized = false;

    constructor() {
        if (PluginDataManager.instance) {
            return PluginDataManager.instance;
        }

        if (document.highlite.managers.PluginDataManager) {
            PluginDataManager.instance = document.highlite.managers.PluginDataManager;
            return document.highlite.managers.PluginDataManager;
        }

        PluginDataManager.instance = this;
        document.highlite.managers.PluginDataManager = this;
    }

    public async initialize() {
        this.databaseManager = new DatabaseManager();
        this.username = document.highlite.gameHooks.EntityManager.Instance._mainPlayer._nameLowerCase;

        const data = await this.databaseManager.database.get('data', this.username);
        this.inMemoryCache = data || {};
        this.initialized = true;
    }

    public async addPlugin(plugin: Plugin) {
        if (!this.initialized) {
            throw new Error("PluginDataManager must be initialized before adding plugins");
        }

        const savedData = this.inMemoryCache[plugin.pluginName] ?? {};
        const clonedData = structuredClone(savedData); // Ensure it's not a reference to in-memory cache

        const reactiveData = onChange(clonedData, () => {
            this.scheduleWrite(plugin.pluginName, reactiveData);
        });

        plugin.data = reactiveData;
    }

    private scheduleWrite(pluginName: string, data: any) {
        this.inMemoryCache[pluginName] = structuredClone(onChange.target(data));

        if (this.writeTimeout) {
            clearTimeout(this.writeTimeout);
        }

        this.writeTimeout = setTimeout(async () => {
            try {
                await this.databaseManager.database.put("data", this.inMemoryCache, this.username);
            } catch (err) {
                console.error("Failed to save plugin data", err);
            } finally {
                this.writeTimeout = null;
            }
        }, 200);
    }

}
