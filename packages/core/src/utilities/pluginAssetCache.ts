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

// Renderer-side accessor for the main-process plugin asset cache.
//
// Plugins generate expensive assets at runtime (e.g. the World Map renders 3D
// models into icon images) and cache them in a build-committed JSON file per
// namespace, so shipped users load prebaked assets instead of regenerating.
// The actual file I/O lives in the Electron main process (registerPluginAssetCache);
// this is the thin IPC bridge plugins use. Outside Electron (no ipcRenderer) it
// degrades to a no-op / empty cache, so it is safe to call unconditionally.

interface IpcRendererLike {
    invoke(channel: string, ...args: any[]): Promise<any>;
    send(channel: string, ...args: any[]): void;
}

function ipc(): IpcRendererLike | null {
    return (globalThis as any)?.electron?.ipcRenderer ?? null;
}

export class PluginAssetCache {
    constructor(private readonly namespace: string) {}

    /** Load all cached assets for this namespace as a { key: value } map. */
    async load(): Promise<Record<string, string>> {
        try {
            return (await ipc()?.invoke('plugin-asset-cache:load', this.namespace)) ?? {};
        } catch {
            return {};
        }
    }

    /** Persist one asset. Dev-only on the main side; a no-op in packaged builds. */
    save(key: string, value: string): void {
        try {
            ipc()?.send('plugin-asset-cache:save', this.namespace, key, value);
        } catch {
            /* ignore */
        }
    }
}
