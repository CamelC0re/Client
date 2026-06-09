import { Plugin } from '@evillite/core/src/interfaces/highlite/plugin/plugin.class';
import { SettingsTypes, type PluginSettings } from '@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface';

/**
 * World Map plugin for EvilQuest.
 *
 * Reads the game's own minimap + world data directly off the live GameManager
 * (`window.gm`). Everything is accessed by *semantic* property names (not the
 * minified class names), so it keeps working as EvilQuest ships new builds:
 *
 *   gm.chunkManager.getTilesForMinimap(cx, cz, r)  -> per-tile terrain/water/walls
 *   gm.chunkManager.tilePaintedEntries             -> explored-tile signal
 *   gm.chunkManager.mapWidth / mapHeight / mapId
 *   gm.minimap.lastPlayerX / lastPlayerZ           -> player world position
 *   gm.worldObjectDefs                             -> placed objects {defId,x,z,floor,depleted}
 *   gm.objectDefsCache.get(defId)                  -> raw objects.json def {id,category,name,...}
 *   gm.entities.npcDefs.get(id)                    -> npc defId
 *   gm.entities.npcDefsCache.get(defId)            -> raw npcs.json def {name,...}
 *   gm.entities.npcSprites/npcTargets/npcCombatLevels
 *   gm.entities.remotePlayers / playerNames
 *
 * Object/NPC categories are discovered dynamically and rendered as filterable,
 * colour-coded markers. NPCs (which the server only streams near the player) are
 * shown live AND accumulated into a persistent per-map store so "possible
 * locations" build up over time.
 */

interface MapObject {
    defId: number;
    category: string;
    name: string;
    x: number;
    z: number;
    floor: number;
    depleted: boolean;
    /** The placed object's asset id (rec.metadata.assetId) — the key into the game's
     *  assetRegistry that yields the real model path. This is the icon identity for
     *  objects (NOT defId, which carries no model). */
    assetId: string;
}

interface LiveNpc {
    id: number;
    defId: number;
    name: string;
    x: number;
    z: number;
    floor: number;
    level: number | undefined;
}

interface NpcSighting {
    defId: number;
    name: string;
    x: number;
    z: number;
    level: number | undefined;
}

/** A developer-placed POI from mapData.minimapMarkers. */
interface MinimapMarker {
    x: number;
    z: number;
    floor: number;
    label: string;
    icon: string;   // raw icon id/name from the game
    size: number;
    color: string;  // derived display colour
}

interface HitTarget {
    sx: number;
    sy: number;
    r: number;
    label: string;
    sub: string;
    wx: number;
    wz: number;
}

export default class WorldMapPlugin extends Plugin {
    pluginName = 'World Map';
    author = 'HighLite';

    settings: { enable: PluginSettings; [key: string]: PluginSettings } = {
        enable: {
            text: 'Enable World Map',
            type: SettingsTypes.checkbox,
            value: true,
            callback: this.onSettingsChanged_enabled.bind(this),
        },
    };

    // ── DOM ─────────────────────────────────────────────────────────────────────
    private mapOverlay: HTMLDivElement | null = null;
    private mapCanvas: HTMLCanvasElement | null = null;
    private statusEl: HTMLDivElement | null = null;
    private panelEl: HTMLDivElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private tooltipEl: HTMLDivElement | null = null;

    // ── Offscreen terrain canvas (1px per tile) ───────────────────────────────────
    private worldCanvas: HTMLCanvasElement | null = null;
    private worldCtx: CanvasRenderingContext2D | null = null;
    private worldW = 0;
    private worldH = 0;
    private worldWalls = new Uint8Array(0);

    private renderInterval: any = null;
    private isStarted = false;

    // ── View state (tile units) ───────────────────────────────────────────────────
    private centerX = 0;
    private centerZ = 0;
    private zoom = 4;
    private followPlayer = true;
    private currentFloor = 0;

    // ── Discovered/accumulated data ───────────────────────────────────────────────
    /** Persistent object store for the current map: key `${x},${z},${floor},${defId}`. */
    private objectStore = new Map<string, MapObject>();
    /** Persistent NPC sightings: defId -> (key `${x},${z}` -> sighting). */
    private npcStore = new Map<number, Map<string, NpcSighting>>();
    private liveNpcs: LiveNpc[] = [];
    private liveNpcKeys = new Set<string>();
    private players: { name: string; x: number; z: number }[] = [];
    private minimapMarkers: MinimapMarker[] = [];

    private mapId = '';
    private lastDataRefresh = 0;
    private lastSave = 0;
    private storeDirty = false;

    // ── Filter state ──────────────────────────────────────────────────────────────
    private disabledCats = new Set<string>();
    private disabledNames = new Set<string>(); // `${category}:${name}`
    private showLiveNpcs = true;
    private showNpcSightings = true;
    private showPlayers = true;
    private labelsEnabled = true;
    private showMinimapMarkers = true;
    private searchStr = '';
    private panelSignature = '';

    private hitTargets: HitTarget[] = [];
    private hoverPos: { x: number; y: number } | null = null;
    private floorLabelEl: HTMLSpanElement | null = null;

    private static readonly NPC_CAT = '__npc__';
    private static readonly MAX_SIGHTINGS_PER_NPC = 240;
    // Bump when the render output changes (camera angle, URL fix, …) to invalidate &
    // regenerate every persisted icon. Old-version keys are purged on load.

    // ── Lifecycle ─────────────────────────────────────────────────────────────────
    init() {
        this.info('World Map Plugin initializing.');
        this.settings.enable.value = true;
        this.loadFilterState();
        this.setupChatHook();
        this.start();
    }

