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

/* Export all modules */

// Core modules
export * from './globals';

// Core interface
export * from './core';

// Game interfaces and enums
export * from './interfaces/game/ActionStates.enum';
export * from './interfaces/game/ContextMenuTypes.enum';

// Highlite interfaces
export * from './interfaces/highlite/database/database.schema';
export * from './interfaces/highlite/plugin/plugin.class';
export * from './interfaces/highlite/plugin/pluginSettings.interface';
export * from './interfaces/highlite/plugin/TooltipConfig.interface';
export * from './interfaces/highlite/plugin/PluginConfig.interface';

// Game managers
export * from './managers/game/contextMenuManager';

// Highlite managers
export * from './managers/highlite/databaseManager';
export * from './managers/highlite/hookManager';
export * from './managers/highlite/itemTooltip';
export * from './managers/highlite/notificationManager';
export * from './managers/highlite/panelManager';
export * from './managers/highlite/pluginManager';
export * from './managers/highlite/settingsManager';
export * from './managers/highlite/soundsManager';
export * from './managers/highlite/uiManager';

// Reflector
export * from './reflector/reflector';
export * from './reflector/signatures';
export * from './reflector/types';

// Utilities
export * from './utilities/abbreviateValue';
export * from './utilities/lookupUtils';
export * from './utilities/resources';
