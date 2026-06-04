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

import type { DBSchema } from 'idb';
import type { PluginConfig } from '../plugin/PluginConfig.interface';

export interface HighliteSchema extends DBSchema {
    resources: {
        key: string; //resource name
        value: {
            updatedAt: number; //timestamp of last update
            data: string; //base64 encoded data
        };
    };
    plugins: {
        key: string; // Plugin Name
        value: {
            config: PluginConfig;
            blob: Blob;
        };
    };
    settings: {
        key: string; // User Name
        value: Record<string, Record<string, boolean | number | string>>; // Plugin Name -> Setting Name -> Value
    };
    drop_logs: {
        key: number; //NPC defId
        value: {
            defId: number;
            name: string;
            killCount: number;
            drops: {
                [itemId: number]: {
                    name: string;
                    quantity: number;
                    totalDropped: number;
                };
            };
            lastUpdated: number;
        };
    };
    data: {
        key: string; // User Name
        value: {
            [pluginName: string]: any; // Plugin Name -> Data
        }
    }
}