    private setupChatHook() {
        const obs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'childList') {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node as HTMLElement;
                            // Make sure we only process elements within the chat-log
                            if (el.closest && el.closest('#chat-log')) {
                                this.processChatNode(el);
                            }
                        }
                    }
                }
            }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        
        // Also process any existing nodes in the chat log (in case we load late)
        setTimeout(() => {
            const chatLog = document.getElementById('chat-log');
            if (chatLog) this.processChatNode(chatLog);
        }, 1000);
    }

    private processChatNode(el: HTMLElement) {
        // Find all deepest text nodes to prevent destroying HTML structure
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const textNodes: Text[] = [];
        let currentNode: Node | null;
        while ((currentNode = walker.nextNode())) {
            textNodes.push(currentNode as Text);
        }

        const pattern = /\((-?\d+),\s*(-?\d+)\)(?:\[(.*?)\])?/g;

        for (const node of textNodes) {
            const text = node.nodeValue;
            if (!text || !pattern.test(text)) continue;

            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            pattern.lastIndex = 0; // Reset regex
            
            let match;
            while ((match = pattern.exec(text)) !== null) {
                // Add text before the match
                if (match.index > lastIndex) {
                    fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
                }

                const x = parseInt(match[1], 10);
                const z = parseInt(match[2], 10);
                const label = match[3];

                const link = document.createElement('span');
                link.className = 'map-link';
                link.textContent = label ? label : `(${x}, ${z})`;
                link.title = label ? `Click to view (${x}, ${z}) on map` : 'Click to view on map';
                Object.assign(link.style, {
                    color: '#4da6ff',
                    cursor: 'pointer',
                    textDecoration: 'underline'
                });

                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleMap(true);
                    this.centerX = x;
                    this.centerZ = z;
                    this.followPlayer = false;
                    this.zoom = 12; // Zoom in comfortably on the target
                });

                fragment.appendChild(link);
                lastIndex = pattern.lastIndex;
            }

            // Add remaining text
            if (lastIndex < text.length) {
                fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
            }

            if (node.parentNode) {
                node.parentNode.replaceChild(fragment, node);
            }
        }
    }

    start() {
        if (this.isStarted) return;
        this.isStarted = true;
        this.info('World Map Plugin started.');
        this.createMapOverlay();
        this.installKeyHandler();
    }

    stop() {
        this.isStarted = false;
        this.info('World Map Plugin stopped.');
        this.persistStores(true);
        if (this.renderInterval) {
            clearInterval(this.renderInterval);
            this.renderInterval = null;
        }
        if (this.mapOverlay) {
            this.mapOverlay.remove();
            this.mapOverlay = null;
        }
    }

    onSettingsChanged_enabled() {
        if (this.settings.enable.value) this.start();
        else this.stop();
    }

    // ── Game data access (all by stable semantic names) ───────────────────────────
    private get gm(): any {
        return (window as any).gm ?? null;
    }
    private getChunkManager(): any {
        return this.gm?.chunkManager ?? null;
    }
    private getMapId(): string {
        return this.getChunkManager()?.mapId ?? this.gm?.mapId ?? 'default';
    }

    private getPlayerPos(): { x: number; z: number } | null {
        const gm = this.gm;
        const mm = gm?.minimap;
        if (mm && mm.hasLastPlayerPosition) return { x: mm.lastPlayerX, z: mm.lastPlayerZ };
        const cam = gm?.camera?.getCamera?.();
        const target = cam?.target ?? cam?.getTarget?.();
        if (target) return { x: target.x, z: target.z };
        const lp = gm?.localPlayer;
        if (lp?.position) return { x: lp.position.x, z: lp.position.z };
        return null;
    }

    // ── Category styling (defaults + dynamic fallback for new categories) ──────────
    private static readonly CAT_COLOR: Record<string, string> = {
        tree: '#3ea63e',
        rock: '#9a8f86',
        bank: '#f1c40f',
        furnace: '#e67e22',
        cookingrange: '#e74c3c',
        fishingspot: '#3498db',
        crop: '#d4ac0d',
        chest: '#a9783c',
        door: '#c9a66b',
        ladder: '#ecf0f1',
        __npc__: '#ff5555',
    };
    private catColor(cat: string): string {
        const known = WorldMapPlugin.CAT_COLOR[cat];
        if (known) return known;
        // Deterministic hue from the category name so new categories get a stable colour.
        let h = 0;
        for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) & 0xffff;
        return `hsl(${h % 360}, 65%, 55%)`;
    }
    /** Stable category shape shown while an object's own icon is still rendering (or its
     *  mesh hasn't loaded near yet) — category-coloured, deterministic, so it never churns. */
    private catShape(cat: string): 'circle' | 'square' | 'diamond' | 'triangle' {
        if (cat === WorldMapPlugin.NPC_CAT) return 'triangle';
        if (cat === 'rock') return 'diamond';
        if (cat === 'bank' || cat === 'furnace' || cat === 'cookingrange' || cat === 'chest' || cat === 'door' || cat === 'ladder') return 'square';
        return 'circle';
    }
    private prettify(s: string): string {
        if (!s) return '';
        return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
    /** Turn a model assetId (Crate1, OnePersonBed1, CopperRock2, bush2) into a readable
     *  label (Crate, One Person Bed, Copper Rock, Bush) — used for objects whose def name
     *  is generic ("Scenery", "Door"), since EvilQuest only stores the real identity in the
     *  per-placement assetId. Trailing version numbers are dropped so variants group. */
    private prettifyAsset(a: string): string {
        return (a || '')
            .replace(/\.glb$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase boundary
            .replace(/([A-Za-z])(\d)/g, '$1 $2')  // letter→digit boundary
            .replace(/\s+\d+$/, '')                // drop trailing version number
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // ── Data collection + accumulation ────────────────────────────────────────────
    private refreshData() {
        const now = performance.now();
        if (now - this.lastDataRefresh < 500) return;
        this.lastDataRefresh = now;

        const gm = this.gm;
        if (!gm) return;

        // Map change -> swap stores.
        const id = this.getMapId();
        if (id !== this.mapId) {
            this.persistStores(true);
            this.mapId = id;
            this.objectStore.clear();
            this.npcStore.clear();
            this.catSampleObj.clear();
            this.nameSampleObj.clear();
            this.catRepIcon.clear();
            this.nameRepIcon.clear();
            this.defIdAssets.clear();
            this._mmDumped = false; // re-log marker fields for the new map
            this.loadStores();
        }

        this.collectObjects();
        this.collectNpcs();
        this.collectPlayers();
        this.collectMinimapMarkers();

        // Once defs have streamed in, dump a sample of real def shapes so we can see
        // where trees/humans keep their model files.
        if (!this.diagDumped && this.bjsState === 'ready' && this.objectStore.size > 0 && this.npcStore.size > 0) {
            this.dumpModelDiag();
        }
        // Keep probing object categories as their meshes load nearby (catches altar/rock/
        // bank/furnace that weren't loaded when the one-shot dump ran).
        this.probeNewObjectCategories();

        // Rebuild the filter panel if the set of categories/names changed.
        const sig = this.computePanelSignature();
        if (sig !== this.panelSignature) {
            this.panelSignature = sig;
            this.buildPanel();
        }

        if (this.storeDirty && now - this.lastSave > 4000) this.persistStores();
    }

    private collectObjects() {
        const gm = this.gm;
        const wod: Map<any, any> | undefined = gm.worldObjectDefs;
        const defs: Map<any, any> | undefined = gm.objectDefsCache;
        if (!wod || !defs) return;
        // worldObjectDefs has the category/name (via defId) but NO model; the loaded
        // mesh — keyed by the SAME key in worldObjectModels — carries metadata.assetId,
        // which is the key into assetRegistry for the real model. Join them here.
        const models = this.getWorldObjectModels();
        for (const [woKey, rec] of wod) {
            if (!rec || typeof rec.x !== 'number' || typeof rec.z !== 'number') continue;
            const def = defs.get(rec.defId);
            const category = (def?.category ?? 'object') + '';
            const defName = (def?.name ?? `#${rec.defId}`) + '';
            const floor = rec.floor ?? 0;
            const model = models?.get(woKey);
            const meta = model?.metadata;
            let assetId = (rec.metadata?.assetId ?? meta?.assetId ?? rec.assetId ?? '') + '';
            if (!assetId && model) assetId = this.assetIdFromModel(model);
            // The def name is generic for some categories ("Scenery", "Door", "Ladder",
            // "Anvil") — one defId covers all variants. For those, the real identity lives
            // in the per-placement assetId (Crate1, OnePersonBed1…), so derive the name from
            // it. Categories with specific def names (Oak Tree, Copper Rock) keep the def name.
            const placedName = (meta?.placedName ?? '') + '';
            // Only the "scenery" grab-bag benefits from assetId-derived names (Crate, Bed,
            // Bush, Well…). Other categories have good def names — e.g. a tree's def name
            // "Tree" reads better than its assetId "sTree 2" → "S Tree".
            const specificName = category === 'scenery' && assetId ? this.prettifyAsset(assetId) : '';
            const name = placedName || specificName || defName;
            const key = `${rec.x},${rec.z},${floor},${rec.defId}`;
            const existing = this.objectStore.get(key);
            const depleted = !!rec.depleted;
            let stored = existing;
            if (!existing) {
                stored = { defId: rec.defId, category, name, x: rec.x, z: rec.z, floor, depleted, assetId };
                this.objectStore.set(key, stored);
                this.storeDirty = true;
            } else {
                if (existing.depleted !== depleted) existing.depleted = depleted;
                if (!existing.assetId && assetId) existing.assetId = assetId;
                // Upgrade a generic def name to the specific one once the assetId streams in.
                const better = placedName || specificName;
                if (better && existing.name !== better) { existing.name = better; this.storeDirty = true; }
            }
            // Track a representative (one carrying an assetId) per category / name, and
            // record assetIds per defId (for the distant-object icon reuse).
            if (stored && stored.assetId) {
                const ex = this.catSampleObj.get(category);
                if (!ex || !ex.assetId) this.catSampleObj.set(category, stored);
                const nk = category + ' ' + stored.name;
                const exn = this.nameSampleObj.get(nk);
                if (!exn || !exn.assetId) this.nameSampleObj.set(nk, stored);
                let set = this.defIdAssets.get(rec.defId);
                if (!set) { set = new Set(); this.defIdAssets.set(rec.defId, set); }
                set.add(stored.assetId);
            }
        }
    }

    private collectNpcs() {
        const ents = this.gm?.entities;
        this.liveNpcs = [];
        this.liveNpcKeys = new Set();
        if (!ents) return;
        const npcDefs: Map<any, any> | undefined = ents.npcDefs;
        const cache: Map<any, any> | undefined = ents.npcDefsCache;
        if (!npcDefs) return;

        for (const [id, defId] of npcDefs) {
            const spr = ents.npcSprites?.get(id);
            const tgt = ents.npcTargets?.get(id);
            let x: number | undefined, z: number | undefined, floor = 0;
            if (spr?.position && spr.isRenderEnabled?.() !== false) {
                x = spr.position.x;
                z = spr.position.z;
            }
            if ((x == null || z == null) && tgt) {
                x = tgt.x;
                z = tgt.z;
                floor = tgt.floor ?? 0;
            }
            if (x == null || z == null) continue;
            const def = cache?.get(defId);
            const name = (def?.name ?? `NPC #${defId}`) + '';
            const level = ents.npcCombatLevels?.get(id);
            this.liveNpcs.push({ id, defId, name, x, z, floor, level });
            this.liveNpcKeys.add(`${defId}:${Math.round(x)},${Math.round(z)}`);
            if (!this.npcNameDef.has(name)) this.npcNameDef.set(name, defId);

            // Accumulate sighting (rounded to a tile).
            const rx = Math.round(x), rz = Math.round(z);
            let perDef = this.npcStore.get(defId);
            if (!perDef) { perDef = new Map(); this.npcStore.set(defId, perDef); }
            const skey = `${rx},${rz}`;
            if (!perDef.has(skey)) {
                if (perDef.size >= WorldMapPlugin.MAX_SIGHTINGS_PER_NPC) {
                    const first = perDef.keys().next().value;
                    if (first !== undefined) perDef.delete(first);
                }
                perDef.set(skey, { defId, name, x: rx, z: rz, level });
                this.storeDirty = true;
            }
        }
    }

    private collectPlayers() {
        const ents = this.gm?.entities;
        this.players = [];
        if (!ents?.remotePlayers) return;
        for (const [id, spr] of ents.remotePlayers) {
            const pos = spr?.position;
            if (!pos) continue;
            const name = ents.playerNames?.get(id) ?? '';
            this.players.push({ name, x: pos.x, z: pos.z });
        }
    }

    private collectMinimapMarkers() {
        const gm = this.gm;
        // The game's minimap update calls chunkManager.getMinimapMarkers() and filters
        // by currentFloor itself before drawing. We use the same source.
        let raw: any[];
        try {
            raw = gm?.chunkManager?.getMinimapMarkers?.()
                ?? gm?.minimap?.getMinimapMarkers?.()
                ?? gm?.mapData?.minimapMarkers
                ?? [];
        } catch { raw = []; }
        if (!Array.isArray(raw) || !raw.length) { this.minimapMarkers = []; return; }

        // Log field names once so we can see the real marker shape in dev.
        if (!this._mmDumped) {
            this._mmDumped = true;
            const sample = raw[0];
            this.sendDiag(`MINIMAPMARKER keys=[${Object.keys(sample ?? {}).join(',')}] sample=${JSON.stringify(sample).slice(0, 300)}`);
        }

        const currentFloor = gm?.minimap?.currentFloor ?? gm?.currentFloor ?? 0;
        this.minimapMarkers = raw
            .filter((m: any) => m && typeof m.x === 'number' && typeof m.z === 'number')
            .filter((m: any) => m.floor === undefined || m.floor === null || m.floor === currentFloor)
            .map((m: any) => ({
                x: m.x,
                z: m.z,
                floor: m.floor ?? 0,
                // icon is the image-key the game uses (loaded via its icon registry)
                icon: (m.icon ?? m.type ?? m.markerType ?? '') + '',
                size: typeof m.size === 'number' ? m.size : 16,
                // label: not drawn by game; we show in tooltip on hover
                label: (m.label ?? m.name ?? m.title ?? m.tooltip ?? m.icon ?? '') + '',
                color: this.minimapMarkerColor(m),
            }));
    }
    private _mmDumped = false;

    private minimapMarkerColor(m: any): string {
        if (m.color) return m.color;
        const t = (m.type ?? m.markerType ?? m.icon ?? '') + '';
        if (/bank/i.test(t)) return '#f1c40f';
        if (/shop|store/i.test(t)) return '#e67e22';
        if (/spawn|boss/i.test(t)) return '#e74c3c';
        if (/quest/i.test(t)) return '#9b59b6';
        if (/dungeon|cave/i.test(t)) return '#7f8c8d';
        return '#ffd24a'; // default gold
    }

    // ── Persistence (localStorage, per map) ───────────────────────────────────────
    private storageKey(kind: string): string {
        return `evilitemap:${kind}:${this.mapId}`;
    }

    private loadStores() {
        try {
            const objRaw = localStorage.getItem(this.storageKey('obj'));
            if (objRaw) {
                const arr = JSON.parse(objRaw) as any[];
                for (const o of arr) {
                    const key = `${o.x},${o.z},${o.floor},${o.defId}`;
                    this.objectStore.set(key, { defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, depleted: false, assetId: o.assetId ?? '' });
                }
            }
            const npcRaw = localStorage.getItem(this.storageKey('npc'));
            if (npcRaw) {
                const obj = JSON.parse(npcRaw) as Record<string, { name: string; pts: number[][] }>;
                for (const defIdStr of Object.keys(obj)) {
                    const defId = Number(defIdStr);
                    const entry = obj[defIdStr];
                    const m = new Map<string, NpcSighting>();
                    for (const p of entry.pts) {
                        const [x, z, level] = p;
                        m.set(`${x},${z}`, { defId, name: entry.name, x, z, level: level < 0 ? undefined : level });
                    }
                    this.npcStore.set(defId, m);
                    if (!this.npcNameDef.has(entry.name)) this.npcNameDef.set(entry.name, defId);
                }
            }
        } catch (e: any) {
            this.warn('loadStores failed: ' + (e?.message || e));
        }
    }

    private persistStores(force = false) {
        if (!this.mapId) return;
        if (!force && !this.storeDirty) return;
        this.lastSave = performance.now();
        this.storeDirty = false;
        try {
            const objArr = [...this.objectStore.values()].map((o) => ({ defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, assetId: o.assetId }));
            localStorage.setItem(this.storageKey('obj'), JSON.stringify(objArr));

            const npcObj: Record<string, { name: string; pts: number[][] }> = {};
            for (const [defId, m] of this.npcStore) {
                const first = m.values().next().value;
                npcObj[defId] = { name: first?.name ?? `NPC #${defId}`, pts: [...m.values()].map((s) => [s.x, s.z, s.level ?? -1]) };
            }
            localStorage.setItem(this.storageKey('npc'), JSON.stringify(npcObj));
        } catch (e: any) {
            this.warn('persistStores failed: ' + (e?.message || e));
        }
    }

    private loadFilterState() {
        try {
            const raw = localStorage.getItem('evilitemap:filters');
            if (!raw) return;
            const f = JSON.parse(raw);
            this.disabledCats = new Set(f.disabledCats ?? []);
            this.disabledNames = new Set(f.disabledNames ?? []);
            this.showLiveNpcs = f.showLiveNpcs ?? true;
            this.showNpcSightings = f.showNpcSightings ?? true;
            this.showPlayers = f.showPlayers ?? true;
            this.iconsEnabled = f.iconsEnabled ?? true;
            this.labelsEnabled = f.labelsEnabled ?? true;
            this.showMinimapMarkers = f.showMinimapMarkers ?? true;
        } catch { /* ignore */ }
    }
    private saveFilterState() {
        try {
            localStorage.setItem('evilitemap:filters', JSON.stringify({
                disabledCats: [...this.disabledCats],
                disabledNames: [...this.disabledNames],
                showLiveNpcs: this.showLiveNpcs,
                showNpcSightings: this.showNpcSightings,
                showPlayers: this.showPlayers,
                iconsEnabled: this.iconsEnabled,
                labelsEnabled: this.labelsEnabled,
                showMinimapMarkers: this.showMinimapMarkers,
            }));
        } catch { /* ignore */ }
    }

    // ── Taxonomy helpers ──────────────────────────────────────────────────────────
    /** category -> Map<name, count>, plus the NPC pseudo-category. */
    private buildTaxonomy(): Map<string, Map<string, number>> {
        const tax = new Map<string, Map<string, number>>();
        const add = (cat: string, name: string) => {
            let m = tax.get(cat);
            if (!m) { m = new Map(); tax.set(cat, m); }
            m.set(name, (m.get(name) ?? 0) + 1);
        };
        for (const o of this.objectStore.values()) add(o.category, o.name);
        const npcNames = new Map<string, number>();
        for (const m of this.npcStore.values()) {
            const first = m.values().next().value;
            if (first) npcNames.set(first.name, (npcNames.get(first.name) ?? 0) + m.size);
        }
        if (npcNames.size) tax.set(WorldMapPlugin.NPC_CAT, npcNames);
        return tax;
    }
    private computePanelSignature(): string {
        const tax = this.buildTaxonomy();
        const parts: string[] = [];
        for (const [cat, names] of [...tax].sort((a, b) => a[0].localeCompare(b[0]))) {
            parts.push(cat + '(' + [...names.keys()].sort().join('|') + ')');
        }
        return parts.join(';');
    }

    private catEnabled(cat: string): boolean {
        return !this.disabledCats.has(cat);
    }
    private nameEnabled(cat: string, name: string): boolean {
        return this.catEnabled(cat) && !this.disabledNames.has(`${cat}:${name}`);
    }

    // ── Overlay UI ────────────────────────────────────────────────────────────────
    private updateFloorLabel() {
        if (this.floorLabelEl) {
            this.floorLabelEl.innerText = `Floor: ${this.currentFloor}`;
        }
    }

    private createMapOverlay() {
        if (this.mapOverlay) return;

        this.mapOverlay = document.createElement('div');
        Object.assign(this.mapOverlay.style, {
            position: 'fixed', top: '6%', left: '6%', width: '88%', height: '88%',
            backgroundColor: 'rgba(0,0,0,0.93)', border: '2px solid var(--theme-border, #444)',
            borderRadius: '8px', zIndex: '2147483647', display: 'none', flexDirection: 'column',
            padding: '12px', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif',
        } as CSSStyleDeclaration);
        this.mapOverlay.classList.add('highlite-ui');

        // Header
        const header = document.createElement('div');
        Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', color: '#fff', gap: '10px' } as CSSStyleDeclaration);

        const title = document.createElement('h2');
        title.innerText = 'World Map';
        Object.assign(title.style, { margin: '0', fontSize: '18px', whiteSpace: 'nowrap' } as CSSStyleDeclaration);

        this.searchInput = document.createElement('input');
        this.searchInput.placeholder = 'Search objects & NPCs…';
        Object.assign(this.searchInput.style, {
            flex: '1', maxWidth: '320px', padding: '6px 10px', borderRadius: '4px',
            border: '1px solid #555', background: '#1a1a1a', color: '#fff', fontSize: '13px',
        } as CSSStyleDeclaration);
        this.searchInput.oninput = () => { this.searchStr = this.searchInput!.value.trim().toLowerCase(); };
        this.searchInput.onkeydown = (e) => { if (e.key === 'Enter') this.jumpToNearestMatch(); e.stopPropagation(); };

        const jumpBtn = document.createElement('button');
        jumpBtn.innerText = 'Jump';
        this.styleButton(jumpBtn, '#2c3e50');
        jumpBtn.title = 'Centre on the nearest search match';
        jumpBtn.onclick = () => this.jumpToNearestMatch();

        const followBtn = document.createElement('button');
        followBtn.innerText = 'Follow: ON';
        this.styleButton(followBtn, '#2c3e50');
        const setFollow = (on: boolean) => {
            this.followPlayer = on;
            followBtn.innerText = `Follow: ${on ? 'ON' : 'OFF'}`;
        };
        followBtn.onclick = () => setFollow(!this.followPlayer);

        const closeBtn = document.createElement('button');
        closeBtn.innerText = 'Close';
        this.styleButton(closeBtn, 'var(--theme-danger, #e74c3c)');
        closeBtn.onclick = () => this.toggleMap(false);

        const floorDownBtn = document.createElement('button');
        floorDownBtn.innerText = '▼';
        this.styleButton(floorDownBtn, '#2c3e50');
        floorDownBtn.title = 'Floor Down';
        floorDownBtn.onclick = () => { setFollow(false); this.currentFloor--; this.worldCanvas = null; this.updateFloorLabel(); };

        this.floorLabelEl = document.createElement('span');
        this.updateFloorLabel();
        Object.assign(this.floorLabelEl.style, { fontWeight: 'bold', minWidth: '60px', textAlign: 'center', userSelect: 'none' } as CSSStyleDeclaration);

        const floorUpBtn = document.createElement('button');
        floorUpBtn.innerText = '▲';
        this.styleButton(floorUpBtn, '#2c3e50');
        floorUpBtn.title = 'Floor Up';
        floorUpBtn.onclick = () => { setFollow(false); this.currentFloor++; this.worldCanvas = null; this.updateFloorLabel(); };

        const right = document.createElement('div');
        Object.assign(right.style, { display: 'flex', gap: '8px', alignItems: 'center' } as CSSStyleDeclaration);
        right.append(floorDownBtn, this.floorLabelEl, floorUpBtn, followBtn, closeBtn);
        header.append(title, this.searchInput, jumpBtn, right);

        // Full-width status strip below the header (never truncated).
        this.statusEl = document.createElement('div');
        Object.assign(this.statusEl.style, {
            fontSize: '12px', opacity: '0.75', color: '#fff', margin: '2px 0 8px',
            fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        } as CSSStyleDeclaration);

        // Body: left filter panel + canvas
        const body = document.createElement('div');
        Object.assign(body.style, { flex: '1', display: 'flex', gap: '10px', minHeight: '0' } as CSSStyleDeclaration);

        this.panelEl = document.createElement('div');
        Object.assign(this.panelEl.style, {
            width: '210px', minWidth: '210px', overflowY: 'auto', color: '#fff', fontSize: '13px',
            background: '#141414', borderRadius: '6px', padding: '8px',
        } as CSSStyleDeclaration);

        const canvasWrap = document.createElement('div');
        Object.assign(canvasWrap.style, { flex: '1', position: 'relative', minWidth: '0' } as CSSStyleDeclaration);

        this.mapCanvas = document.createElement('canvas');
        Object.assign(this.mapCanvas.style, {
            width: '100%', height: '100%', backgroundColor: '#0a0a0a', borderRadius: '4px', cursor: 'grab',
        } as CSSStyleDeclaration);

        this.tooltipEl = document.createElement('div');
        Object.assign(this.tooltipEl.style, {
            position: 'absolute', display: 'none', pointerEvents: 'none', background: 'rgba(0,0,0,0.9)',
            color: '#fff', border: '1px solid #555', borderRadius: '4px', padding: '4px 8px', fontSize: '12px',
            whiteSpace: 'nowrap', zIndex: '10', transform: 'translate(8px, 8px)',
        } as CSSStyleDeclaration);

        canvasWrap.append(this.mapCanvas, this.tooltipEl);
        body.append(this.panelEl, canvasWrap);
        this.mapOverlay.append(header, this.statusEl, body);
        document.body.appendChild(this.mapOverlay);

        this.installCanvasControls();
    }

    private styleButton(btn: HTMLButtonElement, bg: string) {
        Object.assign(btn.style, {
            padding: '6px 14px', cursor: 'pointer', backgroundColor: bg, border: 'none',
            borderRadius: '4px', color: '#fff', fontFamily: 'Inter, sans-serif', fontSize: '13px', whiteSpace: 'nowrap',
        } as CSSStyleDeclaration);
    }

    private buildPanel() {
        if (!this.panelEl) return;
        const tax = this.buildTaxonomy();
        this.panelEl.innerHTML = '';
        this.legendSlots = []; // DOM rebuilt — drop stale slot references

        // Global toggles row
        const globals = document.createElement('div');
        globals.style.marginBottom = '8px';
        globals.append(
            this.makeToggle('Model icons', this.iconsEnabled, (v) => { this.iconsEnabled = v; this.saveFilterState(); }, '#9b59b6'),
            this.makeToggle('Text labels', this.labelsEnabled, (v) => { this.labelsEnabled = v; this.saveFilterState(); }, '#e0e0e0'),
            this.makeToggle('Minimap markers', this.showMinimapMarkers, (v) => { this.showMinimapMarkers = v; this.saveFilterState(); }, '#ffd24a'),
            this.makeToggle('Players', this.showPlayers, (v) => { this.showPlayers = v; this.saveFilterState(); }, '#5dd5ff'),
            this.makeToggle('NPCs (live)', this.showLiveNpcs, (v) => { this.showLiveNpcs = v; this.saveFilterState(); }, '#ff5555'),
            this.makeToggle('NPC sightings', this.showNpcSightings, (v) => { this.showNpcSightings = v; this.saveFilterState(); }, '#aa4444'),
        );
        this.panelEl.appendChild(globals);

        const sep = document.createElement('div');
        Object.assign(sep.style, { height: '1px', background: '#333', margin: '6px 0' } as CSSStyleDeclaration);
        this.panelEl.appendChild(sep);

        // Categories (NPC pseudo-category last)
        const cats = [...tax.keys()].sort((a, b) => {
            if (a === WorldMapPlugin.NPC_CAT) return 1;
            if (b === WorldMapPlugin.NPC_CAT) return -1;
            return a.localeCompare(b);
        });
        for (const cat of cats) {
            const names = tax.get(cat)!;
            const total = [...names.values()].reduce((a, b) => a + b, 0);
            const isNpc = cat === WorldMapPlugin.NPC_CAT;
            const catLabel = isNpc ? 'NPCs' : this.prettify(cat);

            const row = document.createElement('div');
            row.style.marginBottom = '2px';

            const head = document.createElement('div');
            Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } as CSSStyleDeclaration);

            const cb = this.makeCheckbox(this.catEnabled(cat), (v) => {
                if (v) this.disabledCats.delete(cat); else this.disabledCats.add(cat);
                this.saveFilterState();
            });
            const swatch = this.makeLegendIcon(isNpc ? 'npc' : 'obj', cat, undefined, this.catColor(cat));
            const lbl = document.createElement('span');
            lbl.textContent = `${catLabel} (${total})`;
            lbl.style.flex = '1';
            const caret = document.createElement('span');
            caret.textContent = '▸';
            caret.style.opacity = '0.6';

            const sub = document.createElement('div');
            Object.assign(sub.style, { display: 'none', paddingLeft: '20px', marginTop: '2px' } as CSSStyleDeclaration);
            const sortedNames = [...names.keys()].sort();
            for (const nm of sortedNames) {
                const nrow = document.createElement('div');
                Object.assign(nrow.style, { display: 'flex', alignItems: 'center', gap: '6px' } as CSSStyleDeclaration);
                const ncb = this.makeCheckbox(this.nameEnabled(cat, nm), (v) => {
                    const k = `${cat}:${nm}`;
                    if (v) this.disabledNames.delete(k); else this.disabledNames.add(k);
                    this.saveFilterState();
                });
                const nicon = this.makeLegendIcon(isNpc ? 'npc' : 'obj', cat, nm, this.catColor(cat), 20);
                const nlbl = document.createElement('span');
                nlbl.textContent = `${this.prettify(nm)} (${names.get(nm)})`;
                nrow.append(ncb, nicon, nlbl);
                sub.appendChild(nrow);
            }

            const toggleExpand = () => { sub.style.display = sub.style.display === 'none' ? 'block' : 'none'; caret.textContent = sub.style.display === 'none' ? '▸' : '▾'; };
            caret.onclick = toggleExpand;
            lbl.onclick = toggleExpand;

            head.append(cb, swatch, lbl, caret);
            row.append(head, sub);
            this.panelEl.appendChild(row);
        }
    }

    /** A small icon holder for a legend row — starts as the colour swatch, then gets
     *  its representative model icon swapped in by refreshLegendIcons() once rendered. */
    private makeLegendIcon(kind: 'obj' | 'npc', cat: string, name: string | undefined, color: string, size = 24): HTMLElement {
        const el = document.createElement('span');
        Object.assign(el.style, {
            width: `${size}px`, height: `${size}px`, minWidth: `${size}px`, borderRadius: '3px',
            display: 'inline-block', backgroundColor: color, backgroundSize: 'contain',
            backgroundRepeat: 'no-repeat', backgroundPosition: 'center', flex: '0 0 auto',
        } as CSSStyleDeclaration);
        this.legendSlots.push({ el, kind, cat, name });
        return el;
    }

    /** A reusable person-silhouette icon (PNG) for humanoid NPC legend entries. */
    private getPersonIcon(): HTMLImageElement {
        if (this.personIcon) return this.personIcon;
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        const cx = c.getContext('2d');
        if (cx) this.drawPerson(cx, 16, 15, 11, '#f0a060', 1);
        const img = new Image();
        img.src = c.toDataURL('image/png');
        this.personIcon = img;
        return img;
    }

    private legendIconFor(kind: 'obj' | 'npc', cat: string, name?: string): HTMLImageElement | null {
        if (kind === 'obj') {
            if (name) {
                const ready = this.nameRepIcon.get(cat + ' ' + name);
                if (ready) return ready;
                const sample = this.nameSampleObj.get(cat + ' ' + name);
                if (sample) { const ic = this.getObjectIcon(sample); if (ic) return ic; } // queues a render
                return this.catRepIcon.get(cat) ?? null;
            }
            const repReady = this.catRepIcon.get(cat);
            if (repReady) return repReady;
            const sample = this.catSampleObj.get(cat); // parent falls back to a child's icon
            if (sample) return this.getObjectIcon(sample);
            return null;
        }
        // NPC: a specific name → its model icon (or person glyph if humanoid);
        // the parent NPC category → any ready animal icon, else the person glyph.
        if (name) {
            const defId = this.npcNameDef.get(name);
            if (defId == null) return null;
            const ic = this.getNpcIcon(defId);
            if (ic) return ic;
            if (this.isModelless('npc', defId)) return this.getPersonIcon();
            return null;
        }
        for (const defId of this.npcNameDef.values()) {
            const ic = this.iconCache.get('npc:' + defId);
            if (ic && ic.complete && ic.naturalWidth > 0) return ic;
        }
        return this.getPersonIcon();
    }

    private refreshLegendIcons() {
        for (const slot of this.legendSlots) {
            const img = this.legendIconFor(slot.kind, slot.cat, slot.name);
            if (!img || !img.complete || img.naturalWidth === 0) continue;
            if (slot.el.dataset.iconSrc === img.src) continue;
            slot.el.dataset.iconSrc = img.src;
            slot.el.style.backgroundImage = `url(${img.src})`;
            slot.el.style.backgroundColor = 'transparent';
        }
    }

    private makeCheckbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.style.cursor = 'pointer';
        cb.onchange = () => onChange(cb.checked);
        return cb;
    }
    private makeToggle(label: string, checked: boolean, onChange: (v: boolean) => void, color: string): HTMLDivElement {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' } as CSSStyleDeclaration);
        const cb = this.makeCheckbox(checked, onChange);
        const sw = document.createElement('span');
        Object.assign(sw.style, { width: '10px', height: '10px', borderRadius: '50%', background: color, display: 'inline-block' } as CSSStyleDeclaration);
        const l = document.createElement('span');
        l.textContent = label;
        row.append(cb, sw, l);
        return row;
    }

    private installKeyHandler() {
        window.addEventListener('keydown', (e) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            if (e.key === 'm' || e.key === 'M') this.toggleMap(this.mapOverlay?.style.display === 'none');
        }, { capture: true });
    }

    private installCanvasControls() {
        const canvas = this.mapCanvas!;

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.85 : 1.18;
            this.zoom = Math.max(0.5, Math.min(this.zoom * factor, 48));
        });

        let dragging = false, moved = false, lastX = 0, lastY = 0;
        canvas.addEventListener('mousedown', (e) => {
            dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY;
            canvas.style.cursor = 'grabbing';
        });
        window.addEventListener('mouseup', () => { dragging = false; canvas.style.cursor = 'grab'; });
        window.addEventListener('mousemove', (e) => {
            if (dragging) {
                const dx = e.clientX - lastX, dy = e.clientY - lastY;
                if (Math.abs(dx) + Math.abs(dy) > 2) { moved = true; this.followPlayer = false; }
                lastX = e.clientX; lastY = e.clientY;
                this.centerX -= dx / this.zoom;
                this.centerZ -= dy / this.zoom;
            }
            // Track hover for tooltips (canvas-local coords).
            const rect = canvas.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
                this.hoverPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            } else {
                this.hoverPos = null;
            }
        });
        // Click a marker -> centre on it, OR click ground -> walk there.
        canvas.addEventListener('click', () => {
            if (moved || !this.hoverPos) return;
            const hit = this.pickHit(this.hoverPos.x, this.hoverPos.y);
            if (hit) { 
                this.centerX = hit.wx; 
                this.centerZ = hit.wz; 
                
                // Also update the UI button when we stop following
                if (this.followPlayer) {
                    this.followPlayer = false;
                    const btn = this.mapOverlay?.querySelector('button') as HTMLButtonElement;
                    // The follow button is one of the buttons, we should ideally use the setFollow we created, but this works:
                    const followBtn = [...(this.mapOverlay?.querySelectorAll('button') ?? [])].find(b => b.innerText.startsWith('Follow:'));
                    if (followBtn) followBtn.innerText = 'Follow: OFF';
                }
            } else {
                // Ground click -> walk there
                const rect = canvas.getBoundingClientRect();
                const z = this.zoom;
                const dw = Math.max(1, Math.floor(rect.width));
                const dh = Math.max(1, Math.floor(rect.height));
                const srcLeft = this.centerX - dw / (2 * z);
                const srcTop = this.centerZ - dh / (2 * z);
                
                let worldX = srcLeft + this.hoverPos.x / z;
                let worldZ = srcTop + this.hoverPos.y / z;
                
                const player = this.getPlayerPos();
                if (player) {
                    const dx = worldX - player.x;
                    const dz = worldZ - player.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    const MAX_OVERLAY_DIST = 80;
                    if (dist > MAX_OVERLAY_DIST) {
                        const ratio = MAX_OVERLAY_DIST / dist;
                        worldX = player.x + dx * ratio;
                        worldZ = player.z + dz * ratio;
                    }
                }
                
                if (this.gm?.minimap?.onClickMove) {
                    this.gm.minimap.onClickMove(worldX, worldZ, worldX, worldZ);
                }
            }
        });

        // Right-click -> Copy coordinate
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.hoverPos) return;

            const rect = canvas.getBoundingClientRect();
            const z = this.zoom;
            const dw = Math.max(1, Math.floor(rect.width));
            const dh = Math.max(1, Math.floor(rect.height));
            const srcLeft = this.centerX - dw / (2 * z);
            const srcTop = this.centerZ - dh / (2 * z);
            
            const worldX = Math.round(srcLeft + this.hoverPos.x / z);
            const worldZ = Math.round(srcTop + this.hoverPos.y / z);

            let textToCopy = `(${worldX},${worldZ})`;
            const hit = this.pickHit(this.hoverPos.x, this.hoverPos.y);
            if (hit && hit.label) {
                // Remove formatting or sub-labels, just take the raw name
                const cleanLabel = hit.label.split('\n')[0].trim();
                textToCopy += `[${cleanLabel}]`;
            }

            const chatInput = document.getElementById('chat-input') as HTMLInputElement;
            if (chatInput) {
                // If there's already text, append it with a space, otherwise just set it
                const currentVal = chatInput.value.trim();
                chatInput.value = currentVal ? `${currentVal} ${textToCopy}` : textToCopy;
                chatInput.focus();
                
                // Optionally close the map so they can immediately hit enter or type
                this.toggleMap(false);
            } else {
                this.setStatus('Chat input not found.');
            }
        });
    }

    private pickHit(x: number, y: number): HitTarget | null {
        let best: HitTarget | null = null, bestD = Infinity;
        for (const h of this.hitTargets) {
            const d = (h.sx - x) ** 2 + (h.sy - y) ** 2;
            const rr = (h.r + 4) ** 2;
            if (d <= rr && d < bestD) { bestD = d; best = h; }
        }
        return best;
    }

    private toggleMap(show: boolean) {
        if (!this.mapOverlay) return;
        if (show) {
            this.mapOverlay.style.display = 'flex';
            this.followPlayer = true;
            this.refreshData();
            this.startRenderLoop();
        } else {
            this.mapOverlay.style.display = 'none';
            this.persistStores(true);
            if (this.renderInterval) { clearInterval(this.renderInterval); this.renderInterval = null; }
        }
    }

    // ── Terrain rendering ─────────────────────────────────────────────────────────
    private static readonly T = { GRASS: 0, DIRT: 1, STONE: 2, WATER: 3, WALL: 4, SAND: 5, WOOD: 6, MUD: 7 };
    // Base tile-type colors — match game's `ga` table exactly.
    private static readonly TYPE_COLOR: Record<number, number[]> = {
        0: [62, 140, 46], 1: [138, 104, 60], 2: [130, 124, 114], 3: [44, 88, 142],
        4: [62, 140, 46], 5: [196, 170, 106], 6: [116, 82, 48], 7: [62, 140, 46],
    };
    private static readonly TEXTURED_COLOR = [138, 116, 82]; // Nf
    private static readonly ROOF_COLOR = [96, 64, 34];       // Df — matches game exactly
    // Wall direction bitmask (F enum in the game): N=1, E=2, S=4, W=8 (Clockwise).
    // This aligns perfectly with the game's checks: (wf & 5) === 5 is N+S, (wf & 10) === 10 is E+W.
    private static readonly WF = { N: 1, E: 2, S: 4, W: 8 };
    // Wall-edge line color — RGB(220,216,200): warm cream, same as game minimap white lines.
    private static readonly WALL_LINE = [220, 216, 200];

    private startRenderLoop() {
        if (this.renderInterval) return;
        this.renderInterval = setInterval(() => this.renderFrame(), 80);
        this.renderFrame();
    }

    private lastPaintedSize = -1;
    private lastRebuild = 0;

    private getTilesForFloor(cm: any, cx: number, cz: number, radius: number, floor: number) {
        if (floor === 0 || typeof cm.floorLayerData?.get !== 'function') {
            return cm.getTilesForMinimap(cx, cz, radius);
        }

        const size = radius * 2;
        const startX = Math.floor(cx) - radius;
        const startZ = Math.floor(cz) - radius;
        
        const buf = {
            tiles: new Uint8Array(size * size),
            walls: new Uint8Array(size * size),
            voidTiles: new Uint8Array(size * size),
            roofs: new Uint8Array(size * size),
            textured: new Uint8Array(size * size),
            overrideColors: new Uint8Array(size * size * 3),
            hasOverride: new Uint8Array(size * size),
            size, startX, startZ
        };
        
        buf.voidTiles.fill(1);
        
        const layer = cm.floorLayerData.get(floor);
        if (!layer) return buf;
        
        for (let z = 0; z < size; z++) {
            for (let x = 0; x < size; x++) {
                const worldX = startX + x;
                const worldZ = startZ + z;
                if (worldX < 0 || worldX >= cm.mapWidth || worldZ < 0 || worldZ >= cm.mapHeight) continue;
                
                const idx = worldZ * cm.mapWidth + worldX;
                const localIdx = z * size + x;
                
                const hasTile = layer.tiles?.has(idx);
                const hasFloor = layer.floors?.has(idx);
                const hasWall = layer.walls?.has(idx);
                const hasRoof = layer.roofs?.has(idx);
                const hasStair = layer.stairs?.has(idx);
                
                if (hasTile || hasFloor || hasWall || hasRoof || hasStair) {
                    buf.voidTiles[localIdx] = 0;
                    buf.tiles[localIdx] = layer.tiles?.get(idx) ?? layer.floors?.get(idx) ?? 0;
                    buf.walls[localIdx] = layer.walls?.get(idx) ?? 0;
                    if (hasRoof) buf.roofs[localIdx] = 1;
                    if (hasFloor || hasStair) buf.textured[localIdx] = 1;
                }
            }
        }
        
        return buf;
    }

    private rebuildWorldCanvas(cm: any): boolean {
        const mapW = cm.mapWidth | 0;
        const mapH = cm.mapHeight | 0;
        if (!mapW || !mapH || typeof cm.getTilesForMinimap !== 'function') return false;

        if (!this.worldCanvas || this.worldW !== mapW || this.worldH !== mapH) {
            this.worldCanvas = document.createElement('canvas');
            this.worldCanvas.width = mapW;
            this.worldCanvas.height = mapH;
            this.worldW = mapW;
            this.worldH = mapH;
            this.worldWalls = new Uint8Array(mapW * mapH);
            this.worldCtx = this.worldCanvas.getContext('2d', { willReadFrequently: true });
            this.lastPaintedSize = -1;
        }

        const painted = cm.tilePaintedEntries?.size ?? 0;
        const now = performance.now();
        const grew = painted !== this.lastPaintedSize;
        const haveMap = this.lastPaintedSize >= 0;
        if (haveMap && now - this.lastRebuild < 600) return true;
        if (haveMap && !grew && now - this.lastRebuild < 1500) return true;
        this.lastPaintedSize = painted;
        this.lastRebuild = now;

        const RADIUS_CAP = 768;
        const fullRadius = Math.ceil(Math.max(mapW, mapH) / 2) + 2;
        const radius = Math.min(fullRadius, RADIUS_CAP);
        let cx: number, cz: number;
        if (radius >= fullRadius) { cx = mapW / 2; cz = mapH / 2; }
        else { const p = this.getPlayerPos(); cx = p ? p.x : mapW / 2; cz = p ? p.z : mapH / 2; }

        let buf: any;
        try { buf = this.getTilesForFloor(cm, cx, cz, radius, this.currentFloor); } catch { return this.lastPaintedSize >= 0; }
        if (!buf) return false;

        const { tiles, walls, roofs, textured, voidTiles, overrideColors, hasOverride, size, startX, startZ } = buf;
        const T = WorldMapPlugin.T, TC = WorldMapPlugin.TYPE_COLOR, TEX = WorldMapPlugin.TEXTURED_COLOR, ROOF = WorldMapPlugin.ROOF_COLOR;
        const clamp = (v: number) => v < 0 ? 0 : v > 255 ? 255 : v | 0;

        const ctx = this.worldCtx!;
        const img = ctx.createImageData(size, size);
        const data = img.data;

        // Fetch vertex heights for slope lighting
        const W = size + 1;
        const heights = new Float32Array(W * W);
        if (typeof cm.getVertexHeight === 'function') {
            for (let Z = 0; Z < W; Z++) {
                for (let Q = 0; Q < W; Q++) {
                    heights[Z * W + Q] = cm.getVertexHeight(startX + Q, startZ + Z);
                }
            }
        }

        // ── Pre-pass: flatten wall/bridge vertex heights ─────────────────────────────
        for (let f = 0; f < size; f++) {
            for (let m = 0; m < size; m++) {
                const b = f * size + m;
                if (voidTiles[b]) continue;
                const type = tiles[b], wallRaw = walls[b];
                if (type === T.WALL || (wallRaw & 5) === 5 || (wallRaw & 10) === 10) {
                    let vt = 0, kt = 0;
                    for (let nt = -1; nt <= 1; nt++) {
                        for (let st = -1; st <= 1; st++) {
                            const St = m + st, Bt = f + nt;
                            if (St < 0 || St >= size || Bt < 0 || Bt >= size) continue;
                            const gt = Bt * size + St;
                            const Yt = tiles[gt], Ft = walls[gt];
                            if (Yt !== T.WALL && (Ft & 5) !== 5 && (Ft & 10) !== 10) {
                                vt += heights[Bt * W + St];
                                kt++;
                            }
                        }
                    }
                    const Mt = kt > 0 ? vt / kt : 0;
                    heights[f * W + m] = Mt;
                    heights[f * W + m + 1] = Mt;
                    heights[(f + 1) * W + m] = Mt;
                    heights[(f + 1) * W + m + 1] = Mt;
                }
            }
        }

        // ── Pass 1: per-tile base colour (exactly mirrors the game's minimap logic) ──
        for (let f = 0; f < size; f++) {
            for (let m = 0; m < size; m++) {
                const b = f * size + m;
                const worldX = startX + m, worldZ = startZ + f;
                if (worldX < 0 || worldX >= mapW || worldZ < 0 || worldZ >= mapH) continue;
                if (voidTiles[b]) continue;
                const type = tiles[b], wallRaw = walls[b];
                const isWall = type === T.WALL || (wallRaw & 5) === 5 || (wallRaw & 10) === 10;
                const isRoof = !isWall && roofs[b] === 1;
                const isTex = !isWall && textured[b] === 1;

                // Replicate game's colour selection order:
                // ga[tile_type] is the base. overrideColors (biome tint, already 1.25× boosted
                // by the game engine) replaces it when present. Textured overrides non-wall.
                // Roofs get Df. Walls get their base darkened 55% (game: gt*0.55).
                let col = TC[type] ?? TC[T.GRASS];
                if (hasOverride[b] === 1) {
                    const e = b * 3;
                    col = [overrideColors[e], overrideColors[e + 1], overrideColors[e + 2]];
                }
                if (isTex) col = TEX;
                if (isRoof) col = ROOF;
                let r = col[0], g = col[1], bl = col[2];
                if (isWall) { r = clamp(r * 0.55); g = clamp(g * 0.55); bl = clamp(bl * 0.55); }

                if (type === T.WATER) {
                    // Water gets a special, smaller noise frequency/amplitude
                    const waterNoise = (((worldX * 3 * 73856093 ^ worldZ * 7 * 19349663) & 255) / 255) * 6 - 3;
                    r = clamp(r + waterNoise * 0.5);
                    g = clamp(g + waterNoise * 0.3);
                    bl = clamp(bl + waterNoise * 0.2);
                } else if (type !== T.MUD) {
                    // Coordinate-based noise (-3 to +3)
                    const noise = (((worldX * 73856093 ^ worldZ * 19349663) & 255) / 255) * 6 - 3;
                    
                    // Slope-based directional lighting
                    const ht = heights[f * W + m];
                    const pt = heights[f * W + m + 1];
                    const Ot = heights[(f + 1) * W + m];
                    // The game calculates slope as (x+1 - x) and (y+1 - y)
                    const ut = pt - ht;
                    const vt = Ot - ht;
                    
                    // The vanilla game minimap uses a fast additive model, not multiplicative!
                    const fi = this.currentFloor === 0 ? (-ut * 0.7 - vt * 0.7) * 30 : 0;
                    
                    r = clamp(r + noise + fi);
                    g = clamp(g + noise + fi);
                    bl = clamp(bl + noise + fi);
                }

                const o = b * 4;
                data[o] = r; data[o + 1] = g; data[o + 2] = bl; data[o + 3] = 255;
            }
        }

        // ── Pass 2: Cache wall-edge flags for screen-space rendering ─────────────
        // The game draws thin lines on each wall-flagged edge of non-wall tiles.
        // Wall direction bits: N=1, S=2, W=4, E=8 (F enum in the game source).
        for (let f = 0; f < size; f++) {
            for (let m = 0; m < size; m++) {
                const b = f * size + m;
                const worldX = startX + m, worldZ = startZ + f;
                if (worldX < 0 || worldX >= mapW || worldZ < 0 || worldZ >= mapH) continue;
                if (voidTiles[b]) continue;
                const wf = walls[b];
                const type = tiles[b];
                // Only cache edge lines for non-wall tiles that have wall-edge flags.
                if (!wf || type === T.WALL || (wf & 5) === 5 || (wf & 10) === 10) {
                    this.worldWalls[worldZ * mapW + worldX] = 0;
                } else {
                    this.worldWalls[worldZ * mapW + worldX] = wf;
                }
            }
        }

        const tmp = document.createElement('canvas');
        tmp.width = size; tmp.height = size;
        const tctx = tmp.getContext('2d');
        if (!tctx) return false;
        tctx.putImageData(img, 0, 0);
        ctx.drawImage(tmp, startX, startZ);
        return true;
    }

    private renderFrame() {
        if (!this.mapCanvas) return;
        this.refreshData();

        const cm = this.getChunkManager();
        const display = this.mapCanvas;
        const ctx = display.getContext('2d');
        if (!ctx) return;

        const rect = display.getBoundingClientRect();
        const dw = Math.max(1, Math.floor(rect.width));
        const dh = Math.max(1, Math.floor(rect.height));
        if (display.width !== dw || display.height !== dh) { display.width = dw; display.height = dh; }

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, dw, dh);

        if (!cm) { this.setStatus('Waiting for game… (log in to view the map)'); return; }

        if (this.followPlayer && typeof cm.getCurrentFloor === 'function') {
            const gmFloor = cm.getCurrentFloor();
            if (this.currentFloor !== gmFloor) {
                this.currentFloor = gmFloor;
                this.worldCanvas = null; // force rebuild
                this.updateFloorLabel();
            }
        }

        const built = this.rebuildWorldCanvas(cm);
        if (!built || !this.worldCanvas) { this.setStatus('Map data not loaded yet…'); return; }

        const player = this.getPlayerPos();
        if (this.followPlayer && player) { this.centerX = player.x; this.centerZ = player.z; }
        else if (this.centerX === 0 && this.centerZ === 0) { this.centerX = this.worldW / 2; this.centerZ = this.worldH / 2; }

        const z = this.zoom;
        const srcLeft = this.centerX - dw / (2 * z);
        const srcTop = this.centerZ - dh / (2 * z);

        // The game's native minimap uses a custom Javascript bilinear interpolator to blend the
        // calculated slope shading and coordinate noise across adjacent tiles. By enabling
        // native hardware image smoothing here, the browser does the exact same bilinear
        // filtering for us instantly when scaling the 1px-per-tile worldCanvas to the screen!
        ctx.imageSmoothingEnabled = true;
        ctx.save();
        ctx.translate(-srcLeft * z, -srcTop * z);
        ctx.scale(z, z);
        ctx.drawImage(this.worldCanvas, 0, 0);
        ctx.restore();

        // Draw thin wall lines (properly scaled to screen)
        ctx.fillStyle = `rgb(${WorldMapPlugin.WALL_LINE.join(',')})`;
        const minX = Math.max(0, Math.floor(srcLeft));
        const maxX = Math.min(this.worldW - 1, Math.ceil(srcLeft + dw / z));
        const minZ = Math.max(0, Math.floor(srcTop));
        const maxZ = Math.min(this.worldH - 1, Math.ceil(srcTop + dh / z));
        const wt = Math.max(1.5, z * 0.15); // Thin but visible line thickness

        for (let wz = minZ; wz <= maxZ; wz++) {
            for (let wx = minX; wx <= maxX; wx++) {
                const wf = this.worldWalls[wz * this.worldW + wx];
                if (!wf) continue;
                const sx = (wx - srcLeft) * z;
                const sy = (wz - srcTop) * z;
                if (wf & WorldMapPlugin.WF.N) ctx.fillRect(sx, sy, z, wt);
                if (wf & WorldMapPlugin.WF.S) ctx.fillRect(sx, sy + z - wt, z, wt);
                if (wf & WorldMapPlugin.WF.W) ctx.fillRect(sx, sy, wt, z);
                if (wf & WorldMapPlugin.WF.E) ctx.fillRect(sx + z - wt, sy, wt, z);
            }
        }

        // Markers (objects, NPC sightings, live NPCs, players, player).
        this.drawMarkers(ctx, dw, dh, srcLeft, srcTop, z);

        // Minimap markers (developer POIs — toggleable layer).
        if (this.showMinimapMarkers) this.drawMinimapMarkers(ctx, dw, dh, srcLeft, srcTop, z);

        const playerFloor = typeof cm.getCurrentFloor === 'function' ? cm.getCurrentFloor() : 0;
        if (player && playerFloor === this.currentFloor) {
            this.drawPlayerMarker(ctx, (player.x - srcLeft) * z, (player.z - srcTop) * z);
        }

        const minimap = this.gm?.minimap;
        if (minimap && minimap.destX !== null && minimap.destZ !== null) {
            // The destination marker is visible on whatever floor the player is on.
            if (playerFloor === this.currentFloor) {
                const dx = (minimap.destX - srcLeft) * z;
                const dz = (minimap.destZ - srcTop) * z;
                this.drawDestinationMarker(ctx, dx, dz, minimap.destAnimTime ?? 0);
            }
        }

        // Hover tooltip.
        this.updateTooltip();

        // Keep the legend's parent/child icons in sync as models render in.
        if (performance.now() - this.lastLegendRefresh > 400) {
            this.lastLegendRefresh = performance.now();
            this.refreshLegendIcons();
        }

        const objCount = this.objectStore.size;
        let sightCount = 0; for (const m of this.npcStore.values()) sightCount += m.size;
        const iconInfo = this.iconsEnabled
            ? ` | icons:${this.bjsState}${this.bjsState === 'ready' ? ` ${this.iconCache.size}✓` : ''}${this.iconPending.size ? ` ${this.iconPending.size}…` : ''}${this.iconFailed.size ? ` ${this.iconFailed.size}✗` : ''} mdl:${this.objModelFiles?.size ?? 0}/${this.npcModelFiles?.size ?? 0}`
            : '';
        const diag = this.lastIconDiag ? `  ·  ${this.lastIconDiag}` : '';
        this.setStatus(`obj:${objCount} seen:${sightCount} live:${this.liveNpcs.length} z:${z.toFixed(1)}x${iconInfo}${diag}`);
    }

    // ── Model-thumbnail icons (Phase 1) ───────────────────────────────────────────
    // Render the game's own 3D models to small sprites by reusing its already-loaded
    // Babylon instance (dynamically imported from the page's babylon-core module).
    // Object model files come from the bundle's `Cs` table (defId -> files), NPCs from
    // the `Lu` table (defId -> file); both are parsed out of window.__eqSourceCode.
    // Icons render lazily on demand, are cached, and replace the colour/shape markers.
    private iconsEnabled = true;
    private iconCache = new Map<string, HTMLImageElement>();
    private iconFailed = new Set<string>();
    private iconPending = new Set<string>();
    private iconQueue: { key: string; file: string }[] = [];
    private iconRendering = false;
    /** Representative ready icon per object category / `cat name` — drives the
     *  legend "parent" icons and the fallback for childless members. */
    private catRepIcon = new Map<string, HTMLImageElement>();
    private nameRepIcon = new Map<string, HTMLImageElement>();
    /** A representative object per category / `cat name`, so the legend can render an
     *  icon for it even before you pan near one on the map. */
    private catSampleObj = new Map<string, MapObject>();
    private nameSampleObj = new Map<string, MapObject>();
    /** npc display name -> a defId, so legend rows can find/queue an icon. */
    private npcNameDef = new Map<string, number>();
    /** Legend icon holders to keep refreshed as icons render in. */
    private legendSlots: { el: HTMLElement; kind: 'obj' | 'npc'; cat: string; name?: string }[] = [];
    private personIcon: HTMLImageElement | null = null;
    private lastLegendRefresh = 0;
    private objModelFiles: Map<number, string> | null = null;
    private npcModelFiles: Map<number, string> | null = null;
    /** Resolved model file per `${kind}:${defId}` (null = def loaded but has no .glb). */
    private modelFileCache = new Map<string, string | null>();
    /** defId -> the set of assetIds we've seen for it. When it's exactly one, distant
     *  objects of that defId (no mesh loaded) can reuse that model for their icon. */
    private defIdAssets = new Map<number, Set<string>>();
    private diagDumped = false;
    private bjs: { SceneLoader: any; SceneClass: any; EngineClass: any; Vector3: any; ArcRotateCamera: any } | null = null;
    private bjsState: 'idle' | 'init' | 'ready' | 'failed' = 'idle';
    private lastIconDiag = '';
    private offEngine: any = null;
    private offCanvas: HTMLCanvasElement | null = null;

    /**
     * Icon lookup order (cache-first, render-on-miss): in-memory → persisted
     * localStorage → runtime render. The persisted layer is the same data the
     * EvilLite devs would pre-bake and ship with the client, so most users never
     * run the offscreen renderer — but if the game adds new content before a new
     * cache is shipped, runtime generation fills the gap automatically.
     */
    private async initIconSystem(): Promise<void> {
        if (this.bjsState !== 'idle') return;
        this.bjsState = 'init';
        try {
            await this.loadPersistedIcons();
            const gm = this.gm;
            if (!gm?.scene) { this.bjsState = 'idle'; return; } // not in game yet — retry later
            let url = '';
            for (const el of Array.from(document.querySelectorAll('link[rel="modulepreload"],script[src]'))) {
                const src = (el as any).href || (el as any).src || '';
                if (/babylon-core[-.][A-Za-z0-9_]+\.js/.test(src)) { url = src; break; }
            }
            if (!url) { this.bjsState = 'failed'; this.warn('icons: babylon-core URL not found'); return; }
            const ns: any = await import(/* @vite-ignore */ url);
            const vals = Object.values(ns) as any[];
            const SceneLoader = vals.find(v => v && typeof v.ImportMeshAsync === 'function');
            // The game's Babylon is tree-shaken (no createDefaultCameraOrLight helper),
            // so find the classes we need by stable signatures and build the camera ourselves.
            const Vector3 = vals.find(v => typeof v === 'function' && typeof (v as any).Minimize === 'function' && typeof (v as any).Maximize === 'function' && typeof (v as any).Zero === 'function');
            const ArcRotateCamera = vals.find(v => typeof v === 'function' && v.prototype && typeof v.prototype.rebuildAnglesAndRadius === 'function');
            this.sendDiag(`init classes SceneLoader:${!!SceneLoader} Vector3:${!!Vector3} ArcRotateCamera:${!!ArcRotateCamera}`);
            if (!SceneLoader || !Vector3 || !ArcRotateCamera) { this.bjsState = 'failed'; this.warn('icons: required Babylon classes not found'); return; }
            // Reuse the exact Scene/Engine classes the game uses (same Babylon instance).
            this.bjs = { SceneLoader, SceneClass: gm.scene.constructor, EngineClass: gm.scene.getEngine().constructor, Vector3, ArcRotateCamera };
            this.parseModelTables();
            this.bjsState = 'ready';
            this.info(`icons: ready (${this.objModelFiles?.size ?? 0} object + ${this.npcModelFiles?.size ?? 0} npc models)`);
        } catch (e: any) {
            this.bjsState = 'failed';
            this.warn('icons: init failed — ' + (e?.message || e));
        }
    }

    /** Load the prebaked icon cache (key -> dataURL) from the main process. In a shipped
     *  build this is the cache compiled into the client; in dev it's the JSON file we've
     *  been accumulating. Either way, cached icons skip the expensive runtime render. */
    private async loadPersistedIcons(): Promise<void> {
        try {
            const icons: Record<string, string> | undefined =
                await (window as any).electron?.ipcRenderer?.invoke('worldmap:load-icons');
            if (!icons) return;
            for (const key of Object.keys(icons)) {
                const img = new Image();
                img.src = icons[key];
                this.iconCache.set(key, img);
            }
            this.info(`icons: loaded ${Object.keys(icons).length} from cache`);
        } catch { /* ignore */ }
    }

    private parseModelTables(): void {
        this.objModelFiles = new Map();
        this.npcModelFiles = new Map();
        const src: string = (window as any).__eqSourceCode || '';
        for (const m of src.matchAll(/\{defId:(\d+),files:\[([^\]]*)\]/g)) {
            const id = Number(m[1]);
            const first = (m[2].match(/"([^"]+\.glb)"/i) || [])[1];
            if (first && !this.objModelFiles.has(id)) this.objModelFiles.set(id, first);
        }
        // NPC model table (`pp`): most use `file:"…glb"`, but some (e.g. skeleton #5)
        // use `modelPath:"…glb"`. Humanoid NPCs have NEITHER (assembled from equipment).
        for (const m of src.matchAll(/(\d+):\{[^{}]*?(?:file|modelPath):"([^"]+\.glb)"/gi)) {
            const id = Number(m[1]);
            if (!this.npcModelFiles.has(id)) this.npcModelFiles.set(id, m[2]);
        }
        // Drop any nulls cached before the tables existed (see modelFileFor).
        this.modelFileCache.clear();
    }

    private resolveModelUrl(file: string): string {
        // Mirror the game's own loader: paths starting with "/" are used as-is
        // (e.g. "/assets/models/oaktree.glb", "/models/npcs/cow.glb"); a BARE filename
        // resolves against the "/models/" root — NOT "/assets/models/" (that 404s).
        const origin = 'https://evilquest.net';
        if (/^https?:/i.test(file)) return file;
        // Encode each path segment (some model files have spaces, e.g. "maple tree.glb"),
        // matching the game's own loader, without double-encoding already-encoded names.
        const enc = file.split('/').map((s) => (/%[0-9a-f]{2}/i.test(s) ? s : encodeURIComponent(s))).join('/');
        if (file.startsWith('/')) return origin + enc;
        return origin + '/models/' + enc;
    }

    /** Find the first `.glb` path anywhere in a def object (handles unknown field
     *  names + nested arrays/objects, so it survives EvilQuest renaming fields). */
    private findGlb(def: any, depth = 0): string | null {
        if (!def || typeof def !== 'object' || depth > 2) return null;
        const isGlb = (s: any) => typeof s === 'string' && /\.glb(\?|#|$)/i.test(s);
        // Prefer direct string fields first (model/file/files), then descend.
        for (const v of Object.values(def)) if (isGlb(v)) return v as string;
        for (const v of Object.values(def)) {
            if (Array.isArray(v)) {
                for (const e of v) {
                    if (isGlb(e)) return e as string;
                    const f = this.findGlb(e, depth + 1);
                    if (f) return f;
                }
            } else if (v && typeof v === 'object') {
                const f = this.findGlb(v, depth + 1);
                if (f) return f;
            }
        }
        return null;
    }

    /** Model file for a marker — live cached def first (authoritative, update-proof),
     *  then the regex-parsed source tables as a fallback. Returns null if the def
     *  isn't loaded yet (so we retry) or genuinely has no model (cached, falls back
     *  to a shape). */
    private modelFileFor(kind: 'obj' | 'npc', defId: number): string | null {
        const key = `${kind}:${defId}`;
        if (this.modelFileCache.has(key)) return this.modelFileCache.get(key)!;
        let def: any = null;
        try {
            def = kind === 'obj'
                ? this.gm?.objectDefsCache?.get(defId)
                : this.gm?.entities?.npcDefsCache?.get(defId);
        } catch { /* ignore */ }
        if (!def) return null; // def not loaded yet — don't cache, retry next frame
        const table = kind === 'obj' ? this.objModelFiles : this.npcModelFiles;
        // Don't cache a null before the model tables are parsed, or we'd permanently
        // poison the cache (this is what broke NPC icons: isModelless() calls this every
        // frame, including during the async icon-system init before parseModelTables ran).
        if (!table) return null;
        const file = this.findGlb(def) ?? table.get(defId) ?? null;
        this.modelFileCache.set(key, file);
        return file;
    }

    private probedObjCats = new Set<string>();
    private probeDeadline = 0;
    /** Log assetId/regPath for each object category the first time one of its meshes
     *  loads nearby (so we can confirm e.g. whether altars have a model at all). */
    private probeNewObjectCategories() {
        if (this.probeDeadline === 0) this.probeDeadline = performance.now() + 120000; // 2-min window
        if (performance.now() > this.probeDeadline) return;
        const wod = this.gm?.worldObjectDefs;
        const models = this.getWorldObjectModels();
        const defs = this.gm?.objectDefsCache;
        if (!wod || !models) return;
        let scanned = 0;
        for (const [k, r] of wod) {
            if (++scanned > 4000) break;
            const cat = (defs?.get(r?.defId)?.category ?? '') + '';
            if (!cat || this.probedObjCats.has(cat)) continue;
            const mdl = models.get(k);
            if (!mdl) continue;
            this.probedObjCats.add(cat);
            const aid = this.assetIdFromModel(mdl);
            this.sendDiag(`OBJPROBE cat=${cat} defName=${defs?.get(r?.defId)?.name} placedName=${mdl?.metadata?.placedName} assetId=${aid} regPath=${this.objAssetFile(aid)}`);
        }
    }

    /** One-shot dump of real def shapes so we can see where trees/humans keep their
     *  model (logged via eq-diag → main process). Fires once after defs are loaded. */
    private dumpModelDiag() {
        if (this.diagDumped) return;
        this.diagDumped = true;
        // Confirm the placed-object record shape (where assetId lives) + registry wiring.
        try {
            const wod: Map<any, any> | undefined = this.gm?.worldObjectDefs;
            const rec = wod?.values?.().next?.().value;
            const reg = this.getAssetRegistry();
            this.sendDiag(`PLACEDREC keys=[${rec ? Object.keys(rec).join(',') : 'none'}] metaKeys=[${rec?.metadata ? Object.keys(rec.metadata).join(',') : 'none'}] assetId=${rec?.metadata?.assetId ?? rec?.assetId} registry=${!!reg} regSize=${reg?.size}`);
            // Probe the worldObjectModels join: one loaded model per category (so we
            // can see Altar / scenery / etc., not just whichever loads first).
            const models = this.getWorldObjectModels();
            const defsC = this.gm?.objectDefsCache;
            const seenProbeCat = new Set<string>();
            if (wod && models) {
                for (const [k, r] of wod) {
                    const mdl = models.get(k);
                    if (!mdl) continue;
                    const cat = (defsC?.get(r?.defId)?.category ?? '?') + '';
                    if (seenProbeCat.has(cat)) continue;
                    seenProbeCat.add(cat);
                    const aid = this.assetIdFromModel(mdl);
                    this.sendDiag(`WOMODEL cat=${cat} name=${defsC?.get(r?.defId)?.name} assetId=${aid} regPath=${this.objAssetFile(aid)}`);
                    if (seenProbeCat.size >= 14) break;
                }
            }
            this.sendDiag(`WOMODELS size=${models?.size ?? 'none'}`);
            // NPC lookup sanity.
            this.sendDiag(`TABLES obj=${this.objModelFiles?.size} npc=${this.npcModelFiles?.size} live=${this.liveNpcs.length} | cow10=${this.modelFileFor('npc', 10)} chicken1=${this.modelFileFor('npc', 1)} bull24=${this.modelFileFor('npc', 24)}`);
        } catch (e: any) { this.sendDiag(`PLACEDREC err ${e?.message || e}`); }
        const seenCat = new Set<string>();
        for (const o of this.objectStore.values()) {
            if (seenCat.has(o.category)) continue;
            seenCat.add(o.category);
            const def = this.gm?.objectDefsCache?.get(o.defId);
            const glb = this.findGlb(def);
            this.sendDiag(`OBJDEF ${o.category}/${o.name} #${o.defId} glb=${glb} keys=[${def ? Object.keys(def).join(',') : 'none'}]`);
            if (def && !glb) this.sendDiag(`  OBJRAW ${JSON.stringify(def).slice(0, 600)}`);
        }
        let n = 0;
        for (const [defId, m] of this.npcStore) {
            if (n++ > 8) break;
            const first = m.values().next().value;
            const def = this.gm?.entities?.npcDefsCache?.get(defId);
            const glb = this.findGlb(def);
            this.sendDiag(`NPCDEF ${first?.name} #${defId} glb=${glb} keys=[${def ? Object.keys(def).join(',') : 'none'}]`);
            if (def && !glb) this.sendDiag(`  NPCRAW ${JSON.stringify(def).slice(0, 600)}`);
        }
    }

    /** The game's asset registry: assetId -> { path } (the real placed-object model). */
    private getAssetRegistry(): Map<any, any> | null {
        return this.gm?.chunkManager?.assetRegistry ?? this.gm?.assetRegistry ?? null;
    }
    /** worldObjectKey -> loaded model node (whose metadata.assetId we want). */
    private getWorldObjectModels(): Map<any, any> | null {
        return this.gm?.worldObjectModels ?? this.gm?.chunkManager?.worldObjectModels ?? null;
    }
    /** Pull assetId off a loaded world-object model node (root, parent, or a child). */
    private assetIdFromModel(model: any): string {
        if (!model) return '';
        let a = model.metadata?.assetId ?? model.parent?.metadata?.assetId;
        if (!a && typeof model.getChildMeshes === 'function') {
            for (const c of model.getChildMeshes(false)) { if (c?.metadata?.assetId) { a = c.metadata.assetId; break; } }
        }
        return typeof a === 'string' ? a : '';
    }
    private objAssetFile(assetId: string): string | null {
        if (!assetId) return null;
        const path = this.getAssetRegistry()?.get(assetId)?.path;
        if (typeof path !== 'string' || !/\.glb(\?|#|$)/i.test(path)) return null;
        // Force origin-absolute so it resolves against the site root, not our
        // /__evillite__/client.html document base (registry paths may be bare).
        return /^https?:/i.test(path) || path.startsWith('/') ? path : '/' + path;
    }

    /** Ready icon for an arbitrary key, or null — queuing a render on first miss.
     *  `resolveFile` is only called on a miss, lazily. */
    private iconFor(key: string, resolveFile: () => string | null): HTMLImageElement | null {
        if (!this.iconsEnabled) return null;
        const cached = this.iconCache.get(key);
        if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
        if (this.iconFailed.has(key) || this.iconPending.has(key)) return null;
        if (this.bjsState === 'idle') { void this.initIconSystem(); return null; }
        if (this.bjsState !== 'ready') return null;
        const file = resolveFile();
        // No file: registry/def not loaded yet OR genuinely model-less. Don't mark
        // failed — fall back to a shape/parent icon and retry as data streams in.
        if (!file) return null;
        this.iconPending.add(key);
        this.iconQueue.push({ key, file });
        void this.processIconQueue();
        return null;
    }

    /** Object icon, keyed by assetId (its real model identity); falls back to the
     *  legacy defId model table for the few objects defined that way (trees). */
    /** Longest common leading substring across the given strings. */
    private commonPrefix(arr: string[]): string {
        if (!arr.length) return '';
        let p = arr[0];
        for (const s of arr) {
            let i = 0;
            while (i < p.length && i < s.length && p[i] === s[i]) i++;
            p = p.slice(0, i);
            if (!p) break;
        }
        return p;
    }

    private getObjectIcon(o: MapObject): HTMLImageElement | null {
        let assetId = o.assetId;
        // Coverage: if this object's mesh hasn't loaded near us yet (no assetId) but every
        // object of its defId we HAVE seen uses one consistent model (e.g. all "Wheat Plant"
        // → Wheat2Rotated1), reuse it. Grab-bag defIds (scenery → many models) map to several
        // assetIds, so they don't guess and fall through to a shape.
        if (!assetId) {
            const seen = this.defIdAssets.get(o.defId);
            if (seen && seen.size) {
                if (seen.size === 1) {
                    assetId = seen.values().next().value!;
                } else {
                    // Multiple models for this defId: reuse one only if they're clearly
                    // VARIANTS of the same thing (share a long common name prefix, e.g.
                    // Wheat2Rotated1/2/3) — not a grab-bag (Crate1, Bed1, Bush1 → no prefix).
                    const arr = [...seen];
                    if (this.commonPrefix(arr).length >= 4) assetId = arr[0];
                }
            }
        }
        const key = assetId ? 'obj:' + assetId : 'objdef:' + o.defId;
        const icon = this.iconFor(key, () => this.objAssetFile(assetId) ?? this.objModelFiles?.get(o.defId) ?? null);
        if (icon) {
            this.catRepIcon.set(o.category, icon);
            this.nameRepIcon.set(o.category + ' ' + o.name, icon);
        }
        return icon;
    }
    // Equipment-assembled humanoid NPCs (bankers, farmers, shopkeepers, vampires,
    // skeleton warriors, custom humanoids…) carry NO model file. The game builds them
    // from this generic base body (per the ThumbnailRenderer), so we render it once and
    // share it as their icon — a real 3D person instead of a flat glyph.
    private static readonly HUMANOID_MODEL = '/Character models/main character.glb';

    private getNpcIcon(defId: number): HTMLImageElement | null {
        const file = this.modelFileFor('npc', defId);
        if (file) return this.iconFor('npc:' + defId, () => file);
        // No specific model, but the def IS loaded → it's a humanoid: shared body icon.
        const def = this.gm?.entities?.npcDefsCache?.get(defId);
        if (def) return this.iconFor('npc:__humanoid__', () => WorldMapPlugin.HUMANOID_MODEL);
        return null;
    }

    /** Hard cap on queued renders — prevents OOM when many objects become visible at once. */
    private static readonly MAX_ICON_QUEUE = 40;

    private async processIconQueue(): Promise<void> {
        if (this.iconRendering || !this.bjs) return;
        this.iconRendering = true;
        try {
            while (this.iconQueue.length) {
                // Trim queue if it grew too large (new objects all visible at once on first load).
                // Drop from the tail so the nearest/most-needed items (pushed first) render first.
                if (this.iconQueue.length > WorldMapPlugin.MAX_ICON_QUEUE) {
                    const dropped = this.iconQueue.splice(WorldMapPlugin.MAX_ICON_QUEUE);
                    for (const d of dropped) this.iconPending.delete(d.key);
                }
                const { key, file } = this.iconQueue.shift()!;
                try {
                    const dataUrl = await this.renderModel(this.resolveModelUrl(file));
                    if (dataUrl) {
                        const img = new Image();
                        img.src = dataUrl;
                        this.iconCache.set(key, img);
                        // Report to main so the dev cache accumulates this icon for the build.
                        try { (window as any).electron?.ipcRenderer?.send('worldmap:save-icon', key, dataUrl); } catch { /* ignore */ }
                    } else this.iconFailed.add(key);
                } catch (e: any) {
                    this.iconFailed.add(key);
                    this.lastIconDiag = `ERR ${key} ${file}: ${e?.message || e}`;
                    this.sendDiag(`QUEUE-ERR ${key} ${file}: ${e?.message || e} :: ${(e?.stack || '').slice(0, 300)}`);
                } finally {
                    this.iconPending.delete(key);
                }
            }
        } finally {
            this.iconRendering = false;
        }
    }

    private sendDiag(m: string) {
        try { (window as any).electron?.ipcRenderer?.send('eq-diag', m); } catch { /* ignore */ }
    }

    private async renderModel(fullUrl: string): Promise<string | null> {
        const { SceneLoader, SceneClass, EngineClass, Vector3, ArcRotateCamera } = this.bjs!;
        const slash = fullUrl.lastIndexOf('/');
        const rootUrl = fullUrl.slice(0, slash + 1);
        const fileName = fullUrl.slice(slash + 1);
        const SIZE = 128;
        this.sendDiag(`render START ${fileName} SceneCtor:${!!SceneClass} EngineCtor:${!!EngineClass}`);

        // A dedicated offscreen engine on its own canvas. We read the result with a
        // plain canvas.toDataURL() — NO RenderTargetTexture, NO screenshot helper, so
        // none of Babylon's post-process "pass" shaders are involved (those are what
        // throw "postProcessManager null"). preserveDrawingBuffer lets us read after render.
        if (!this.offEngine) {
            try {
                this.offCanvas = document.createElement('canvas');
                this.offCanvas.width = SIZE; this.offCanvas.height = SIZE;
                this.offEngine = new EngineClass(this.offCanvas, true, { preserveDrawingBuffer: true, stencil: false, alpha: true });
                this.sendDiag(`offEngine created ok webgl=${this.offEngine?.webGLVersion ?? '?'}`);
            } catch (e: any) {
                this.sendDiag(`offEngine FAILED: ${e?.message || e}`);
                throw e;
            }
        }

        let scene: any = null;
        try {
            scene = new SceneClass(this.offEngine);
            const Color4 = scene.clearColor.constructor;
            try { scene.clearColor = new Color4(0, 0, 0, 0); } catch { /* keep default */ }
            this.sendDiag(`importing ${fileName} from ${rootUrl}`);
            const res = await SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene);
            // Only meshes with real geometry (skip the ImportMesh "__root__" transform node,
            // which has no bounds and skews the camera framing).
            const meshes = (res?.meshes ?? []).filter((m: any) => (m?.getTotalVertices?.() ?? 0) > 0);
            this.lastIconDiag = `${fileName} meshes:${res?.meshes?.length ?? 0}/${meshes.length}`;
            if (!meshes.length) return null;
            for (const m of meshes) { try { m.isVisible = true; m.visibility = 1; m.setEnabled?.(true); } catch { /* ignore */ } }

            // Make every material self-lit so it renders WITHOUT a light, regardless of
            // material type (PBR unlit, Standard disableLighting, or anything else → drive
            // emissive from the base colour/texture). Some models (sacks, wheat) use material
            // types our old PBR/Standard-only handling missed → they rendered fully transparent.
            for (const mat of scene.materials) {
                try {
                    mat.backFaceCulling = false; // flat billboards show from both sides
                    if ('unlit' in mat) mat.unlit = true;
                    if ('disableLighting' in mat) mat.disableLighting = true;
                    const baseTex = mat.albedoTexture ?? mat.diffuseTexture ?? mat.emissiveTexture;
                    if (baseTex && 'emissiveTexture' in mat) mat.emissiveTexture = baseTex;
                    const baseCol = mat.albedoColor ?? mat.diffuseColor;
                    if (baseCol && 'emissiveColor' in mat) mat.emissiveColor = baseCol.clone ? baseCol.clone() : baseCol;
                    if ('emissiveIntensity' in mat) mat.emissiveIntensity = 1;
                } catch { /* ignore */ }
            }
            // Belt-and-suspenders: add a default light if this Babylon build offers it
            // (helps any material we couldn't force self-lit).
            try { scene.createDefaultLight?.(true); } catch { /* not available — emissive covers it */ }

            // Build an ArcRotate camera ourselves (the createDefaultCameraOrLight helper
            // isn't in the game's tree-shaken Babylon) and frame it on the model.
            // alpha = +π/2 + 0.6 looks at the model's FRONT (a plain -π/2 showed its back —
            // "we saw their butts"); slight beta tilt gives a clean 3/4 view.
            const cam = new ArcRotateCamera('eqIconCam', Math.PI / 2 + 0.6, 1.15, 10, Vector3.Zero(), scene);
            scene.activeCamera = cam;
            cam.minZ = 0.001; cam.maxZ = 100000; // never clip the model (near/far planes)

            await Promise.race([
                typeof scene.whenReadyAsync === 'function' ? scene.whenReadyAsync() : Promise.resolve(),
                new Promise((r) => setTimeout(r, 5000)),
            ]);

            // Manually frame on the meshes' combined world bounds (robust where zoomOn
            // misbehaves — a single mesh with an odd pivot left the camera looking at nothing).
            let center = Vector3.Zero();
            let bRadius = 1;
            try {
                let min: any = null, max: any = null;
                for (const m of meshes) {
                    m.computeWorldMatrix?.(true);
                    const bb = m.getBoundingInfo?.().boundingBox;
                    if (!bb) continue;
                    const lo = bb.minimumWorld, hi = bb.maximumWorld;
                    if (!min) { min = lo.clone(); max = hi.clone(); }
                    else { min.minimizeInPlace?.(lo); max.maximizeInPlace?.(hi); }
                }
                if (min && max) {
                    center = min.add(max).scale(0.5);
                    bRadius = Math.max(max.subtract(min).length() / 2, 0.05);
                }
            } catch { /* fall back to defaults */ }

            const renderAt = (alpha: number, beta: number): string => {
                cam.target = center.clone ? center.clone() : center;
                cam.alpha = alpha; cam.beta = beta;
                cam.radius = bRadius * 2.6;
                for (let i = 0; i < 3; i++) { try { scene.render(); } catch { /* ignore */ } }
                return this.offCanvas!.toDataURL('image/png');
            };

            // First, the default 3/4 front view. Flat billboards (wheat, signs…) can be
            // near edge-on there → blank render; if so, try other azimuths/tilts and keep
            // the fullest result (largest PNG = most visible content).
            let best = renderAt(Math.PI / 2 + 0.6, 1.15);
            if (best.length < 1500) {
                for (const [a, b] of [[0.6, 1.15], [Math.PI + 0.6, 1.15], [-Math.PI / 2 + 0.6, 1.15], [Math.PI / 2 + 0.6, 0.35]] as [number, number][]) {
                    const url = renderAt(a, b);
                    if (url.length > best.length) best = url;
                    if (best.length >= 2500) break;
                }
            }
            this.lastIconDiag += ` len:${best.length}`;
            this.sendDiag(`toDataURL len:${best.length}`);
            if (best.length < 900) {
                // Still blank — log what we had so we can see why (material types, bounds).
                try {
                    const mats = scene.materials.map((m: any) => m?.getClassName?.() ?? typeof m).join(',');
                    this.sendDiag(`BLANK ${fileName} meshes=${meshes.length} mats=[${mats}] bRadius=${bRadius.toFixed(3)} center=${center.x?.toFixed(2)},${center.y?.toFixed(2)},${center.z?.toFixed(2)}`);
                } catch { /* ignore */ }
                return null;
            }
            return best;
        } finally {
            try { scene?.dispose(); } catch { /* ignore */ }
        }
    }

    private mmIconCache = new Map<string, HTMLImageElement | null>();

    private getMmIcon(iconName: string): HTMLImageElement | null {
        if (!iconName) return null;
        if (this.mmIconCache.has(iconName)) return this.mmIconCache.get(iconName)!;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onerror = () => { this.mmIconCache.set(iconName, null); };
        img.src = `https://evilquest.net/minimap/icons/${encodeURIComponent(iconName)}`;
        this.mmIconCache.set(iconName, img);
        return img;
    }

    // ── Minimap marker layer ──────────────────────────────────────────────────────
    private drawMinimapMarkers(ctx: CanvasRenderingContext2D, dw: number, dh: number, srcLeft: number, srcTop: number, z: number) {
        const pad = 20;
        for (const m of this.minimapMarkers) {
            if ((m as any).floor !== undefined && (m as any).floor !== this.currentFloor) continue;
            const sx = (m.x + 0.5 - srcLeft) * z;
            const sy = (m.z + 0.5 - srcTop) * z;
            if (sx < -pad || sx > dw + pad || sy < -pad || sy > dh + pad) continue;

            const u = Math.max(8, Math.min(32, m.size));
            const img = this.getMmIcon(m.icon);
            if (img && img.complete && img.naturalWidth > 0) {
                // Game minimap uses the icon, plus it draws a subtle shadow/bg arc
                ctx.save();
                ctx.globalAlpha = 0.7;
                ctx.fillStyle = "rgba(0, 0, 0, 0.68)";
                ctx.beginPath();
                ctx.arc(sx, sy, u * 0.55, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
                ctx.drawImage(img, sx - u / 2, sy - u / 2, u, u);
            } else {
                this.drawStar(ctx, sx, sy, 7, m.color);
            }

            const hitRadius = (img && img.complete && img.naturalWidth > 0) ? u / 2 : 9;
            this.hitTargets.push({ sx, sy, r: hitRadius, label: m.label || m.icon || 'Marker', sub: `Minimap marker • ${m.x},${m.z}`, wx: m.x + 0.5, wz: m.z + 0.5 });
        }
    }

    /** 5-pointed star marker for minimap POIs. */
    private drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
            const a = (i * Math.PI) / 5 - Math.PI / 2;
            const d = i % 2 === 0 ? r : r * 0.42;
            const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    /** Small red count badge for tiles holding more than one object. */
    private drawCountBadge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, n: number) {
        const bx = x + r * 0.7, by = y - r * 0.7;
        ctx.save();
        ctx.beginPath();
        ctx.arc(bx, by, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#c0392b';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n > 9 ? '9+' : String(n), bx, by);
        ctx.restore();
    }

    private drawIcon(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, size: number, alpha: number) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 2;
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
        ctx.restore();
    }

    private drawMarkers(ctx: CanvasRenderingContext2D, dw: number, dh: number, srcLeft: number, srcTop: number, z: number) {
        this.hitTargets = [];
        const pad = 16;
        const baseR = Math.max(3, Math.min(z * 0.55, 9));
        const showLabels = this.labelsEnabled && z >= 6;
        const q = this.searchStr;

        const inView = (sx: number, sy: number) => sx >= -pad && sx <= dw + pad && sy >= -pad && sy <= dh + pad;

        // Label de-dup: skip a label if the SAME text is already drawn nearby, so dense
        // fields (340 "Wheat Plant"s) don't turn into overlapping text soup.
        const drawnLabels: { x: number; y: number; text: string }[] = [];
        const labelOnce = (text: string, x: number, y: number, color = '#fff') => {
            for (const d of drawnLabels) {
                if (d.text === text && Math.abs(d.x - x) < 110 && Math.abs(d.y - y) < 26) return;
            }
            drawnLabels.push({ x, y, text });
            this.drawLabel(ctx, text, x, y, color);
        };

        // 1) NPC sightings (faded), under everything — now with the creature's icon
        //    (or person glyph for humanoids), falling back to a dot.
        if (this.showNpcSightings) {
            for (const [defId, m] of this.npcStore) {
                const first = m.values().next().value;
                const name = first?.name ?? '';
                if (this.disabledNames.has(`${WorldMapPlugin.NPC_CAT}:${name}`) || this.disabledCats.has(WorldMapPlugin.NPC_CAT)) continue;
                if (q && !name.toLowerCase().includes(q)) continue;
                const icon = this.getNpcIcon(defId);                 // also queues the render
                const modelless = !icon && this.isModelless('npc', defId);
                const useIcon = icon && z >= 2.5;                    // dots when zoomed far (perf)
                const sz = Math.max(11, Math.min(z * 1.6, 24));
                ctx.fillStyle = 'rgba(255,90,90,0.28)';
                for (const s of m.values()) {
                    // Skip if there is a live NPC of this def right here (avoid double).
                    if (this.liveNpcKeys.has(`${defId}:${s.x},${s.z}`)) continue;
                    if ((s as any).floor !== undefined && (s as any).floor !== this.currentFloor) continue;
                    const sx = (s.x + 0.5 - srcLeft) * z, sy = (s.z + 0.5 - srcTop) * z;
                    if (!inView(sx, sy)) continue;
                    if (useIcon) this.drawIcon(ctx, icon!, sx, sy, sz, 0.5);
                    else if (modelless && z >= 2.5) this.drawPerson(ctx, sx, sy, Math.max(3, baseR * 0.7), '#f0a060', 0.5);
                    else { ctx.beginPath(); ctx.arc(sx, sy, Math.max(2, baseR * 0.5), 0, Math.PI * 2); ctx.fill(); }
                }
            }
        }

        // 2) Objects — grouped per tile so stacked objects don't fight: one marker per
        //    tile at its exact coordinate, with a count badge when several share it.
        const tileGroups = new Map<string, MapObject[]>();
        for (const o of this.objectStore.values()) {
            if (o.floor !== undefined && o.floor !== this.currentFloor) continue;
            if (!this.nameEnabled(o.category, o.name)) continue;
            if (q && !(o.name.toLowerCase().includes(q) || o.category.toLowerCase().includes(q))) continue;
            const tk = `${o.x},${o.z},${o.floor}`;
            let arr = tileGroups.get(tk);
            if (!arr) { arr = []; tileGroups.set(tk, arr); }
            arr.push(o);
        }
        for (const group of tileGroups.values()) {
            // Render/queue every member's icon (keeps the cache complete) and pick a
            // representative — prefer one whose icon is already rendered.
            let rep = group[0];
            for (const g of group) { if (this.getObjectIcon(g)) rep = g; }
            const o = rep;
            const sx = (o.x + 0.5 - srcLeft) * z, sy = (o.z + 0.5 - srcTop) * z;
            if (!inView(sx, sy)) continue;

            // ONLY the object's own model icon on the map — never a borrowed category
            // icon. While it's still rendering (or its mesh hasn't loaded near yet) show a
            // neutral placeholder dot. (The borrowed category icon churning between scenery
            // models was the bed↔bush flashing.)
            const icon = this.getObjectIcon(o);
            let hitR = baseR;
            if (icon) {
                const s = Math.max(24, Math.min(z * 3.0, 50));
                this.drawIcon(ctx, icon, sx, sy, s, o.depleted ? 0.45 : 1);
                hitR = s / 2;
            } else {
                // Own icon not ready (or no model): a stable category-coloured shape — never
                // a borrowed model icon (that was the flashing).
                this.drawShape(ctx, this.catShape(o.category), sx, sy, baseR, this.catColor(o.category), o.depleted ? 0.4 : 1);
            }
            if (group.length > 1) this.drawCountBadge(ctx, sx, sy, hitR, group.length);

            const label = group.length > 1 ? `${this.prettify(o.name)} +${group.length - 1}` : this.prettify(o.name);
            const sub = group.length > 1
                ? group.map((g) => this.prettify(g.name)).join(', ').slice(0, 90) + ` • ${o.x},${o.z}`
                : `${this.prettify(o.category)} • ${o.x},${o.z}${o.depleted ? ' • depleted' : ''}`;
            this.hitTargets.push({ sx, sy, r: hitR, label, sub, wx: o.x + 0.5, wz: o.z + 0.5 });
            if (showLabels) labelOnce(label, sx, sy - hitR - 2);
        }

        // 3) Live NPCs (bright), with combat level.
        if (this.showLiveNpcs) {
            for (const n of this.liveNpcs) {
                if (n.floor !== undefined && n.floor !== this.currentFloor) continue;
                if (this.disabledNames.has(`${WorldMapPlugin.NPC_CAT}:${n.name}`) || this.disabledCats.has(WorldMapPlugin.NPC_CAT)) continue;
                if (q && !n.name.toLowerCase().includes(q)) continue;
                const sx = (n.x - srcLeft) * z, sy = (n.z - srcTop) * z;
                if (!inView(sx, sy)) continue;
                const icon = this.getNpcIcon(n.defId);
                let hitR = baseR + 1;
                if (icon) {
                    const s = Math.max(16, Math.min(z * 2.1, 34));
                    // Mobile creatures: just the model, NO ring (rings are for static nodes).
                    this.drawIcon(ctx, icon, sx, sy, s, 1);
                    hitR = s / 2;
                } else if (this.isModelless('npc', n.defId)) {
                    // Humanoid NPC (no standalone model — assembled from equipment):
                    // a clean person silhouette instead of a 3D thumbnail.
                    this.drawPerson(ctx, sx, sy, baseR + 1, '#f0a060', 1);
                } else {
                    // Animal whose model just hasn't finished rendering yet.
                    this.drawShape(ctx, 'triangle', sx, sy, baseR + 1, '#ff5555', 1);
                }
                this.hitTargets.push({ sx, sy, r: hitR, label: this.prettify(n.name), sub: `NPC${n.level != null ? ` • lvl ${n.level}` : ''} • ${Math.round(n.x)},${Math.round(n.z)}`, wx: n.x, wz: n.z });
                if (showLabels) labelOnce(`${this.prettify(n.name)}${n.level != null ? ` (${n.level})` : ''}`, sx, sy - hitR - 3);
            }
        }

        // 4) Players.
        if (this.showPlayers) {
            for (const p of this.players) {
                const sx = (p.x - srcLeft) * z, sy = (p.z - srcTop) * z;
                if (!inView(sx, sy)) continue;
                ctx.beginPath(); ctx.arc(sx, sy, baseR * 0.8, 0, Math.PI * 2);
                ctx.fillStyle = '#5dd5ff'; ctx.fill();
                ctx.lineWidth = 1; ctx.strokeStyle = '#0a3a4a'; ctx.stroke();
                if (p.name && showLabels) labelOnce(p.name, sx, sy - baseR - 2, '#bdecff');
                this.hitTargets.push({ sx, sy, r: baseR, label: p.name || 'Player', sub: `Player • ${Math.round(p.x)},${Math.round(p.z)}`, wx: p.x, wz: p.z });
            }
        }
    }

    /** True if the def is loaded but has no renderable model (e.g. equipment-assembled
     *  humanoid NPCs). Used to pick a person glyph over a "still loading" placeholder. */
    private isModelless(kind: 'obj' | 'npc', defId: number): boolean {
        const def = kind === 'obj'
            ? this.gm?.objectDefsCache?.get(defId)
            : this.gm?.entities?.npcDefsCache?.get(defId);
        return !!def && !this.modelFileFor(kind, defId);
    }

    /** A simple person silhouette (head + shoulders) for humanoid NPCs. */
    private drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        // head
        ctx.beginPath();
        ctx.arc(x, y - r * 0.55, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // shoulders/body
        ctx.beginPath();
        ctx.moveTo(x - r * 0.75, y + r);
        ctx.quadraticCurveTo(x, y - r * 0.15, x + r * 0.75, y + r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    private drawShape(ctx: CanvasRenderingContext2D, shape: 'circle' | 'square' | 'diamond' | 'triangle', x: number, y: number, r: number, color: string, alpha: number) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (shape === 'circle') {
            ctx.arc(x, y, r, 0, Math.PI * 2);
        } else if (shape === 'square') {
            ctx.rect(x - r, y - r, r * 2, r * 2);
        } else if (shape === 'diamond') {
            ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        } else {
            ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    private drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#fff') {
        ctx.save();
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    private drawDestinationMarker(ctx: CanvasRenderingContext2D, x: number, y: number, animTime: number) {
        const s = animTime;
        const n = (Math.sin(s * 8) + 1) * 0.5;
        const o = Math.max(0, 1 - s / 0.55);
        ctx.save();
        ctx.translate(x, y);
        ctx.lineJoin = 'round';
        if (o > 0) {
            ctx.globalAlpha = 0.65 * o;
            ctx.strokeStyle = '#fff0b8';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 7 + (1 - o) * 17, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.globalAlpha = 0.26 + n * 0.2;
        ctx.strokeStyle = '#ffdf64';
        ctx.lineWidth = 1.75;
        ctx.shadowColor = 'rgba(255, 210, 80, 0.55)';
        ctx.shadowBlur = 3 + n * 2;
        ctx.beginPath();
        ctx.arc(0, 0, 7.5 + n * 1.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.lineCap = 'square';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.lineTo(0, 0);
        ctx.stroke();
        ctx.strokeStyle = '#f7ead1';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, -17);
        ctx.lineTo(0, 0);
        ctx.stroke();
        ctx.fillStyle = '#d8372b';
        ctx.strokeStyle = '#230b07';
        ctx.lineWidth = 1.25;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 2;
        ctx.beginPath();
        ctx.moveTo(1, -17);
        ctx.lineTo(10, -14);
        ctx.lineTo(1, -10);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    private drawPlayerMarker(ctx: CanvasRenderingContext2D, x: number, y: number) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#000';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = '#2ecc71';
        ctx.fill();
    }

    private updateTooltip() {
        if (!this.tooltipEl) return;
        if (!this.hoverPos) { this.tooltipEl.style.display = 'none'; return; }
        const hit = this.pickHit(this.hoverPos.x, this.hoverPos.y);
        if (!hit) { this.tooltipEl.style.display = 'none'; return; }
        this.tooltipEl.style.display = 'block';
        this.tooltipEl.style.left = `${this.hoverPos.x}px`;
        this.tooltipEl.style.top = `${this.hoverPos.y}px`;
        this.tooltipEl.innerHTML = `<b>${hit.label}</b><br><span style="opacity:0.75">${hit.sub}</span>`;
    }

    private jumpToNearestMatch() {
        const q = this.searchStr;
        if (!q) return;
        const player = this.getPlayerPos() ?? { x: this.centerX, z: this.centerZ };
        let best: { x: number; z: number } | null = null, bestD = Infinity;
        const consider = (x: number, z: number) => {
            const d = (x - player.x) ** 2 + (z - player.z) ** 2;
            if (d < bestD) { bestD = d; best = { x, z }; }
        };
        for (const o of this.objectStore.values()) {
            if (this.nameEnabled(o.category, o.name) && (o.name.toLowerCase().includes(q) || o.category.toLowerCase().includes(q))) consider(o.x, o.z);
        }
        for (const n of this.liveNpcs) if (n.name.toLowerCase().includes(q)) consider(n.x, n.z);
        if (this.showNpcSightings) {
            for (const m of this.npcStore.values()) {
                const first = m.values().next().value;
                if (first && first.name.toLowerCase().includes(q)) for (const s of m.values()) consider(s.x, s.z);
            }
        }
        if (best) {
            this.centerX = (best as { x: number; z: number }).x;
            this.centerZ = (best as { x: number; z: number }).z;
            this.followPlayer = false;
            this.zoom = Math.max(this.zoom, 10);
        }
    }

    private setStatus(text: string) {
        if (this.statusEl) this.statusEl.innerText = text;
    }
}
