// Core-managed shared model-icon cache.
//
// EvilQuest's 3D models (NPCs, world objects) are expensive to render into flat
// icons, so the World Map plugin renders them once (Babylon) and caches the PNGs.
// Those icons are useful to *any* plugin (Collection Log source icons, future
// panels…), so rather than have plugins reach into the map plugin's private
// cache, the icons live in a single CORE-OWNED namespace ('model-icons') with a
// shared key scheme. The map plugin is the producer (it can render models); every
// other plugin is a read-only consumer. All access goes through this class.
//
// Backed by PluginAssetCache, so it inherits the same behaviour: a build-committed
// JSON file under the plugin data tree, prebaked icons in shipped builds, dev-only
// writes that accumulate and can be committed.

import { PluginAssetCache } from './pluginAssetCache';

/** The one core-managed namespace every plugin shares for rendered model icons. */
export const MODEL_ICONS_NAMESPACE = 'model-icons';

/** Key used when an NPC has no specific rendered model (generic humanoid). */
export const HUMANOID_ICON_KEY = 'npc:__humanoid__';

export class ModelIconCache {
    private readonly cache = new PluginAssetCache(MODEL_ICONS_NAMESPACE);

    // ── canonical key scheme (shared by producer + consumers) ──────────────────
    /** Icon key for an NPC, by its definition id. */
    static npcKey(defId: number | string): string { return `npc:${defId}`; }
    /** Icon key for a placed world object, by its per-placement model asset id. */
    static objectKey(assetId: string): string { return `obj:${assetId}`; }
    /** Icon key for a world object by its definition id (coarser fallback). */
    static objectDefKey(defId: number | string): string { return `objdef:${defId}`; }

    /** Load the whole { key -> dataURL } map (prebaked + dev-accumulated). */
    load(): Promise<Record<string, string>> { return this.cache.load(); }

    /** Producer-only: persist one rendered icon. No-op in packaged builds. */
    save(key: string, dataUrl: string): void { this.cache.save(key, dataUrl); }

    /**
     * Resolve the best icon dataURL for an NPC from an already-loaded map.
     * Falls back to the generic humanoid icon if the specific model isn't cached.
     */
    static resolveNpc(icons: Record<string, string>, defId: number | string): string | null {
        return icons[ModelIconCache.npcKey(defId)] ?? icons[HUMANOID_ICON_KEY] ?? null;
    }

    /**
     * Resolve the best icon dataURL for a world object from an already-loaded map:
     * the precise per-placement asset first, then the coarser per-def icon.
     */
    static resolveObject(icons: Record<string, string>, assetId: string | null | undefined, defId: number | string | null | undefined): string | null {
        if (assetId) { const v = icons[ModelIconCache.objectKey(assetId)]; if (v) return v; }
        if (defId != null) { const v = icons[ModelIconCache.objectDefKey(defId)]; if (v) return v; }
        return null;
    }
}
