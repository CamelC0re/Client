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

import { SettingsTypes, type PluginSettings } from './pluginSettings.interface';

export abstract class Plugin {
    /** Used for plugin[fnName] access */
    [key: string]: any;

    abstract pluginName: string;
    abstract author: string;

    abstract init(): void;
    abstract start(): void;
    abstract stop(): void;
    settings: {
        enable: PluginSettings;
        [key: string]: PluginSettings;
    } = {
        enable: {
            text: 'Enable',
            type: SettingsTypes.checkbox,
            value: false, // Default to false
            callback: this.onSettingsChanged_enabled,
        },
    };

    data : { [key: string]: any } = {};

    onSettingsChanged_enabled() {
        if (this.settings.enable.value) {
            this.start();
        } else {
            this.stop();
        }
    }

    postInit?(): void;

    get gameHooks() {
        return document.highlite?.gameHooks;
    }

    get gameLookups() {
        return document.highlite?.gameLookups;
    }


    // Log seems to be broken from loading HighSpell Client
    log(...args: any[]): void {
        console.info(`[RyeLite][${this.pluginName} Plugin]`, ...args);
    }

    info(...args: any[]): void {
        console.info(`[RyeLite][${this.pluginName} Plugin]`, ...args);
    }

    warn(...args: any[]): void {
        console.warn(`[RyeLite][${this.pluginName} Plugin]`, ...args);
    }

    error(...args: any[]): void {
        console.error(`[RyeLite][${this.pluginName} Plugin]`, ...args);
    }
}
