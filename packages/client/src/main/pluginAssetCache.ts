// Copyright (C) 2025  HighLite
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// ─── Plugin asset cache (generic, build-compilable) ─────────────────────────
//
// Plugins generate expensive assets at runtime (e.g. the World Map renders the
// game's 3D models into small icon images). Generating them is slow, so we cache
// the results in a per-namespace JSON file in the plugin data tree:
//
//   src/renderer/client/plugins/data/<namespace>.json   { "__v": N, "entries": { key: value } }
//
// In DEV, as assets are generated they accumulate into that file. It can then be
// committed and bundled, so end users load the prebaked assets instead of
// regenerating every one — only genuinely missing assets (e.g. new game content)
// are generated at runtime. Writes are dev-only; packaged builds treat the bundled
// cache as read-only.
//
// This replaces the former map-specific worldMapCache: it is namespaced, so any
// plugin can use it (the World Map uses namespace 'world-map-icons').

import { app, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';

const CACHE_VERSION = 1;

interface CacheShape {
    __v: number;
    entries: Record<string, string>;
}

function cacheFile(namespace: string): string {
    // Dev cwd = packages/client. Sanitise so a namespace can't escape the dir.
    const safe = namespace.replace(/[^a-z0-9_-]/gi, '_');
    return path.join(process.cwd(), 'src', 'renderer', 'client', 'plugins', 'data', `${safe}.json`);
}

const caches = new Map<string, CacheShape>();
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const dirty = new Set<string>();

function load(namespace: string): CacheShape {
    const existing = caches.get(namespace);
    if (existing) return existing;
    let c: CacheShape;
    try {
        const raw = JSON.parse(fs.readFileSync(cacheFile(namespace), 'utf8'));
        // Back-compat: the original world-map cache stored the map under `icons`.
        const entries = raw && (raw.entries ?? raw.icons);
        c = raw && raw.__v === CACHE_VERSION && entries ? { __v: CACHE_VERSION, entries } : { __v: CACHE_VERSION, entries: {} };
    } catch {
        c = { __v: CACHE_VERSION, entries: {} };
    }
    caches.set(namespace, c);
    return c;
}

function flush(namespace: string): void {
    const c = caches.get(namespace);
    if (!c || !dirty.has(namespace)) return;
    dirty.delete(namespace);
    try {
        fs.mkdirSync(path.dirname(cacheFile(namespace)), { recursive: true });
        fs.writeFileSync(cacheFile(namespace), JSON.stringify(c));
        console.log(`[PluginAssetCache] wrote ${Object.keys(c.entries).length} entries → ${cacheFile(namespace)}`);
    } catch (e) {
        console.warn('[PluginAssetCache] write failed', e);
    }
}

export function registerPluginAssetCache(): void {
    // A plugin loads its prebaked cache at startup.
    ipcMain.handle('plugin-asset-cache:load', (_e, namespace: string) => {
        if (typeof namespace !== 'string' || !namespace) return {};
        return load(namespace).entries;
    });

    // A plugin reports each freshly generated asset; we accumulate them (dev only).
    ipcMain.on('plugin-asset-cache:save', (_e, namespace: string, key: string, value: string) => {
        if (app.isPackaged) return; // bundled cache is read-only in shipped builds
        if (typeof namespace !== 'string' || !namespace) return;
        if (typeof key !== 'string' || typeof value !== 'string' || value.length < 100) return;
        const c = load(namespace);
        if (c.entries[key] === value) return;
        c.entries[key] = value;
        dirty.add(namespace);
        const t = writeTimers.get(namespace);
        if (t) clearTimeout(t);
        writeTimers.set(namespace, setTimeout(() => flush(namespace), 1500));
    });

    app.on('will-quit', () => { for (const ns of caches.keys()) flush(ns); });
}
