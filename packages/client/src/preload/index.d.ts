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

import { ElectronAPI } from '@electron-toolkit/preload';
declare global {
    interface Window {
        electron: ElectronAPI;
        settings: {
            get: (section: string, key: string) => Promise<any>;
            set: (section: string, key: string, value: any) => Promise<void>;
            getAll: () => Promise<Record<string, any>>;
            getByName: (label: string) => Promise<any>;
            selectDirectory: (options?: { title?: string; defaultPath?: string }) => Promise<string | null>;
            validateDirectory: (dirPath: string) => Promise<boolean>;
        };
        screenshot: {
            capture: () => Promise<{ ok: boolean; path?: string; error?: string }>;
        }
    }
}
