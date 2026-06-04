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

import type { Plugin } from './interfaces/highlite/plugin/plugin.class';
import { PluginManager } from './managers/highlite/pluginManager';
declare global {
    interface Window {
        [key: string]: any;
    }

    interface Document {
        highlite: {
            managers: {
                [key: string]: any;
            };
            gameHooks: {
                [key: string]: any;
            };
            gameLookups: {
                [key: string]: any;
            };
        };

        client: {
            [key: string]: any;
        };

        game: {
            [key: string]: any;
        };
    }
}