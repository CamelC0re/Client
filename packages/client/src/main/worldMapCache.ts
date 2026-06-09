// Copyright (C) 2025  HighLite
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// ─── World Map icon cache (build-compilable) ────────────────────────────────
//
// The World Map plugin renders the game's 3D models to small icon images. That
// generation is expensive, so we cache the results. The cache lives in a JSON file
// in the plugin's source tree:
//
//   src/renderer/client/plugins/data/world-map-icons.json   { "__v": N, "icons": { key: dataURL } }
//
// In DEV, as developers explore and icons generate, we accumulate them into that
// file. It can then be committed and bundled (imported) into the shipped plugin, so
// end users load the prebaked icons instead of regenerating every one — only genuinely
// missing icons (e.g. new game content) are generated at runtime. Writes are dev-only;
// packaged builds treat the bundled cache as read-only.

import { app, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';

const CACHE_VERSION = 1;

interface CacheShape {
    __v: number;
    icons: Record<string, string>;
}

function cacheFile(): string {
    // Dev cwd = packages/client.
    return path.join(process.cwd(), 'src', 'renderer', 'client', 'plugins', 'data', 'world-map-icons.json');
}

let cache: CacheShape | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function load(): CacheShape {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
        cache = raw && raw.__v === CACHE_VERSION && raw.icons ? raw : { __v: CACHE_VERSION, icons: {} };
    } catch {
        cache = { __v: CACHE_VERSION, icons: {} };
    }
    return cache!;
}

function flush(): void {
    if (!cache || !dirty) return;
    dirty = false;
    try {
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        fs.writeFileSync(cacheFile(), JSON.stringify(cache));
        console.log(`[WorldMapCache] wrote ${Object.keys(cache.icons).length} icons → ${cacheFile()}`);
    } catch (e) {
        console.warn('[WorldMapCache] write failed', e);
    }
}

export function registerWorldMapCache(): void {
    // The plugin loads the prebaked cache at startup.
    ipcMain.handle('worldmap:load-icons', () => load().icons);

    // The plugin reports each freshly generated icon; we accumulate them (dev only).
    ipcMain.on('worldmap:save-icon', (_e, key: string, dataUrl: string) => {
        if (app.isPackaged) return; // bundled cache is read-only in shipped builds
        if (typeof key !== 'string' || typeof dataUrl !== 'string' || dataUrl.length < 100) return;
        const c = load();
        if (c.icons[key] === dataUrl) return;
        c.icons[key] = dataUrl;
        dirty = true;
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = setTimeout(flush, 1500);
    });

    app.on('will-quit', flush);
}
