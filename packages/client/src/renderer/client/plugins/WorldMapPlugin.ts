import { Plugin } from '@evillite/core/src/interfaces/highlite/plugin/plugin.class';
import { SettingsTypes, type PluginSettings } from '@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface';
import { PluginAssetCache } from '@evillite/core/src/utilities/pluginAssetCache';
import { ModelIconCache } from '@evillite/core/src/utilities/modelIconCache';

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
    floor?: number;   // floor the NPC was seen on (added later; old saves lack it → treated as 0)
    seen?: number;    // last-seen timestamp (Date.now()); newest wins for "last-known position"
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
        popoutMode: {
            text: 'Open Chat Links in Popout Window',
            type: SettingsTypes.checkbox,
            value: true,
        },
    };

    // ── DOM ─────────────────────────────────────────────────────────────────────
    private statusEl: HTMLDivElement | null = null;

    // ── Offscreen terrain canvas (1px per tile) ───────────────────────────────────
    private worldCanvas: HTMLCanvasElement | null = null;
    private worldCtx: CanvasRenderingContext2D | null = null;
    private worldW = 0;
    private worldH = 0;
    private worldWalls = new Uint8Array(0);
    // Per-tile terrain colour, 0=unpainted else (0xFF<<24)|(r<<16)|(g<<8)|b. The SOURCE OF TRUTH for
    // terrain: it only ever accumulates real rendered tiles (like worldWalls), is what we persist,
    // and never erodes. The canvas + API fill are just a render of it. Avoids the old raster-snapshot
    // erosion (a flat frame, the seed/API race, or the downgrade guard degrading the saved map).
    private worldTerrain = new Uint32Array(0);
    private terrainSeeded = false; // true once worldTerrain has been restored from cache (or there's none) — gates persist so a partial pre-seed map can't overwrite a full saved one
    // Invalidates in-flight async terrain seeds when the canvas is recreated (floor/size change).
    private worldSeedToken = 0;
    // Throttle for re-baking the shipped terrain cache in dev (ms timestamp).
    private lastTerrainBake = 0;
    // Tracks live connectivity so we can self-heal the map on reconnect after an AFK kick.
    private wasOnline = false;

    private isStarted = false;

    // Plugin sidebar (highlite_bar) icon — added while the plugin is enabled, removed on
    // disable. Clicking it toggles the map, exactly like pressing M.
    private static readonly MENU_ICON = '🗺️';
    private mapMenuIcon: HTMLElement | null = null;

    // Detached map window (a separate OS window the user can move/resize while playing).
    private mapWindowOpen = false;
    private mapWindowTimer: any = null;
    private mapWindowFullTimer: any = null;
    private mwCloseHooked = false;
    // Perf: the terrain PNG (toDataURL) is a ~100ms main-thread block; cache it and only regenerate
    // when the explored terrain actually changed. lastFullSig gates the heavy full-snapshot push so
    // it doesn't run every 7s for no reason (which froze the game tick → click-to-move "slingshot").
    private terrainUrl = '';
    private terrainUrlSig = '';
    // Set whenever the worldCanvas is repainted, so the viewer's terrain is re-encoded + re-sent.
    // (The old size-based signature never changed — tilePaintedEntries is a fixed-size sliding
    // window — so the viewer's terrain froze at its first encode and never picked up new detail.)
    private terrainDirty = true;
    private lastFullSig = '';
    private mapTerrainTimer: any = null;
    private terrainEncoding = false;

    // ── One viewer, two hosts ─────────────────────────────────────────────────────
    // The SAME HTML viewer (buildMapWindowHtml) runs either in a detached OS window
    // ('window') or an in-page iframe docked over the game ('overlay'). mapMode is the
    // user's remembered preference; the active host is whichever is currently open.
    private mapMode: 'window' | 'overlay' = 'window';
    private overlayEl: HTMLDivElement | null = null;   // overlay host container
    private overlayFrame: HTMLIFrameElement | null = null;
    private overlayShadow: ShadowRoot | null = null;   // shadow root the viewer runs inside
    private overlayMsgHooked = false;

    // ── View state (tile units) ───────────────────────────────────────────────────
    private currentFloor = 0;

    // ── Discovered/accumulated data ───────────────────────────────────────────────
    /** Persistent object store for the current map: key `${x},${z},${floor},${defId}`. */
    private objectStore = new Map<string, MapObject>();
    /** Persistent NPC sightings: defId -> (key `${x},${z}` -> sighting). */
    private npcStore = new Map<number, Map<string, NpcSighting>>();
    private liveNpcs: LiveNpc[] = [];
    private liveNpcKeys = new Set<string>();
    /** Per-session last-known position by entity id (unique per spawned NPC this session,
     *  NOT stable across relogins). Lets us hand a live NPC off to an exact "last known"
     *  marker when it leaves broadcast — and back to live when it returns — instead of the
     *  fuzzy proximity dedup. Cleared on map change; persisted cross-session via npcStore. */
    private sessionNpcs = new Map<number, { id: number; defId: number; name: string; x: number; z: number; floor: number; level: number | undefined; seen: number }>();
    private static readonly MAX_SESSION_NPCS = 2000;
    private players: { name: string; x: number; z: number }[] = [];
    private minimapMarkers: MinimapMarker[] = [];

    private mapId = '';
    private lastDataRefresh = 0;
    private lastSave = 0;
    private storeDirty = false;

    private liveEphemeral: MapObject[] = [];
    private ephemeralPurged = false;

    // ── Filter state ──────────────────────────────────────────────────────────────
    private disabledCats = new Set<string>();
    private disabledNames = new Set<string>(); // `${category}:${name}`
    private showLiveNpcs = true;
    private showNpcSightings = true;
    private showPlayers = true;
    private labelsEnabled = true;
    private showMinimapMarkers = true;


    private static readonly NPC_CAT = '__npc__';
    private static readonly MAX_SIGHTINGS_PER_NPC = 240;
    // Bump when the render output changes (camera angle, URL fix, …) to invalidate &
    // regenerate every persisted icon. Old-version keys are purged on load.

    // ── Lifecycle ─────────────────────────────────────────────────────────────────
    /** The core only runs init()/start() once logged in, but registerPlugin constructs the
     *  instance at page load. We register the sidebar icon + M-key handler here (construction)
     *  so the map is reachable when logged OUT too — it opens the persisted offline bundle.
     *  The live data collection / overlay still starts on login via start(). */
    constructor() {
        super();
        try { this.installKeyHandler(); this.registerSidebarIcon(); } catch { /* managers not ready — start() retries */ }
        // The game's 5-min AFK kick reloads client.html, which resets this plugin's window
        // state but leaves the detached OS window open (it lives in the main process). Re-attach
        // to it so it un-freezes on its own instead of needing a close+reopen.
        try { void this.reattachMapWindow(); } catch { /* best effort */ }
        // Preload the shipped terrain prebake so the offline map has terrain/walls even with
        // no saved bundle (fresh install) or a blank one (force-logout corruption).
        try { void this.loadShippedBundles(); } catch { /* best effort */ }
        // Bake the rotated stone background now (same-origin at page load) so the map shows the
        // correct orientation even when opened logged-out/offline — not just after warmUp().
        try { void this.bakeStoneTexture(); } catch { /* best effort */ }
    }

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
                    // Open the map if it isn't already open (don't toggle a shown map shut), then
                    // jump to the coordinate. Re-send the goTo a few times: the overlay iframe can
                    // take >60ms to be ready on mobile, and its initial fit() would otherwise clobber
                    // an early goTo and leave the map zoomed all the way out.
                    if (!this.viewerOpen()) this.openMap();
                    const go = () => this.pushToViewer({ goTo: { x, z } });
                    setTimeout(go, 120); setTimeout(go, 450); setTimeout(go, 900);
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
        this.installKeyHandler();
        this.registerSidebarIcon();
        this.warmUp();
    }

    private warmedUp = false;
    /** Pre-load the icon system + map data in the background once the player is in-world, so
     *  the first time the map opens it's already populated — instead of showing placeholder
     *  dots for a moment while the prebaked icon cache loads and the world canvas builds. */
    private async warmUp(attempt = 0): Promise<void> {
        if (this.warmedUp || !this.isStarted) return;
        const cm = this.getChunkManager();
        if (!cm || !this.gm?.scene) { if (attempt < 90) setTimeout(() => this.warmUp(attempt + 1), 1000); return; }
        this.warmedUp = true;
        try {
            this.bakeStoneTexture();       // rotate the stone tile for the detached window
            await this.initIconSystem();   // load prebaked icon cache + Babylon -> bjsState ready
            void this.renderAllIcons();    // bulk preload all icons in the background
            this.refreshData();            // populate objectStore / markers / NPCs (queues icon renders)
            void this.loadWorldMapApi();   // sanctioned server map API: authoritative NPC spawn points
            this.rebuildWorldCanvas(cm);   // build terrain + walls
            setTimeout(() => this.refreshData(), 1500); // settle pass for late-streaming defs
            // If a detached window was re-attached after an AFK reload, push live data now so
            // it swaps from the offline bundle to the live map without waiting for the timer.
            if (this.mapWindowOpen) {
                const ipc = (window as any).electron?.ipcRenderer;
                const s = this.buildMapSnapshot();
                if (s) ipc?.send('map-window:update', { full: s, p: s.p });
            }
            this.info('warm-up complete — map ready to open instantly.');
        } catch { /* best effort */ }
    }

    stop() {
        this.isStarted = false;
        this.info('World Map Plugin stopped.');
        this.persistStores(true);
        this.stopMapWindowUpdates();
        if (this.overlayEl) this.closeOverlayHost();
        this.unregisterSidebarIcon();
        this.warmedUp = false;
    }

    /** Add a map icon to the plugin sidebar (highlite_bar). Clicking it toggles the map
     *  like pressing M. The PanelManager is a core singleton created before plugins start;
     *  if it isn't ready yet (race on cold start), retry shortly. */
    private registerSidebarIcon(attempt = 0) {
        if (this.mapMenuIcon) return;
        const pm = (document as any).highlite?.managers?.PanelManager;
        if (!pm || typeof pm.requestMenuItem !== 'function') {
            if (attempt < 20) setTimeout(() => this.registerSidebarIcon(attempt + 1), 400);
            return;
        }
        try {
            const [iconEl] = pm.requestMenuItem(WorldMapPlugin.MENU_ICON, 'World Map');
            this.mapMenuIcon = iconEl as HTMLElement;
            this.mapMenuIcon.title = 'World Map (M)';
            // Override the default sidebar-panel toggle: open the detached map window instead.
            this.mapMenuIcon.onclick = (e: Event) => {
                e.stopPropagation();
                this.openMapWindow();
            };
        } catch (err) {
            this.warn('sidebar icon registration failed: ' + ((err as Error)?.message ?? err));
        }
    }

    private unregisterSidebarIcon() {
        const pm = (document as any).highlite?.managers?.PanelManager;
        try { if (pm && this.mapMenuIcon) pm.removeMenuItem(WorldMapPlugin.MENU_ICON); } catch { /* already gone */ }
        this.mapMenuIcon = null;
    }

    onSettingsChanged_enabled() {
        if (this.settings.enable.value) this.start();
        else this.stop();
    }

    // ── Game data access (all by stable semantic names) ───────────────────────────
    private get gm(): any {
        // Route through the Reflector: the GameManager instance is captured into
        // gameHooks.GameManager.Instance by the HookManager (it's not a game-side
        // singleton). Fall back to the raw global only until hooks have bound.
        return this.gameHooks?.GameManager?.Instance ?? (window as any).gm ?? null;
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

    private lastPlayerAngle: number | null = null;
    /** The player's facing angle for our NORTH-UP world map. We piggyback the vanilla minimap's
     *  already-smoothed arrow angle (mm.playerArrowAngle — it runs the game's smoothPlayerArrowAngle
     *  rate-limiter and tracks the heading exactly) and convert it from the minimap's CAMERA-ROTATED
     *  frame into our north-up frame by adding (alpha − π/2). Verified empirically: across all stable
     *  samples our north-up angle == mm.playerArrowAngle + mm.lastAlpha − π/2. This makes our arrow
     *  glide and face identically to the in-game minimap arrow, and the (+alpha) term cancels camera
     *  rotation so it stays north-up. (The old approach derived atan2(headingDx,−headingDz) behind a
     *  0.0009 speed threshold that rejected straight N/S/E/W movement → stale/wrong-facing arrow.)
     *  null until the game has computed an arrow angle (first move). */
    private getPlayerAngle(): number | null {
        const mm = this.gm?.minimap;
        if (!mm || !mm.hasPlayerArrowAngle) return this.lastPlayerAngle;
        const a = mm.playerArrowAngle + (mm.lastAlpha || 0) - Math.PI / 2;
        this.lastPlayerAngle = Math.atan2(Math.sin(a), Math.cos(a)); // normalise to (−π, π]
        return this.lastPlayerAngle;
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
            .replace(/\.(glb|gltf)$/i, '')
            .replace(/[_-]+/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase boundary
            .replace(/([A-Za-z])(\d)/g, '$1 $2')  // letter→digit boundary
            .replace(/\s+\d+$/, '')                // drop trailing version number
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // ── Data collection + accumulation ────────────────────────────────────────────
    /** Detect a reconnect (offline→online). The 5-min AFK kick boots you and the game
     *  tears the world down and later rebuilds it; the in-memory worldCanvas is then stale
     *  (or was repainted blank mid-teardown). On the offline→online edge, drop the terrain
     *  so the next rebuild recreates it fresh and re-seeds from the saved caches — this makes
     *  an already-open map window self-heal without the user closing and reopening it. */
    private syncConnectivity(): void {
        const cm = this.getChunkManager();
        const live = !!(cm && (cm.mapWidth | 0) && ((cm.tilePaintedEntries?.size | 0) > 0)) && !!this.getPlayerPos();
        if (live && !this.wasOnline) {
            // Reconnect (e.g. after the 5-min AFK kick). Do NOT wipe the worldCanvas — the live paint
            // (drawImage source-over) and the seed (destination-over) are additive, so the accumulated
            // terrain isn't stale, just possibly missing tiles that loaded mid-teardown. Wiping it was
            // the cause of terrain "clearing" on every transient offline→online blip (objects persist
            // in plugin.data; terrain did not — issue #20). Reset the rebuild throttle so the next pass
            // repaints the loaded region, and re-seed to backfill any gaps from the saved caches.
            this.lastPaintedSize = -1;
            this.lastRebuild = 0;
            if (this.worldCanvas) void this.seedWorldFromCaches(this.worldW, this.worldH, this.currentFloor);
        }
        this.wasOnline = live;
    }

    private refreshData() {
        const now = performance.now();
        if (now - this.lastDataRefresh < 500) return;
        this.lastDataRefresh = now;

        this.syncConnectivity();

        const gm = this.gm;
        if (!gm) return;

        // Map change -> swap stores.
        const id = this.getMapId();
        if (id !== this.mapId) {
            this.persistStores(true);
            this.mapId = id;
            this.objectStore.clear();
            this.npcStore.clear();
            this.sessionNpcs.clear();
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

        if (this.storeDirty && now - this.lastSave > 4000) this.persistStores();
    }

    /** True for transient, player-/event-created objects that must not be persisted (fire). */
    private isEphemeralObject(name: string, assetId: string): boolean {
        return /^fire$/i.test(name) || /^fire$/i.test(assetId);
    }

    private collectObjects() {
        const gm = this.gm;
        const wod: Map<any, any> | undefined = gm.worldObjectDefs;
        const defs: Map<any, any> | undefined = gm.objectDefsCache;
        if (!wod || !defs) return;
        
        this.liveEphemeral = []; // rebuilt from the live world every scan
        // One-time purge of any ephemeral objects a prior version persisted (stale ghost fires).
        if (!this.ephemeralPurged) {
            this.ephemeralPurged = true;
            for (const [k, o] of this.objectStore) {
                if (this.isEphemeralObject(o.name, o.assetId || '')) { this.objectStore.delete(k); this.storeDirty = true; }
            }
        }
        
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
            // Transient objects (fire) are shown live but never stored — and any stale copy
            // is dropped so it can't outlive the real object.
            if (this.isEphemeralObject(name, assetId)) {
                this.liveEphemeral.push({ defId: rec.defId, category, name, x: rec.x, z: rec.z, floor, depleted: !!rec.depleted, assetId });
                if (this.objectStore.has(key)) { this.objectStore.delete(key); this.storeDirty = true; }
                continue;
            }
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

            // Track this exact NPC instance for the session so it keeps a precise last-known
            // position after it walks out of broadcast (and resumes live when it returns).
            const se = this.sessionNpcs.get(id);
            if (se) { 
                // Overwrite identity fields too, since the server recycles Entity IDs!
                se.defId = defId; se.name = name; 
                se.x = x; se.z = z; se.floor = floor; se.level = level; se.seen = Date.now(); 
            }
            else {
                if (this.sessionNpcs.size >= WorldMapPlugin.MAX_SESSION_NPCS) {
                    const oldest = this.sessionNpcs.keys().next().value; // Map preserves insertion order
                    if (oldest !== undefined) this.sessionNpcs.delete(oldest);
                }
                this.sessionNpcs.set(id, { id, defId, name, x, z, floor, level, seen: Date.now() });
            }

            // Accumulate sighting, snapped to the tile CENTRE (x.5) so stored markers line up
            // with the terrain the same way objects (already tile-centred coords) and live NPCs
            // do — the renderer maps a world coord G straight to (G - srcLeft)*z with no +0.5.
            const rx = Math.floor(x) + 0.5, rz = Math.floor(z) + 0.5;
            let perDef = this.npcStore.get(defId);
            if (!perDef) { perDef = new Map(); this.npcStore.set(defId, perDef); }
            const skey = `${rx},${rz}`;
            const existing = perDef.get(skey);
            if (!existing) {
                if (perDef.size >= WorldMapPlugin.MAX_SIGHTINGS_PER_NPC) {
                    const first = perDef.keys().next().value;
                    if (first !== undefined) perDef.delete(first);
                }
                perDef.set(skey, { defId, name, x: rx, z: rz, level, floor, seen: Date.now() });
                this.storeDirty = true;
            } else {
                // Re-seen: refresh recency (+ backfill floor for pre-upgrade saves).
                existing.seen = Date.now();
                if (existing.floor === undefined) existing.floor = floor;
            }
        }

        // --- Cleanup Pass: Remove ghost artifacts ---
        // If there's a stored marker within broadcast range (35 tiles) and no live NPC 
        // matches it, it means the NPC despawned or died. Delete the artifact!
        const px = ents.player?.x, pz = ents.player?.z;
        if (px != null && pz != null) {
            const VERIFY_DIST = 35 * 35; 
            
            // 1. Prune sessionNpcs
            for (const [id, s] of this.sessionNpcs) {
                if ((s.floor ?? 0) === this.currentFloor) {
                    const dx = s.x - px, dz = s.z - pz;
                    if (dx * dx + dz * dz < VERIFY_DIST) {
                        if (!this.liveNpcs.some(n => n.id === id)) {
                            this.sessionNpcs.delete(id);
                        }
                    }
                }
            }

            // 2. Prune npcStore
            for (const [defId, clusters] of this.npcStore) {
                for (const [skey, m] of clusters) {
                    if ((m.floor ?? 0) === this.currentFloor) {
                        const dx = m.x - px, dz = m.z - pz;
                        if (dx * dx + dz * dz < VERIFY_DIST) {
                            // Require a live NPC of this type to be within ~15 tiles of the cluster point
                            const hasLive = this.liveNpcs.some(n => n.defId === defId && Math.pow(n.x - m.x, 2) + Math.pow(n.z - m.z, 2) < 225);
                            if (!hasLive) {
                                clusters.delete(skey);
                                this.storeDirty = true;
                            }
                        }
                    }
                }
                if (clusters.size === 0) this.npcStore.delete(defId);
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

    // ── Persistence (core plugin.data → IndexedDB, per user) ──────────────────────
    // plugin.data is a reactive object the core PluginDataManager auto-persists
    // (debounced) to IndexedDB keyed by the logged-in user. Shape:
    //   this.data.maps[mapId] = { obj: ObjRecord[], npc: { defId: {name, pts[]} } }
    //   this.data.filters     = { disabledCats, disabledNames, show*, ... }
    private ensureDataShape() {
        if (!this.data.maps || typeof this.data.maps !== 'object') this.data.maps = {};
        if (!this.data.filters || typeof this.data.filters !== 'object') this.data.filters = {};
    }

    /** Merge ObjRecord[] into objectStore (union by tile+def key — never removes). */
    private mergeObjRecords(arr: any[]) {
        for (const o of (arr ?? [])) {
            if (!o) continue;
            const key = `${o.x},${o.z},${o.floor},${o.defId}`;
            if (!this.objectStore.has(key)) {
                this.objectStore.set(key, { defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, depleted: false, assetId: o.assetId ?? '' });
            }
        }
    }
    /** Merge persisted NPC records ({defId:{name,pts}}) into npcStore (union of sighting tiles). */
    private mergeNpcRecords(npc: Record<string, { name: string; pts: number[][] }>) {
        for (const defIdStr of Object.keys(npc ?? {})) {
            const defId = Number(defIdStr);
            const entry = npc[defIdStr];
            let m = this.npcStore.get(defId);
            if (!m) { m = new Map<string, NpcSighting>(); this.npcStore.set(defId, m); }
            for (const p of (entry.pts ?? [])) {
                const [x, z, level, floor, seen] = p; // [x,z,level,floor?,seen?]
                const k = `${x},${z}`;
                if (!m.has(k)) m.set(k, { defId, name: entry.name, x, z, level: level < 0 ? undefined : level, floor: floor ?? undefined, seen: seen || 0 });
            }
            if (!this.npcNameDef.has(entry.name)) this.npcNameDef.set(entry.name, defId);
        }
    }

    private loadStores() {
        try {
            this.ensureDataShape();
            this.migrateLegacyLocalStorage();
            // Primary: the core's per-user reactive store (IndexedDB). Then UNION in the
            // synchronous localStorage backup — IndexedDB writes are debounced, so an abrupt
            // reload (the AFK kick) can lose the latest; the localStorage backup survives it,
            // so whichever is richer wins and the live store isn't reset to a tiny patch.
            const mapData = this.data.maps[this.mapId];
            if (mapData) { this.mergeObjRecords(mapData.obj as any[]); this.mergeNpcRecords(mapData.npc as any); }
            try {
                const raw = localStorage.getItem(`eq_wm_store:${this.mapId}`);
                if (raw) { const bk = JSON.parse(raw); this.mergeObjRecords(bk.obj); this.mergeNpcRecords(bk.npc); }
            } catch { /* no/invalid backup */ }
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
            this.ensureDataShape();
            const objArr = [...this.objectStore.values()].map((o) => ({ defId: o.defId, category: o.category, name: o.name, x: o.x, z: o.z, floor: o.floor, assetId: o.assetId }));

            const npcObj: Record<string, { name: string; pts: number[][] }> = {};
            for (const [defId, m] of this.npcStore) {
                const first = m.values().next().value;
                npcObj[defId] = { name: first?.name ?? `NPC #${defId}`, pts: [...m.values()].map((s) => [s.x, s.z, s.level ?? -1, s.floor ?? 0, s.seen ?? 0]) };
            }
            // Single assignment per map -> one reactive write (debounced by core).
            this.data.maps[this.mapId] = { obj: objArr, npc: npcObj };
            // Synchronous durable backup: the core's IndexedDB write is debounced and can be
            // lost if the renderer reloads (AFK kick) before it flushes. localStorage writes
            // immediately, so loadStores can union it back in and the explored store survives.
            try { localStorage.setItem(`eq_wm_store:${this.mapId}`, JSON.stringify({ obj: objArr, npc: npcObj })); } catch { /* quota */ }
        } catch (e: any) {
            this.warn('persistStores failed: ' + (e?.message || e));
        }
    }

    private loadFilterState() {
        try {
            this.ensureDataShape();
            const f = this.data.filters;
            if (!f || !Object.keys(f).length) return;
            this.disabledCats = new Set(f.disabledCats ?? []);
            this.disabledNames = new Set(f.disabledNames ?? []);
            this.showLiveNpcs = f.showLiveNpcs ?? true;
            this.showNpcSightings = f.showNpcSightings ?? true;
            this.showPlayers = f.showPlayers ?? true;
            this.iconsEnabled = f.iconsEnabled ?? true;
            this.labelsEnabled = f.labelsEnabled ?? true;
            this.showMinimapMarkers = f.showMinimapMarkers ?? true;
            this.mapMode = (this.isMobile || f.mapMode === 'overlay') ? 'overlay' : 'window';
        } catch { /* ignore */ }
    }
    private saveFilterState() {
        try {
            this.ensureDataShape();
            this.data.filters = {
                disabledCats: [...this.disabledCats],
                disabledNames: [...this.disabledNames],
                showLiveNpcs: this.showLiveNpcs,
                showNpcSightings: this.showNpcSightings,
                showPlayers: this.showPlayers,
                iconsEnabled: this.iconsEnabled,
                labelsEnabled: this.labelsEnabled,
                showMinimapMarkers: this.showMinimapMarkers,
                mapMode: this.mapMode,
            };
        } catch { /* ignore */ }
    }

    // One-time import of pre-plugin.data localStorage (`evilitemap:*`). Best-effort:
    // the old launch-time clearStorageData() wiped this each boot, so there's at most
    // one session to recover; once imported we drop the legacy keys.
    private legacyMigrated = false;
    private migrateLegacyLocalStorage() {
        if (this.legacyMigrated) return;
        this.legacyMigrated = true;
        try {
            const objRaw = localStorage.getItem(`evilitemap:obj:${this.mapId}`);
            const npcRaw = localStorage.getItem(`evilitemap:npc:${this.mapId}`);
            if ((objRaw || npcRaw) && !this.data.maps[this.mapId]) {
                this.data.maps[this.mapId] = {
                    obj: objRaw ? JSON.parse(objRaw) : [],
                    npc: npcRaw ? JSON.parse(npcRaw) : {},
                };
            }
            const filtRaw = localStorage.getItem('evilitemap:filters');
            if (filtRaw && !Object.keys(this.data.filters).length) {
                this.data.filters = JSON.parse(filtRaw);
            }
            for (const k of ['obj', 'npc']) localStorage.removeItem(`evilitemap:${k}:${this.mapId}`);
            localStorage.removeItem('evilitemap:filters');
        } catch { /* ignore */ }
    }





    /** The game's dark-stone tile, rotated 90° (brick courses horizontal), as a data URL.
     *  Baked once in the game renderer (same-origin) so the detached map window — a file://
     *  page that can't rotate the cross-origin texture itself without tainting — can reuse it. */
    private stoneTexBaked: string | null = null;
    private bakeStoneTexture(): Promise<string | null> {
        if (this.stoneTexBaked) return Promise.resolve(this.stoneTexBaked);
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const w = img.naturalWidth, h = img.naturalHeight;
                    const c = document.createElement('canvas');
                    c.width = h; c.height = w; // swap dims for the 90° turn
                    const cx = c.getContext('2d')!;
                    cx.translate(c.width / 2, c.height / 2);
                    cx.rotate(Math.PI / 2);
                    cx.drawImage(img, -w / 2, -h / 2);
                    this.stoneTexBaked = c.toDataURL('image/png');
                } catch { this.stoneTexBaked = null; }
                resolve(this.stoneTexBaked);
            };
            img.onerror = () => resolve(null);
            img.src = 'https://evilquest.net/ui/stone-dark.png';
        });
    }









    private keyHandlerInstalled = false;
    private installKeyHandler() {
        if (this.keyHandlerInstalled) return; // idempotent — registered at construction + start
        this.keyHandlerInstalled = true;
        window.addEventListener('keydown', (e) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            if (e.key === 'm' || e.key === 'M') this.openMapWindow();
            // DEV ONLY: Ctrl+Shift+B bakes the full icon cache. Gated to dev builds so it
            // never fires for end users (in a packaged build the cache is read-only anyway).
            if (e.ctrlKey && e.shiftKey && (e.key === 'B' || e.key === 'b') && (import.meta as any)?.env?.DEV) {
                e.preventDefault();
                void this.renderAllIcons();
            }
            // Export the full map to a standalone HTML (for the wiki/hub). Ctrl+Shift+E.
            if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
                e.preventDefault();
                void this.exportMap();
            }
        }, { capture: true });
    }





    // ── Terrain rendering ─────────────────────────────────────────────────────────
    private static readonly T = { GRASS: 0, DIRT: 1, STONE: 2, WATER: 3, WALL: 4, SAND: 5, WOOD: 6, MUD: 7 };
    // Base tile-type colors. Values recovered exactly from the live minimap's tileColorBuf
    // (base = rendered colour minus the deterministic coordinate noise): GRASS/WATER/DIRT/MUD
    // verified against the running game; the rest keep the prior `ga`-table approximations.
    private static readonly TYPE_COLOR: Record<number, number[]> = {
        0: [41, 137, 22], 1: [142, 98, 44], 2: [130, 124, 114], 3: [43, 88, 141],
        4: [62, 140, 46], 5: [196, 170, 106], 6: [116, 82, 48], 7: [62, 140, 46],
    };
    private static readonly TEXTURED_COLOR = [138, 116, 82]; // Nf
    private static readonly ROOF_COLOR = [96, 64, 34];       // Df — matches game exactly
    // Wall direction bitmask (F enum in the game): N=1, E=2, S=4, W=8 (Clockwise).
    // This aligns perfectly with the game's checks: (wf & 5) === 5 is N+S, (wf & 10) === 10 is E+W.
    // Wall-edge line color — RGB(220,216,200): warm cream, same as game minimap white lines.


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

    private loadImage(src: string): Promise<HTMLImageElement> {
        return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
    }

    /** Seed a freshly-(re)created worldCanvas with previously-explored terrain so the live
     *  map survives reloads/logins instead of resetting to the chunks loaded right now.
     *  Two sources, layered cheapest-first (later overwrites earlier):
     *    1. shipped prebake (PluginAssetCache 'world-map-terrain') → packaged users get a
     *       full map immediately (read-only in shipped builds).
     *    2. the user's own localStorage accumulation ('eq_wm_offline') → their latest explore.
     *  The composite is drawn with destination-over so the live current-region paint (opaque,
     *  drawn synchronously by rebuildWorldCanvas right after creation) always wins — the seed
     *  only fills the gaps. Walls are filled for cells untouched this session; the live region
     *  self-corrects on the next rebuild. Fully async + token-guarded against floor/size change. */
    private async seedWorldFromCaches(mapW: number, mapH: number, floor: number): Promise<void> {
        const token = ++this.worldSeedToken;
        const id = this.mapId || 'world';
        const matches = (b: any) => b && b.id === id && b.floor === floor && b.W === mapW && b.H === mapH;

        const layers: any[] = [];   // bottom-first: shipped prebake under the user's own accumulation
        try {
            const baked = await this.terrainCacheStore.load();
            const pre = baked[`${id}:${floor}`];
            if (pre) { const b = JSON.parse(pre); if (matches(b)) layers.push(b); }
        } catch { /* no/invalid prebake */ }
        if (token !== this.worldSeedToken) return;
        const ls = this.loadOfflineBundle();
        if (matches(ls)) layers.push(ls);
        if (!layers.length) { this.terrainSeeded = true; this.applyApiTerrain(); return; }

        const tmp = document.createElement('canvas');
        tmp.width = mapW; tmp.height = mapH;
        const tctx = tmp.getContext('2d');
        if (!tctx) return;
        let drewTerrain = false;
        for (const b of layers) {
            if (typeof b.t === 'string') {
                try { const img = await this.loadImage(b.t); if (token !== this.worldSeedToken) return; tctx.drawImage(img, 0, 0); drewTerrain = true; } catch { /* skip */ }
            }
            if (Array.isArray(b.wl)) {
                const ww = this.worldWalls;
                for (let i = 0; i + 2 < b.wl.length; i += 3) {
                    const x = b.wl[i] | 0, z = b.wl[i + 1] | 0, wf = b.wl[i + 2];
                    if (x < 0 || x >= mapW || z < 0 || z >= mapH) continue;
                    const k = z * mapW + x; if (!ww[k]) ww[k] = wf;
                }
            }
        }
        if (token !== this.worldSeedToken || !this.worldCtx) return;
        if (drewTerrain) {
            const ctx = this.worldCtx;
            ctx.save();
            ctx.globalCompositeOperation = 'destination-over';
            ctx.drawImage(tmp, 0, 0);
            ctx.restore();
            // Restore the per-tile store from the composited cache so it keeps accumulating from the
            // full saved map — and what we persist next is the full map, not just this session.
            try { this.restoreWorldTerrain(tctx.getImageData(0, 0, mapW, mapH).data); } catch { /* ignore */ }
            this.terrainDirty = true;
        }
        this.terrainSeeded = true;
        this.applyApiTerrain();   // fill any tiles the cache seed didn't cover with the server terrain
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
            this.worldTerrain = new Uint32Array(mapW * mapH);
            this.terrainSeeded = false;
            this.worldCtx = this.worldCanvas.getContext('2d', { willReadFrequently: true });
            this.lastPaintedSize = -1;
            // Seed the blank canvas with previously-explored terrain (shipped prebake +
            // the user's own saved exploration) so the live map isn't reset to a tiny
            // patch after a reload/login. Fire-and-forget; drawn behind the live region.
            void this.seedWorldFromCaches(mapW, mapH, this.currentFloor);
        }

        // Live-in-world guard. During an AFK logout / teardown the chunkManager object lingers
        // (mapWidth still set, getTilesForMinimap still callable) but returns degraded/empty tile
        // data. Painting that would bake flat tiles over the accumulated worldTerrain AND persist
        // them to the cache — breaking the whole map, and every subsequent login (the "far side
        // flat on relog" + "AFK-logout with map open breaks all terrain" reports). Only repaint when
        // the game is genuinely live: the minimap has painted tiles and we have a player position.
        // When not live we keep the last good canvas frozen (no worldTerrain writes, no persist).
        const liveNow = ((cm.tilePaintedEntries?.size | 0) > 0) && !!this.getPlayerPos();
        if (!liveNow) return !!this.worldCanvas;

        const painted = cm.tilePaintedEntries?.size ?? 0;
        const now = performance.now();
        const grew = painted !== this.lastPaintedSize;
        const haveMap = this.lastPaintedSize >= 0;
        if (haveMap && now - this.lastRebuild < 600) return true;
        if (haveMap && !grew && now - this.lastRebuild < 1500) return true;
        this.lastPaintedSize = painted;
        this.lastRebuild = now;

        // Rebuild ONLY a render-distance window around the PLAYER — exactly like the vanilla minimap
        // (it queries getTilesForMinimap(player, ve≈23) and paints all of it). Within this window every
        // tile is fully rendered, so its colour + slope are valid. Querying the whole map instead also
        // returns loaded-but-not-yet-rendered chunks at the edge of the load radius as FLAT base colour,
        // which Pass 1 then bakes over good cached terrain — the "flat rectangular chunk blocks" bug.
        // Everything outside this window is covered by the seeded cache + API fill; as the player walks,
        // the window sweeps and accumulates fresh detail into worldTerrain/worldWalls (monotonic).
        const p = this.getPlayerPos();
        if (!p) return !!this.worldCanvas;
        const radius = 24;
        const cx = p.x, cz = p.z;

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

        // ── Pass 1: per-tile base colour (faithfully mirrors the game's minimap beginTerrainRebuild
        // + the slope shade applied in stepTerrainRebuild). We paint every NON-VOID (loaded) tile —
        // unloaded chunks come back void and are skipped, preserving the seeded cache. We do NOT gate
        // on tilePaintedEntries: that set only covers texture-plane tiles, so gating on it dropped the
        // slope/height shading and walls for ordinary terrain ("flat map, missing walls").
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
                // Accumulate this rendered tile into the persistent per-tile store (source of truth).
                this.worldTerrain[worldZ * mapW + worldX] = 0xFF000000 | (r << 16) | (g << 8) | bl;
            }
        }

        // ── Pass 2: Cache wall-edge flags for screen-space rendering ─────────────
        // The game draws thin lines on each wall-flagged edge of non-wall tiles (stepTerrainRebuild's
        // final loop). Wall direction bits: N=1, S=4, W=8, E=2 ((wf&5)===5 = N+S, (wf&10)===10 = E+W).
        // MONOTONIC: walls are static, so we only ever ADD edge flags for loaded (non-void) tiles and
        // never clear them. The whole-map query returns void for unloaded chunks, so a tile that
        // scrolls out of the loaded region keeps its cached walls instead of being wiped — this is the
        // proper fix for "walls deleting from cache / only showing near the player".
        for (let f = 0; f < size; f++) {
            for (let m = 0; m < size; m++) {
                const b = f * size + m;
                const worldX = startX + m, worldZ = startZ + f;
                if (worldX < 0 || worldX >= mapW || worldZ < 0 || worldZ >= mapH) continue;
                if (voidTiles[b]) continue;
                const wf = walls[b];
                const type = tiles[b];
                // Record edge lines only for non-wall tiles that carry partial wall-edge flags.
                if (wf && type !== T.WALL && (wf & 5) !== 5 && (wf & 10) !== 10) {
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
        this.terrainDirty = true; // canvas repainted → viewer needs a fresh terrain encode
        return true;
    }


    // ── Map export (for the wiki: standalone interactive HTML the Hub can host + iframe) ─
    /**
     * Export the explored map to a single self-contained HTML that MIRRORS the live map:
     * the viewer re-renders terrain + icons at any zoom (sharp, not a baked image), with
     * the same tile-grouping, icon sizing, category filters, POIs and search. Exports the
     * DATA (terrain image + marker positions + icon images), not a flat PNG. Ctrl+Shift+E.
     */
    /** Collapse persisted NPC sightings into one "last-known" marker per spawn. For each
     *  defId we cluster its sighting tiles by proximity (a wanderer's trail → one marker;
     *  two separate spawns of the same def → two) and emit the most-recently-seen tile of
     *  each cluster. Respects the NPC category/name filters. Used for the Stored/Live NPC
     *  modes in the window + offline view, where we have no live entities to draw. */
    private buildNpcSightings(floor: number, iconIdxOf: (defId: number) => number): any[] {
        const MERGE2 = 25 * 25; // positions within ~25 tiles = the same roaming NPC
        const out: any[] = [];
        const nameOff = (n: string) => this.disabledCats.has(WorldMapPlugin.NPC_CAT) || this.disabledNames.has(`${WorldMapPlugin.NPC_CAT}:${n}`);
        // Per-defId list of already-placed marker positions, so cross-session clusters don't
        // duplicate a marker the exact session data already covers.
        const placed = new Map<number, { x: number; z: number }[]>();
        const place = (defId: number, x: number, z: number, n: string, l: number) => {
            out.push({ x, z, n: this.prettify(n), l, i: iconIdxOf(defId) });
            let arr = placed.get(defId); if (!arr) { arr = []; placed.set(defId, arr); } arr.push({ x, z });
        };
        const covered = (defId: number, x: number, z: number) => {
            const arr = placed.get(defId); if (!arr) return false;
            for (const p of arr) { const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz <= MERGE2) return true; }
            return false;
        };

        // Live NPC positions on this floor. Seed `placed` (for the last-known fallback's clustering)
        // and keep a flat list to suppress a spawn marker only when that exact NPC is in view on it.
        const liveHere: { defId: number; x: number; z: number }[] = [];
        for (const n of this.liveNpcs) {
            if ((n.floor ?? 0) === floor && !nameOff(n.name)) {
                liveHere.push({ defId: n.defId, x: n.x, z: n.z });
                let arr = placed.get(n.defId); if (!arr) { arr = []; placed.set(n.defId, arr); } arr.push({ x: n.x, z: n.z });
            }
        }
        const liveCovers = (defId: number, x: number, z: number) => {
            for (const l of liveHere) { if (l.defId !== defId) continue; const dx = l.x - x, dz = l.z - z; if (dx * dx + dz * dz <= 36) return true; }
            return false;
        };

        // 1) Default NPC positions = authoritative spawn points from EvilQuest's /api/world-map (see
        //    loadWorldMapApi), shown everywhere — even unexplored. EACH spawn is a distinct location:
        //    we do NOT merge spawns of the same type (two Black Bears ~8 tiles apart are two spawns).
        //    A spawn is hidden only if that NPC is LIVE right on it (≤6t) — then it shows at its live
        //    position. Replaces the old last-known accumulation as the position source.
        const spawnDefIds = new Set<number>();
        for (const s of this.apiSpawns) {
            spawnDefIds.add(s.npcId);
            if ((s.floor ?? 0) !== floor || nameOff(s.name) || liveCovers(s.npcId, s.x, s.z)) continue;
            out.push({ x: s.x, z: s.z, n: this.prettify(s.name), l: 0, i: iconIdxOf(s.npcId) });
        }

        // 2) Last-known sightings — ONLY for NPC types the API doesn't list (event/quest NPCs), or
        //    as the full fallback before the API has loaded / offline (then spawnDefIds is empty).
        for (const s of this.sessionNpcs.values()) {
            if ((s.floor ?? 0) !== floor || nameOff(s.name) || spawnDefIds.has(s.defId)) continue;
            if (!covered(s.defId, s.x, s.z)) place(s.defId, s.x, s.z, s.name, s.level ?? 0);
        }
        for (const [defId, m] of this.npcStore) {
            if (spawnDefIds.has(defId)) continue;
            const name = (m.values().next().value?.name) ?? `NPC #${defId}`;
            if (nameOff(name)) continue;
            const pts = [...m.values()].filter((s) => (s.floor ?? 0) === floor).sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0));
            for (const s of pts) if (!covered(defId, s.x, s.z)) place(defId, s.x, s.z, name, s.level ?? 0);
        }
        return out;
    }

    // ── EvilQuest server world-map API (sanctioned static map data) ───────────────────────────
    /** Default NPC spawn points pulled from /api/world-map (authoritative + complete, not gated on
     *  exploration). Terrain from the same endpoint is handled separately. */
    private apiSpawns: { x: number; z: number; floor: number; npcId: number; name: string }[] = [];
    private apiTileRows: string[] | null = null;   // full server terrain grid (floor 0): 1 char/tile
    private apiMapLoaded = false;
    /** src -> index map from the last full snapshot's icon array, so the frequent live-NPC stream
     *  (which doesn't resend the icon array) can reference the icons the viewer already holds. */
    private lastIconIdx: Map<string, number> | null = null;

    /**
     * Pull static map data from EvilQuest's own server endpoint (`/api/world-map`). It is the
     * authoritative, complete map (not exploration-gated). We fetch it at most once per ~12h,
     * cached in localStorage; we never poll. This is the cooperative data path (their published
     * endpoint), not gm scraping, and the map works fully without it (gm fallback).
     *
     * ⚠️ PRE-SHIP: confirm with the EvilQuest devs (via Oni) that programmatic client use of this
     * endpoint is sanctioned before shipping. If it isn't, gate or remove this — nothing else
     * depends on it.
     */
    private async loadWorldMapApi(): Promise<void> {
        if (this.apiMapLoaded) return;
        this.apiMapLoaded = true;
        const cacheKey = `eq_wm_api:${this.mapId || 'world'}`;
        // Serve the cached subset immediately; only re-pull the 798KB payload if it's stale (>12h).
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const c = JSON.parse(cached);
                if (Array.isArray(c.spawns)) this.apiSpawns = c.spawns;
                if (Array.isArray(c.rows)) this.apiTileRows = c.rows;
                if (Array.isArray(c.spawns) || Array.isArray(c.rows)) this.afterApiLoad();
                // Only skip the refetch if the cache is fresh AND complete (older caches lack rows).
                if (c.fetchedAt && Date.now() - c.fetchedAt < 12 * 3600 * 1000 && Array.isArray(c.rows)) return;
            }
        } catch { /* ignore bad cache */ }
        try {
            const res = await fetch('https://evilquest.net/api/world-map', { credentials: 'same-origin' });
            if (!res.ok) return;
            const m = (await res.json())?.map;
            if (!m || !Array.isArray(m.npcSpawns)) return;
            this.apiSpawns = m.npcSpawns.map((s: any) => ({ x: +s.x, z: +s.z, floor: s.floor | 0, npcId: s.npcId | 0, name: (s.name ?? '') + '' }));
            if (Array.isArray(m.tileRows)) this.apiTileRows = m.tileRows;
            try { localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), updatedAt: m.updatedAt, spawns: this.apiSpawns, rows: this.apiTileRows })); } catch { /* quota */ }
            this.afterApiLoad();
        } catch { /* offline / blocked — gm data still works */ }
    }

    /** Re-render whatever viewer is open once async API data lands. */
    private afterApiLoad(): void {
        try {
            // Re-seed rather than applying the API directly: seedWorldFromCaches draws the offline
            // DETAIL first and the API flat fill only AFTER it, so the API can never pre-empt the
            // async offline draw and end up on top of your cached terrain (the login "terrain wrong"
            // race — logout looked fine because it replays the bundle directly with no race).
            if (this.worldCanvas) void this.seedWorldFromCaches(this.worldW, this.worldH, this.currentFloor);
            const s = this.buildMapSnapshot();
            if (s) this.pushToViewer({ full: s, p: s.p });
        } catch { /* not in-world yet */ }
    }

    // Server tileRows char -> colour. Matches the new gm base palette (TYPE_COLOR, recovered exactly
    // from the live minimap buffer) so the API-fill regions blend seamlessly into walked/gm-rendered
    // terrain instead of showing a lighter-green colour seam. p=path uses the textured colour,
    // m=mud a muted swamp green. (API fill has no height data, so it can't carry slope shading — those
    // regions gain the bump/shadow detail once the player walks them and the gm paints over.)
    private static readonly TILE_CHAR_COLOR: Record<string, number[]> = {
        g: [41, 137, 22], d: [142, 98, 44], p: [138, 116, 82], s: [196, 170, 106],
        r: [130, 124, 114], w: [43, 88, 141], m: [78, 110, 52],
    };

    /** Paint the authoritative full-map terrain (API `tileRows`) into the worldCanvas, filling every
     *  tile the live/seed paint hasn't already covered (destination-over, so explored detail stays on
     *  top). This makes the WHOLE map show in colour on login — no exploration needed — and the live
     *  gm rebuild keeps adding finer detail (lighting/biome) on loaded tiles. Floor 0 only. */
    private applyApiTerrain(): void {
        const rows = this.apiTileRows, cv = this.worldCanvas, ctx = this.worldCtx;
        if (!rows || !cv || !ctx || this.currentFloor !== 0 || rows.length < cv.height) return;
        const W = cv.width, H = cv.height;
        const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
        const tctx = tmp.getContext('2d'); if (!tctx) return;
        const img = tctx.createImageData(W, H); const d = img.data;
        const CC = WorldMapPlugin.TILE_CHAR_COLOR;
        const cl = (v: number) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
        for (let z = 0; z < H; z++) {
            const row = rows[z]; if (!row) continue;
            for (let x = 0; x < W && x < row.length; x++) {
                const ch = row[x], c = CC[ch]; if (!c) continue;
                const o = (z * W + x) * 4;
                // Same coordinate noise the gm minimap render uses, so the API fill reads as textured
                // terrain rather than a flat block (water gets the smaller-amplitude variant).
                if (ch === 'w') {
                    const n = ((((x * 3 * 73856093) ^ (z * 7 * 19349663)) & 255) / 255) * 6 - 3;
                    d[o] = cl(c[0] + n * 0.5); d[o + 1] = cl(c[1] + n * 0.3); d[o + 2] = cl(c[2] + n * 0.2);
                } else {
                    const n = ((((x * 73856093) ^ (z * 19349663)) & 255) / 255) * 6 - 3;
                    d[o] = cl(c[0] + n); d[o + 1] = cl(c[1] + n); d[o + 2] = cl(c[2] + n);
                }
                d[o + 3] = 255;
            }
        }
        tctx.putImageData(img, 0, 0);
        ctx.save(); ctx.globalCompositeOperation = 'destination-over'; ctx.drawImage(tmp, 0, 0); ctx.restore();
        this.terrainUrl = ''; this.terrainDirty = true; // force the viewer to receive the filled terrain
    }

    /** Gather a full, self-contained snapshot of the explored map (terrain PNG + deduped
     *  icons + per-tile markers + categories + POIs + the player position). Used by both
     *  the HTML export and the detached map window. Returns null if the map isn't ready. */
    private buildMapSnapshot(): any | null {
        const cm = this.getChunkManager();
        if (!cm || !this.rebuildWorldCanvas(cm) || !this.worldCanvas) {
            // Logged out / map not live — replay the best offline bundle (the user's saved
            // exploration, with terrain/walls backfilled from the shipped prebake if the saved
            // one is missing/blank), with no live entities and Follow disabled.
            const b = this.bestOfflineBundle();
            return b ? { ...b, p: null, npc: [], pl: [], dest: null, online: false } : null;
        }
        const W = this.worldW, H = this.worldH;

        // Terrain as a 1px/tile PNG. Use the cached copy (refreshed OFF the main thread by
        // refreshTerrainAsync via toBlob). Encode synchronously ONLY the first time, when nothing is
        // cached yet (a one-time hit on first open) — never on the per-update path, where the
        // blocking toDataURL would freeze the game's movement tick (the click-to-move "slingshot").
        let terrain = this.terrainUrl;
        if (!terrain) {
            terrain = this.worldCanvas.toDataURL('image/png');
            this.terrainUrl = terrain;
            this.terrainUrlSig = this.worldW + 'x' + this.worldH + ':' + this.lastPaintedSize + ':' + this.currentFloor;
        }

        // Object icons (deduped) + one representative marker per tile (mirrors drawMarkers).
        const iconIdx = new Map<string, number>();
        const icons: string[] = [];
        const idxOf = (im: HTMLImageElement | null): number => {
            if (!im || !im.complete || !im.naturalWidth || !im.src.startsWith('data:')) return -1;
            let i = iconIdx.get(im.src);
            if (i === undefined) { i = icons.length; iconIdx.set(im.src, i); icons.push(im.src); }
            return i;
        };
        const groups = new Map<string, MapObject[]>();
        const allObjects = [...this.objectStore.values(), ...this.liveEphemeral];
        for (const o of allObjects) {
            if (o.floor !== undefined && o.floor !== this.currentFloor) continue;
            const k = `${o.x},${o.z}`;
            let arr = groups.get(k); if (!arr) { arr = []; groups.set(k, arr); } arr.push(o);
        }
        const catMap = new Map<string, { c: string; s: string }>();
        const objects: any[] = [];
        for (const group of groups.values()) {
            let rep = group[0];
            for (const g of group) { if (this.getObjectIcon(g)) rep = g; }
            const o = rep;
            if (!catMap.has(o.category)) catMap.set(o.category, { c: this.catColor(o.category), s: this.catShape(o.category) });
            objects.push({ x: o.x, z: o.z, i: idxOf(this.getObjectIcon(o)), c: o.category, n: this.prettify(o.name), k: group.length, d: o.depleted ? 1 : 0 });
        }
        const cats = [...catMap.entries()].map(([n, v]) => ({ n, c: v.c, s: v.s })).sort((a, b) => a.n.localeCompare(b.n));

        // POIs (minimap markers) + their icons, converted to data URLs so the file is self-contained.
        const mmIdx = new Map<string, number>();
        const mmIcons: string[] = [];
        const toDataUrl = (im: HTMLImageElement): string | null => {
            try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d')!.drawImage(im, 0, 0); return c.toDataURL('image/png'); } catch { return null; }
        };
        const pois: any[] = [];
        for (const m of this.minimapMarkers) {
            let mi = -1;
            const im = this.getMmIcon(m.icon);
            if (im && im.complete && im.naturalWidth) {
                const du = toDataUrl(im);
                if (du) { let i = mmIdx.get(du); if (i === undefined) { i = mmIcons.length; mmIdx.set(du, i); mmIcons.push(du); } mi = i; }
            }
            pois.push({ x: m.x, z: m.z, n: (m.label || m.icon).replace(/\.(png|webp)$/i, '').replace(/_/g, ' '), m: mi, s: Math.max(8, Math.min(32, m.size || 16)) });
        }

        // Live entities on the current floor (so the detached window shows them moving).
        // i = rendered 3D model-icon index (getNpcIcon queues the render + caches it); the
        // viewer draws the model icon, falling back to a dot until it's ready.
        const npc = this.liveNpcs
            .filter((n) => (n.floor ?? 0) === this.currentFloor)
            .map((n) => ({ x: n.x, z: n.z, n: this.prettify(n.name), l: n.level ?? 0, i: idxOf(this.getNpcIcon(n.defId)) }));
        const pl = this.players.map((p) => ({ x: p.x, z: p.z, n: p.name }));
        // Cached "last-known" NPC positions (one per spawn cluster) so the window/offline
        // view can show NPCs when not live — the Off/Stored/Live switch keys off this + npc.
        const ns = this.buildNpcSightings(this.currentFloor, (d) => idxOf(this.getNpcIcon(d)));
        // Remember this snapshot's icon indexing so the frequent live stream can reuse it.
        this.lastIconIdx = iconIdx;

        // Sparse wall list [x,z,wf,...] (wf = N|E|S|W bitmask) so the viewer can draw the
        // vanilla white wall lines at screen scale, exactly like the in-game minimap.
        const wl: number[] = [];
        const ww = this.worldWalls;
        for (let z2 = 0; z2 < H; z2++) { const row = z2 * W; for (let x2 = 0; x2 < W; x2++) { const wf = ww[row + x2]; if (wf) wl.push(x2, z2, wf); } }

        const player = this.getPlayerPos();
        const data = {
            id: this.mapId || 'world', W, H, t: terrain, ic: icons, ob: objects, ct: cats, pi: pois, mm: mmIcons,
            floor: this.currentFloor, p: player ? { x: player.x, z: player.z, a: this.getPlayerAngle() } : null,
            npc, ns, pl, wl, online: !!player, dest: this.getMoveDest(),
        };
        this.saveOfflineBundle(data); // so the map still works after logout
        return data;
    }

    /** Cache the static map (terrain + walls + objects + icons) so the map window still
     *  works when logged out. Uses localStorage (evilquest.net origin, survives logout and
     *  cold launch) — plugin.data is per-user and PluginAssetCache is read-only in shipped
     *  builds, so neither is usable offline. Stripped of live entities; ~0.5-1MB for one map. */
    private saveOfflineBundle(data: any): void {
        try {
            const b = { id: data.id, W: data.W, H: data.H, t: data.t, ic: data.ic, ob: data.ob, ct: data.ct, pi: data.pi, mm: data.mm, wl: data.wl, ns: data.ns, floor: data.floor };
            // Don't let a degraded snapshot clobber a richer saved map — in terrain OR object
            // count. The 5-min AFK kick tears the world down (blank terrain) and a reload can
            // start with a near-empty objectStore before the persisted data reloads; without
            // this guard a full-snapshot timer would overwrite the good bundle, blanking the
            // logged-out map / dropping its objects. Keep the better one for this map+floor.
            const prev = this.loadOfflineBundle();
            const obc = (x: any) => Array.isArray(x?.ob) ? x.ob.length : 0;
            if (prev && prev.id === b.id && prev.floor === b.floor &&
                (this.terrainScore(b) < this.terrainScore(prev) * 0.85 || obc(b) < obc(prev) * 0.85)) {
                return; // saved bundle is meaningfully richer — keep it
            }
            const json = JSON.stringify(b);
            localStorage.setItem('eq_wm_offline', json);
            // Re-bake the shipped terrain cache (dev-only on the main side; no-op when
            // packaged) so the committed full-map cache stays current as we explore.
            // Throttled — terrain changes constantly and the bundle is large.
            const now = Date.now();
            if (now - this.lastTerrainBake > 30000) {
                this.lastTerrainBake = now;
                this.terrainCacheStore.save(`${b.id}:${b.floor}`, json);
            }
        } catch { /* quota exceeded — offline map just won't have the latest */ }
    }
    private loadOfflineBundle(): any | null {
        try { const s = localStorage.getItem('eq_wm_offline'); return s ? JSON.parse(s) : null; } catch { return null; }
    }
    /** Rough "how much real map is in this bundle" score, for the save downgrade-guard.
     *  Terrain PNG byte length tracks painted (non-transparent) area; walls add weight. */
    private terrainScore(b: any): number {
        if (!b) return 0;
        return (typeof b.t === 'string' ? b.t.length : 0) + (Array.isArray(b.wl) ? b.wl.length * 8 : 0);
    }

    /** Persist the terrain (+ walls) to the offline bundle whenever the canvas changes — so walking
     *  to fill in terrain detail is cached like objects/walls. (saveOfflineBundle, the full-snapshot
     *  path, only fires when a MARKER changes; terrain alone never triggered it, so explored terrain
     *  was lost on reload/logout — issue: terrain not cached like other assets.) Keeps the previously
     *  saved objects/icons/markers and is downgrade-guarded so a mid-teardown blank can't clobber it. */
    private persistTerrainToBundle(): void {
        // worldTerrain is the monotonic source of truth; only persist once it's been restored from
        // cache (terrainSeeded) so a partial pre-seed map can't overwrite a full saved one.
        if (!this.terrainSeeded || !this.worldW || !this.worldH) return;
        const id = this.mapId || 'world', floor = this.currentFloor, W = this.worldW, H = this.worldH;
        const t = this.encodeWorldTerrain();
        if (!t) return;
        const wl: number[] = []; const ww = this.worldWalls;
        if (ww) for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) { const k = z * W + x; if (ww[k]) wl.push(x, z, ww[k]); }
        const prev = this.loadOfflineBundle();
        const b: any = (prev && prev.id === id && prev.floor === floor) ? { ...prev } : { id, floor };
        b.id = id; b.floor = floor; b.W = W; b.H = H; b.t = t; b.wl = wl;
        // No downgrade guard: worldTerrain only ever accumulates, so the saved map can't lose detail.
        try { localStorage.setItem('eq_wm_offline', JSON.stringify(b)); } catch { /* quota */ }
        const now = Date.now();
        if (now - this.lastTerrainBake > 30000) { this.lastTerrainBake = now; try { this.terrainCacheStore.save(`${id}:${floor}`, JSON.stringify(b)); } catch { /* ignore */ } }
    }

    /** Encode the per-tile terrain store to a PNG (unpainted tiles transparent) — the persisted
     *  terrain: real explored tiles only, no API fill, monotonic so it can never lose detail. */
    private encodeWorldTerrain(): string {
        const W = this.worldW, H = this.worldH, wt = this.worldTerrain;
        if (!W || !H || wt.length !== W * H) return '';
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const ctx = c.getContext('2d'); if (!ctx) return '';
        const img = ctx.createImageData(W, H); const d = img.data;
        for (let k = 0; k < wt.length; k++) { const v = wt[k]; if (!v) continue; const o = k * 4; d[o] = (v >> 16) & 255; d[o + 1] = (v >> 8) & 255; d[o + 2] = v & 255; d[o + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        try { return c.toDataURL('image/png'); } catch { return ''; }
    }

    /** Restore the per-tile terrain store from previously-saved image pixels — accumulates (only
     *  sets opaque pixels, never clears an existing tile). */
    private restoreWorldTerrain(d: Uint8ClampedArray): void {
        const wt = this.worldTerrain;
        for (let k = 0; k < wt.length; k++) { const o = k * 4; if (d[o + 3] < 10) continue; wt[k] = 0xFF000000 | (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]; }
    }

    /** Pull the shipped terrain prebake (build-committed full map) into memory once, so the
     *  offline snapshot can use it synchronously as a fallback. Safe to call repeatedly. */
    private async loadShippedBundles(): Promise<void> {
        if (this.shippedBundles) return;
        try { this.shippedBundles = (await this.terrainCacheStore.load()) || {}; } catch { this.shippedBundles = {}; }
    }
    /** A shipped prebake bundle (parsed) for a map+floor, or any one if no exact match. */
    private shippedBundleFor(id: string, floor: number): any | null {
        const m = this.shippedBundles; if (!m) return null;
        let raw = m[`${id}:${floor}`] ?? m[`${id || 'kcmap'}:0`];
        if (!raw) { const k = Object.keys(m)[0]; if (k) raw = m[k]; }
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }
    /** Best available offline bundle: the user's saved exploration, but with terrain/walls
     *  backfilled from the shipped prebake when the saved one is missing or blank/weak. This
     *  is what stops the "objects but no terrain/walls" offline view (corrupted bundle or a
     *  fresh install that never logged in). */
    private bestOfflineBundle(): any | null {
        const ls = this.loadOfflineBundle();
        const pre = this.shippedBundleFor(ls?.id || this.mapId || 'kcmap', ls?.floor ?? this.currentFloor ?? 0);
        if (!ls) return pre;          // no saved bundle → ship the prebake (fresh install)
        if (!pre) return ls;          // no prebake → whatever we saved
        // Saved bundle is poorer than the prebake — in terrain OR object count → use the whole
        // self-consistent prebake. Grafting just terrain would leave the POIs/icons that also
        // went missing, and mixing icon indices across bundles is unsafe (ob→ic, pi→mm refs).
        const obc = (x: any) => Array.isArray(x?.ob) ? x.ob.length : 0;
        if (this.terrainScore(ls) < this.terrainScore(pre) * 0.85 || obc(ls) < obc(pre) * 0.85) return pre;
        return ls;
    }

    /** The live click-to-move destination (the vanilla minimap flag target), or null. */
    private getMoveDest(): { x: number; z: number } | null {
        const mm = this.gm?.minimap;
        if (mm && mm.destX != null && mm.destZ != null) return { x: mm.destX, z: mm.destZ };
        return null;
    }

    public async exportMap(): Promise<void> {
        const data = this.buildMapSnapshot();
        if (!data) { this.warn('export: map data not loaded (log in / open the map first)'); return; }
        this.downloadFile(`evilquest-map-${this.mapId || 'world'}.html`, this.buildExportHtml(data));
        this.info(`export: done — ${data.ob.length} markers, ${data.ic.length} icons, ${data.pi.length} POIs.`);
    }

    /** Open the World Map in a separate, movable/resizable OS window (so the user can keep
     *  playing the game underneath). The window runs the same interactive viewer as the
     *  HTML export; the game renderer streams it live data (player position frequently, a
     *  full snapshot occasionally) over IPC. */
    /** Mobile (Capacitor WebView) has no detached OS window — the map is overlay-only there.
     *  Set by the mobile shell (window.EvilLiteMobile); also reflected in electron.process.platform. */
    private get isMobile(): boolean {
        return !!(window as any).EvilLiteMobile || (window as any).electron?.process?.platform === 'android' || (window as any).electron?.process?.platform === 'ios';
    }

    /** Entry point (sidebar icon / M-key): toggle the map — open in the user's mode, or close
     *  if it's already open (re-tap / press M again closes). */
    public openMap(): void {
        if (this.viewerOpen()) { this.closeViewer(); return; }
        if (this.isMobile || this.mapMode === 'overlay') this.openOverlayHost();
        else this.openWindowHost();
    }

    /** Close whichever host is open. */
    private closeViewer(): void {
        if (this.overlayEl) this.closeOverlayHost();
        if (this.mapWindowOpen) { const ipc = (window as any).electron?.ipcRenderer; ipc?.send('map-window:close'); this.mapWindowOpen = false; }
    }
    /** Back-compat alias (chat-link handoff, older call sites). */
    public openMapWindow(): void { this.openMap(); }

    /** Host A — detached OS window (IPC transport). */
    private openWindowHost(): void {
        const ipc = (window as any).electron?.ipcRenderer;
        if (!ipc?.send) { this.warn('map window: IPC unavailable'); return; }
        if (this.mapWindowOpen) { ipc.send('map-window:focus'); return; }
        this.refreshData();
        const snap = this.buildMapSnapshot();
        if (!snap) { this.warn('map: data not ready (log in / move around first)'); return; }
        ipc.send('map-window:open', this.buildMapWindowHtml(snap, 'window'));
        this.mapWindowOpen = true;
        if (!this.mwCloseHooked) {
            this.mwCloseHooked = true;
            ipc.on?.('map-window:closed', () => { this.mapWindowOpen = false; if (!this.overlayEl) this.stopMapWindowUpdates(); });
            ipc.on?.('map-window:input', (_e: any, msg: any) => this.handleMapWindowInput(msg));
        }
        this.startMapWindowUpdates();
        this.info('map opened (window).');
    }

    /** Host B — in-page overlay docked over the game, rendered in a SHADOW ROOT (not an iframe).
     *
     *  Why shadow DOM, not an iframe: the game's anti-bot input-ticket system listens for trusted
     *  pointerdowns on the game `window` (window.addEventListener('pointerdown',_,true)) and mints an
     *  input ticket the next command borrows. A click inside an iframe fires on the iframe's SEPARATE
     *  window, which the game never sees — so iframe click-to-move ships with inputSeq=0 and the server
     *  rejects it (the "slingshot"). A shadow root lives in the GAME's document: your real click is a
     *  trusted pointerdown the game DOES register, and our synchronous move (sendInput → __wmInlineSend
     *  → handleMapWindowInput, all in the click's call stack) rides that genuine ticket. Same CSS
     *  isolation as the iframe, but the click is real and in-context — nothing faked. */
    private openOverlayHost(): void {
        if (this.overlayEl) return;
        this.refreshData();
        const snap = this.buildMapSnapshot();
        if (!snap) { this.warn('map: data not ready (log in / move around first)'); return; }
        const full = this.buildMapWindowHtml(snap, 'overlay');
        // Split the self-contained viewer document into its <style>, body markup, and <script> IIFE.
        const css = (full.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
        const markup = (full.match(/<body>([\s\S]*?)<script>/) || [, ''])[1];
        const script = (full.match(/<script>([\s\S]*?)<\/script><\/body>/) || [, ''])[1];

        const el = document.createElement('div');
        el.id = 'eq-wm-overlay';
        const m = this.isMobile;
        Object.assign(el.style, m
            ? { position: 'fixed', inset: '0', zIndex: '2147483640', overflow: 'hidden', background: '#101012' }
            : { position: 'fixed', top: '40px', left: '40px', right: '40px', bottom: '40px', zIndex: '2147483640', boxShadow: '0 6px 28px rgba(0,0,0,.6)', border: '1px solid #333', borderRadius: '6px', overflow: 'hidden', background: '#101012' });
        const root = el.attachShadow({ mode: 'open' });
        // The viewer assumes a <body> (base styles + `body.side-open #side` + body.classList toggles).
        // A shadow root has no body and ShadowRoot has no classList, so wrap the markup in #wmbody
        // and retarget that one selector. :host carries the base typography the original put on body.
        const cssFixed = css.replace(/body\.side-open/g, '#wmbody.side-open');
        root.innerHTML = '<style>:host{display:block;background:#101012;color:#e8e8e8;font:13px/1.4 Inter,system-ui,sans-serif;overflow:hidden}'
            + '#wmbody{height:100%;display:block}#app{height:100%!important}'
            + cssFixed + '</style><div id="wmbody">' + markup + '</div>';
        document.body.appendChild(el);
        this.overlayEl = el; this.overlayShadow = root; this.overlayFrame = null;

        // Synchronous, in-context move dispatch so the click rides its own freshly-minted input ticket.
        (window as any).__wmInlineSend = (msg: any) => this.handleMapWindowInput(msg);
        this.hookOverlayMessages();
        // Run the viewer script with `document` scoped to the shadow root (so its getElementById/
        // querySelector hit the overlay's own DOM, not the game's).
        try {
            // eslint-disable-next-line no-new-func
            new Function('document', script)(this.makeShadowDocShim(root));
        } catch (e) { this.warn('overlay viewer failed: ' + e); }
        this.postToOverlay({ full: snap, p: snap.p });
        this.startMapWindowUpdates();
        this.info('map opened (overlay).');
    }

    /** A minimal `document` shim that points element lookups at the overlay's shadow root while
     *  leaving element creation / global event registration on the real document. */
    private makeShadowDocShim(root: ShadowRoot): any {
        const real = document;
        return {
            getElementById: (id: string) => root.getElementById(id),
            querySelector: (s: string) => root.querySelector(s),
            querySelectorAll: (s: string) => root.querySelectorAll(s),
            createElement: (t: string) => real.createElement(t),
            createElementNS: (ns: string, t: string) => real.createElementNS(ns, t),
            createTextNode: (t: string) => real.createTextNode(t),
            // body → the #wmbody wrapper (a real element with classList); head → the shadow root
            // (so injected <style> stays scoped to the overlay, not leaked into the game).
            get body() { return (root.getElementById('wmbody') || root) as any; },
            get head() { return root as any; },
            addEventListener: (...a: any[]) => (real.addEventListener as any)(...a),
            removeEventListener: (...a: any[]) => (real.removeEventListener as any)(...a),
        };
    }

    /** Receive input (click-move / floor / mode / close) from the overlay viewer. */
    private hookOverlayMessages(): void {
        if (this.overlayMsgHooked) return;
        this.overlayMsgHooked = true;
        window.addEventListener('message', (e: MessageEvent) => {
            const d: any = e.data;
            if (d && d.__wmInput) this.handleMapWindowInput(d.__wmInput);
        });
    }

    private closeOverlayHost(): void {
        if (this.overlayEl) { try { this.overlayEl.remove(); } catch { /* ignore */ } }
        this.overlayEl = null; this.overlayFrame = null; this.overlayShadow = null;
        try { delete (window as any).__wmInlineSend; } catch { /* ignore */ }
        if (!this.mapWindowOpen) this.stopMapWindowUpdates();
    }

    private postToOverlay(payload: any): void {
        // Shadow viewer runs in the game window — deliver data updates via a window message it
        // already listens for. (Async is fine for data; only the MOVE must be synchronous.)
        if (this.overlayShadow) { try { window.postMessage({ __wmUpdate: payload }, '*'); } catch { /* ignore */ } return; }
        try { this.overlayFrame?.contentWindow?.postMessage({ __wmUpdate: payload }, '*'); } catch { /* ignore */ }
    }
    /** Push a data payload to whichever host(s) are currently open. */
    private pushToViewer(payload: any): void {
        if (this.mapWindowOpen) { const ipc = (window as any).electron?.ipcRenderer; ipc?.send('map-window:update', payload); }
        if (this.overlayShadow) this.postToOverlay(payload);
    }

    /** The ⇄ toggle: switch between window and overlay hosts, remembering the choice. */
    private switchMode(): void {
        if (this.isMobile) return; // overlay-only on mobile — no detached OS window to switch to
        const target: 'window' | 'overlay' = this.mapMode === 'window' ? 'overlay' : 'window';
        if (this.mapMode === 'window' && this.mapWindowOpen) {
            const ipc = (window as any).electron?.ipcRenderer; ipc?.send('map-window:close'); this.mapWindowOpen = false;
        }
        if (this.mapMode === 'overlay') this.closeOverlayHost();
        this.mapMode = target; this.saveFilterState();
        if (target === 'overlay') this.openOverlayHost(); else this.openWindowHost();
    }

    /** Re-attach to a detached map window that survived a renderer reload (the game's 5-min
     *  AFK kick reloads client.html; the window lives in the main process and stays open).
     *  Without this the window sits frozen on its last frame until the user closes+reopens it.
     *  Asks the main process if the window exists and, if so, resumes streaming + reloads its
     *  content with a fresh snapshot. Best-effort + idempotent (guarded by mapWindowOpen). */
    private async reattachMapWindow(): Promise<void> {
        const ipc = (window as any).electron?.ipcRenderer;
        if (!ipc?.invoke || !ipc?.send || this.mapWindowOpen) return;
        let exists = false;
        try { exists = await ipc.invoke('map-window:exists'); } catch { return; }
        if (!exists || this.mapWindowOpen) return;
        this.mapWindowOpen = true;
        if (!this.mwCloseHooked) {
            this.mwCloseHooked = true;
            ipc.on?.('map-window:closed', () => { this.mapWindowOpen = false; this.stopMapWindowUpdates(); });
            ipc.on?.('map-window:input', (_e: any, msg: any) => this.handleMapWindowInput(msg));
        }
        try { this.refreshData(); } catch { /* not in-world yet — offline bundle still works */ }
        const snap = this.buildMapSnapshot(); // offline bundle pre-login, live once warmed up
        if (snap) ipc.send('map-window:open', this.buildMapWindowHtml(snap)); // main reloads the existing window
        this.startMapWindowUpdates();
        this.info('map window re-attached after reload.');
    }

    /** Hand a click-to-move to the game — SYNCHRONOUSLY, from within the user's real click.
     *
     *  The slingshot was an anti-bot rejection, not a movement bug: the game stamps each command
     *  with an inputSeq from a ticket minted by a trusted browser pointerdown the game's own
     *  window-capture listener sees. A move with no ticket ships inputSeq=0 and the server discards
     *  it as an inputless (bot) command → snapback. So this MUST run in the same call stack as the
     *  real click (overlay shadow-DOM → sendInput → __wmInlineSend → here), inside the 350ms input
     *  ticket burst, so it borrows the genuine click's ticket. Any deferral (timers, queues) fires
     *  outside the burst → inputSeq=0 → rejected, which is why earlier attempts failed.
     *
     *  Only valid from the overlay: there the click is a real, in-renderer pointerdown the game
     *  registers. The popout window is a separate renderer the game never sees, so its clicks can't
     *  be authorized — it's view-only (faking that authorization would be defeating the anti-bot
     *  system, which we don't do). */
    private dispatchMapMove(worldX: number, worldZ: number): void {
        if (!this.overlayShadow) return; // popout window = view-only (no real in-renderer click)
        const gm = this.gm;
        gm?.minimap?.onClickMove?.(worldX, worldZ, worldX, worldZ);
    }

    /** Apply an action forwarded from the detached map window back to the live game. */
    private handleMapWindowInput(msg: any): void {
        if (!msg) return;
        if (msg.t === 'move') {
            // Walk toward the clicked tile (mirrors the in-game overlay's click-to-move).
            let worldX = msg.x, worldZ = msg.z;
            const player = this.getPlayerPos();
            if (player) {
                const dx = worldX - player.x, dz = worldZ - player.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                // Clamp a far click to the game's overlay reach. The slingshot is solved (a shadow-DOM
                // click now mints a real input ticket — see [[project_map_movement_inputticket]]), so
                // this is no longer a desync workaround, just keeping a single click within what one
                // move can express: the client's MAX_OVERLAY_DIST_SQ = 2025 → √ = 45 tiles, and the
                // move packet caps at 50 path nodes (sendMove: Math.min(t.length,50)). 45 is the
                // game's named overlay distance and sits safely under the send cap. Click again to
                // keep walking past it.
                const MAX_CLICK_DIST = 45; // √(GameManager MAX_OVERLAY_DIST_SQ = 2025)
                if (dist > MAX_CLICK_DIST) { const r = MAX_CLICK_DIST / dist; worldX = player.x + dx * r; worldZ = player.z + dz * r; }
            }
            this.dispatchMapMove(worldX, worldZ);
        } else if (msg.t === 'floor') {
            const f = Math.max(0, Math.min(8, msg.f | 0));
            if (f !== this.currentFloor) {
                this.currentFloor = f;
                this.worldCanvas = null;
                this.refreshData();
                const snap = this.buildMapSnapshot();
                if (snap) this.pushToViewer({ full: snap, p: snap.p });
            }
        } else if (msg.t === 'mode') {
            this.switchMode();
        } else if (msg.t === 'close') {
            if (this.overlayEl) this.closeOverlayHost();
            else if (this.mapWindowOpen) { const ipc = (window as any).electron?.ipcRenderer; ipc?.send('map-window:close'); }
        } else if (msg.t === 'chat') {
            const textToCopy = msg.text;
            const chatInput = document.getElementById('chat-input') as HTMLInputElement;
            if (chatInput) {
                const currentVal = chatInput.value.trim();
                chatInput.value = currentVal ? `${currentVal} ${textToCopy}` : textToCopy;
                chatInput.focus();
            } else {
                this.setStatus('Chat input not found.');
            }
            // After sharing, close the map if it's the in-page OVERLAY so the chat (+ the
            // shared link) is visible underneath — always the case on mobile. A detached
            // WINDOW/popout doesn't block chat, so it stays open.
            if (this.overlayEl) this.closeOverlayHost();
        }
    }

    private viewerOpen(): boolean { return this.mapWindowOpen || !!this.overlayEl; }

    private startMapWindowUpdates(): void {
        this.stopMapWindowUpdates();
        // Frequent + cheap: keep the data store fresh and stream the player position.
        this.mapWindowTimer = setInterval(() => {
            if (!this.viewerOpen()) return;
            this.refreshData();
            const p = this.getPlayerPos();
            // Player position + live entities stream frequently so the viewer feels live.
            const npc = this.liveNpcs.filter((n) => (n.floor ?? 0) === this.currentFloor).map((n) => {
                // Resolve the icon into the array the viewer already holds (from the last full
                // snapshot) so live NPCs keep their model icon between full snapshots, not a dot.
                const im = this.getNpcIcon(n.defId);
                const i = (im && im.complete && im.naturalWidth && im.src.startsWith('data:') && this.lastIconIdx) ? (this.lastIconIdx.get(im.src) ?? -1) : -1;
                return { x: n.x, z: n.z, n: this.prettify(n.name), l: n.level ?? 0, i };
            });
            const pl = this.players.map((q) => ({ x: q.x, z: q.z, n: q.name }));
            this.pushToViewer({ p: p ? { x: p.x, z: p.z, a: this.getPlayerAngle() } : null, npc, pl, online: !!p, dest: this.getMoveDest() });
        }, 280);
        // Occasional + heavy: full snapshot — but ONLY when the MARKERS change (a new object/NPC
        // type), NOT on every explored tile. buildMapSnapshot's terrain encode + serialization is a
        // ~100ms main-thread block; running it as you walk (explored-tile count always growing) froze
        // the game's movement tick and snapped the player back (the click-to-move "slingshot").
        this.mapWindowFullTimer = setInterval(() => {
            if (!this.viewerOpen()) return;
            this.refreshData();
            const sig = this.objectStore.size + ':' + this.liveEphemeral.length + ':' + this.currentFloor;
            if (sig === this.lastFullSig) return; // markers unchanged → skip the heavy rebuild/push
            this.lastFullSig = sig;
            const snap = this.buildMapSnapshot();
            if (snap) this.pushToViewer({ full: snap, p: snap.p });
        }, 7000);
        // Terrain is refreshed on its own timer and encoded OFF the main thread (toBlob), so newly
        // explored tiles appear without ever blocking the game's movement tick.
        this.mapTerrainTimer = setInterval(() => {
            if (!this.viewerOpen()) return;
            this.refreshTerrainAsync();
        }, 5000);
    }

    private stopMapWindowUpdates(): void {
        if (this.mapWindowTimer) { clearInterval(this.mapWindowTimer); this.mapWindowTimer = null; }
        if (this.mapWindowFullTimer) { clearInterval(this.mapWindowFullTimer); this.mapWindowFullTimer = null; }
        if (this.mapTerrainTimer) { clearInterval(this.mapTerrainTimer); this.mapTerrainTimer = null; }
    }

    /** Re-encode the terrain PNG OFF the main thread (canvas.toBlob is async, unlike the blocking
     *  toDataURL) and stream it to the viewer when explored tiles have changed — so the map fills in
     *  as you walk without ever freezing the game's movement tick. */
    private refreshTerrainAsync(): void {
        if (this.terrainEncoding) return;
        const cm = this.getChunkManager();
        if (!cm || !this.rebuildWorldCanvas(cm) || !this.worldCanvas) return;
        if (!this.terrainDirty) return; // canvas unchanged since last encode → nothing to send
        this.terrainDirty = false;
        this.terrainEncoding = true;
        try {
            this.worldCanvas.toBlob((blob) => {
                this.terrainEncoding = false;
                if (!blob) return;
                const fr = new FileReader();
                fr.onload = () => { this.terrainUrl = fr.result as string; this.pushToViewer({ terrain: this.terrainUrl }); this.persistTerrainToBundle(); };
                fr.onerror = () => {};
                fr.readAsDataURL(blob);
            }, 'image/png');
        } catch { this.terrainEncoding = false; this.terrainDirty = true; }
    }

    /** A self-contained interactive viewer that re-renders the exported data exactly like
     *  the live World Map (terrain scaling, icon sizing, category filters, POIs, search).
     *  In `live` mode it also draws the player marker and accepts data updates over IPC
     *  (used by the detached map window). */
    private buildExportHtml(data: any, live = false): string {
        const json = JSON.stringify(data);
        return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
+ '<title>EvilQuest World Map - ' + data.id + '</title><style>'
+ 'html,body{margin:0;height:100%;background:#111;color:#eee;font:13px/1.4 Inter,system-ui,sans-serif;overflow:hidden}'
+ '#app{display:flex;height:100%}#side{width:220px;flex:none;background:#1b1b1b;border-right:1px solid #333;display:flex;flex-direction:column}'
+ '#side h1{font-size:14px;margin:0;padding:10px 12px;border-bottom:1px solid #333}#q{margin:8px;padding:6px 8px;border:1px solid #444;border-radius:4px;background:#111;color:#fff}'
+ '#layers{padding:6px 12px;border-bottom:1px solid #333}#layers label,#cats label{display:block;padding:3px 0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
+ '#cats{overflow:auto;flex:1;padding:6px 10px}#cats .cat{margin-bottom:1px}'
+ '#cats .chead{display:flex;align-items:center;padding:3px 0}#cats .chead .cn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}'
+ '#cats .exp{cursor:pointer;padding:0 5px;color:#9aa;user-select:none}#cats .subs{padding-left:20px}'
+ '#cats .sub{display:block;padding:2px 0;font-size:12px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}'
+ '#cats .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 6px;vertical-align:middle}'
+ '#cats .ci{width:20px;height:20px;object-fit:contain;vertical-align:middle;margin:0 5px;flex:none}#cats .sub .ci{width:16px;height:16px}'
+ '#view{flex:1;position:relative;overflow:hidden;background:#0a0a0a;cursor:grab}#view.drag{cursor:grabbing}#c{position:absolute;inset:0}'
+ '#tip{position:absolute;background:#000d;border:1px solid #444;border-radius:4px;padding:4px 7px;font-size:12px;pointer-events:none;display:none;max-width:240px}'
+ '#hint{position:absolute;right:8px;bottom:8px;background:#000a;padding:4px 8px;border-radius:4px;font-size:11px;pointer-events:none}'
+ '</style></head><body><div id="app"><div id="side"><h1>World Map - ' + data.id + '</h1>'
+ '<input id="q" placeholder="Search..."><div id="layers"><label><input type="checkbox" id="L_ic" checked> Model icons</label>'
+ '<label><input type="checkbox" id="L_poi" checked> Minimap markers</label><label><input type="checkbox" id="L_lab"> Labels</label></div>'
+ '<div id="cats"></div></div><div id="view"><canvas id="c"></canvas><div id="tip"></div><div id="hint">drag to pan - scroll to zoom</div></div></div>'
+ '<script>(function(){var D=' + json + ';'
+ 'var view=document.getElementById("view"),cv=document.getElementById("c"),ctx=cv.getContext("2d"),tip=document.getElementById("tip"),q=document.getElementById("q");'
+ 'var terrain=new Image();terrain.src=D.t;var ICONS=D.ic.map(function(s){var i=new Image();i.src=s;return i;});var MM=D.mm.map(function(s){var i=new Image();i.src=s;return i;});'
+ 'var ICONS_S=new Array(ICONS.length);function shadowed(idx){if(ICONS_S[idx])return ICONS_S[idx];var im=ICONS[idx];if(!im||!im.complete||!im.naturalWidth)return null;var pad=4;var c=document.createElement("canvas");c.width=im.naturalWidth+pad*2;c.height=im.naturalHeight+pad*2;var x=c.getContext("2d");x.shadowColor="rgba(0,0,0,.55)";x.shadowBlur=2;x.drawImage(im,pad,pad);ICONS_S[idx]=c;return c;}'
+ 'var TAX={},nameOn={};D.ob.forEach(function(o){if(!TAX[o.c])TAX[o.c]={};TAX[o.c][o.n]=(TAX[o.c][o.n]||0)+o.k;});Object.keys(TAX).forEach(function(c){Object.keys(TAX[c]).forEach(function(n){nameOn[c+"|"+n]=true;});});var showIcons=true,showPoi=true,showLab=false;'
+ 'var cx=D.W/2,cz=D.H/2,Z=4,W=0,Hh=0,hits=[];'
+ 'function resize(){var r=view.getBoundingClientRect();W=cv.width=Math.floor(r.width);Hh=cv.height=Math.floor(r.height);render();}'
+ 'function clamp(v,a,b){return Math.max(a,Math.min(v,b));}'
+ 'function render(){if(!W)return;hits=[];ctx.fillStyle="#0a0a0a";ctx.fillRect(0,0,W,Hh);'
+ 'var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);'
+ 'if(terrain.complete&&terrain.naturalWidth){ctx.imageSmoothingEnabled=true;ctx.save();ctx.translate(-sl*Z,-st*Z);ctx.scale(Z,Z);ctx.drawImage(terrain,0,0);ctx.restore();}'
+ 'if(D.wl&&D.wl.length){ctx.fillStyle="rgb(220,216,200)";var wt=Math.max(1.5,Z*0.15);for(var wi=0;wi<D.wl.length;wi+=3){var wx=D.wl[wi],wz=D.wl[wi+1],wf=D.wl[wi+2];var wsx=(wx-sl)*Z,wsy=(wz-st)*Z;if(wsx<-Z||wsx>W+Z||wsy<-Z||wsy>Hh+Z)continue;if(wf&1)ctx.fillRect(wsx,wsy,Z,wt);if(wf&4)ctx.fillRect(wsx,wsy+Z-wt,Z,wt);if(wf&8)ctx.fillRect(wsx,wsy,wt,Z);if(wf&2)ctx.fillRect(wsx+Z-wt,wsy,wt,Z);}}'
+ 'if(showIcons){for(var j=0;j<D.ob.length;j++){var o=D.ob[j];if(nameOn[o.c+"|"+o.n]===false)continue;var sx=(o.x-sl)*Z,sy=(o.z-st)*Z;if(sx<-30||sx>W+30||sy<-30||sy>Hh+30)continue;'
+ 'var hr;var sc=o.i>=0?shadowed(o.i):null;if(sc){var iim=ICONS[o.i];var sz=clamp(Z*3,24,50);var k=sz/iim.naturalWidth,dw=sc.width*k,dh=sc.height*k;ctx.globalAlpha=o.d?0.45:1;ctx.drawImage(sc,sx-dw/2,sy-dh/2,dw,dh);ctx.globalAlpha=1;hr=sz/2;}'
+ 'else{var col=(D.ct.filter(function(c){return c.n==o.c;})[0]||{c:"#ffd24a"}).c;var br=clamp(Z*0.55,3,9);ctx.fillStyle=col;ctx.globalAlpha=o.d?0.4:1;ctx.beginPath();ctx.arc(sx,sy,br,0,6.28);ctx.fill();ctx.globalAlpha=1;hr=br;}'
+ 'if(o.k>1){ctx.fillStyle="#c0392b";ctx.beginPath();ctx.arc(sx+hr*0.8,sy-hr*0.8,6,0,6.28);ctx.fill();ctx.fillStyle="#fff";ctx.font="9px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(o.k>9?"9+":""+o.k,sx+hr*0.8,sy-hr*0.8);}'
+ 'hits.push({sx:sx,sy:sy,r:hr,n:o.n+(o.k>1?" +"+(o.k-1):""),s:o.c+" - "+o.x+","+o.z});'
+ 'if(showLab){ctx.fillStyle="#fff";ctx.font="11px sans-serif";ctx.textAlign="center";ctx.textBaseline="bottom";ctx.shadowColor="#000";ctx.shadowBlur=3;ctx.fillText(o.n,sx,sy-hr-2);ctx.shadowBlur=0;}}}'
+ 'if(showPoi){for(var p=0;p<D.pi.length;p++){var P=D.pi[p];var px=(P.x-sl)*Z,py=(P.z-st)*Z;if(px<-30||px>W+30||py<-30||py>Hh+30)continue;var u=P.s;'
+ 'ctx.save();ctx.globalAlpha=0.7;ctx.fillStyle="rgba(0,0,0,.68)";ctx.beginPath();ctx.arc(px,py,u*0.55,0,6.28);ctx.fill();ctx.restore();'
+ 'if(P.m>=0&&MM[P.m].complete&&MM[P.m].naturalWidth)ctx.drawImage(MM[P.m],px-u/2,py-u/2,u,u);hits.push({sx:px,sy:py,r:u/2,n:P.n,s:P.x+","+P.z});}}'
+ 'if(D.p){var ppx=(D.p.x-sl)*Z,ppy=(D.p.z-st)*Z;ctx.save();ctx.fillStyle="#19b9ff";ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.arc(ppx,ppy,6,0,6.28);ctx.fill();ctx.stroke();ctx.restore();}'
+ '}'
+ 'function fit(){var pad=10;Z=clamp(Math.min(W/(D.W+pad),Hh/(D.H+pad)),0.3,48);cx=D.W/2;cz=D.H/2;render();}'
+ 'var dragging=false,lx=0,ly=0,moved=false;'
+ 'view.addEventListener("mousedown",function(e){if(e.button!==0)return;dragging=true;moved=false;lx=e.clientX;ly=e.clientY;view.classList.add("drag");});'
+ 'window.addEventListener("mouseup",function(){dragging=false;view.classList.remove("drag");});'
+ 'view.addEventListener("mousemove",function(e){if(dragging){var dx=e.clientX-lx,dy=e.clientY-ly;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;cx-=dx/Z;cz-=dy/Z;lx=e.clientX;ly=e.clientY;render();tip.style.display="none";return;}'
+ 'var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}'
+ 'if(best){tip.style.display="block";tip.style.left=(mx+14)+"px";tip.style.top=(my+10)+"px";tip.innerHTML="<b>"+best.n+"</b><br>"+best.s;}else tip.style.display="none";});'
+ 'view.addEventListener("wheel",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var f=e.deltaY<0?1.15:1/1.15;Z=clamp(Z*f,0.3,48);cx=wx+W/(2*Z)-mx/Z;cz=wz+Hh/(2*Z)-my/Z;render();},{passive:false});'
+ 'view.addEventListener("contextmenu",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var textToCopy="("+Math.round(wx)+","+Math.round(wz)+")";var best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}if(best){textToCopy+="["+best.n.replace(/\\s*\\+\\d+$/,"").trim()+"]";}var m=document.getElementById("eq-map-context-menu");if(m)m.remove();m=document.createElement("div");m.id="eq-map-context-menu";m.style.cssText="position:fixed;left:"+e.clientX+"px;top:"+e.clientY+"px;background:#473e32;border:1px solid #1a1612;border-top-color:#72624d;border-left-color:#72624d;z-index:10000;box-shadow:2px 2px 4px rgba(0,0,0,0.5);user-select:none;min-width:120px;font-family:sans-serif;";var hdr=document.createElement("div");hdr.style.cssText="background:#362e24;padding:4px 8px;border-bottom:1px solid #1a1612;color:#ffd24a;font-weight:bold;text-align:center;font-size:12px;cursor:default";hdr.textContent="Select an Option";m.appendChild(hdr);var itm=document.createElement("div");itm.style.cssText="padding:6px 10px;cursor:pointer;color:#fff;font-size:13px";itm.textContent="Share "+textToCopy;itm.onmouseenter=function(){itm.style.background="#5c5040";};itm.onmouseleave=function(){itm.style.background="transparent";};itm.onclick=function(ev){ev.stopPropagation();m.remove();if(typeof sendInput!=="undefined"){sendInput({t:"chat",text:textToCopy});}else if(window.electron&&window.electron.ipcRenderer){window.electron.ipcRenderer.send("map-window:input",{t:"chat",text:textToCopy});}};if(D.online){var itm2=document.createElement("div");itm2.style.cssText="padding:6px 10px;cursor:pointer;color:#fff;font-size:13px";itm2.textContent="Walk Here";itm2.onmouseenter=function(){itm2.style.background="#5c5040";};itm2.onmouseleave=function(){itm2.style.background="transparent";};itm2.onclick=function(ev){ev.stopPropagation();m.remove();if(typeof sendInput!=="undefined"){sendInput({t:"move",x:wx,z:wz});}else if(window.electron&&window.electron.ipcRenderer){window.electron.ipcRenderer.send("map-window:input",{t:"move",x:wx,z:wz});}};m.appendChild(itm2);}m.appendChild(itm);document.body.appendChild(m);var closeM=function(ev){var pth=(ev.composedPath&&ev.composedPath())||[];if(!m.contains(ev.target)&&pth.indexOf(m)<0){m.remove();window.removeEventListener("mousedown",closeM);}};setTimeout(function(){window.addEventListener("mousedown",closeM);},0);});'
+ 'function goTo(x,z){Z=Math.max(Z,16);cx=x+0.5;cz=z+0.5;render();}'
+ 'function buildTax(){var box=document.getElementById("cats");box.innerHTML="";var esc=function(t){var d=document.createElement("span");d.textContent=t;return d.innerHTML;};'
+ 'var catIcon={},nameIcon={};D.ob.forEach(function(o){if(o.i>=0){if(catIcon[o.c]===undefined)catIcon[o.c]=o.i;if(nameIcon[o.c+"|"+o.n]===undefined)nameIcon[o.c+"|"+o.n]=o.i;}});'
+ 'var swatch=function(i,col){return i!==undefined?"<img class=ci src=\\""+D.ic[i]+"\\">":"<span class=sw style=background:"+col+"></span>";};'
+ 'Object.keys(TAX).sort().forEach(function(c){var col=(D.ct.filter(function(x){return x.n==c;})[0]||{c:"#ffd24a"}).c;var names=Object.keys(TAX[c]).sort();var tot=0;names.forEach(function(n){tot+=TAX[c][n];});'
+ 'var g=document.createElement("div");g.className="cat";var head=document.createElement("div");head.className="chead";'
+ 'head.innerHTML="<input type=checkbox class=cc checked>"+swatch(catIcon[c],col)+"<span class=cn>"+esc(c)+" ("+tot+")</span><span class=exp>\\u25b8</span>";'
+ 'var subs=document.createElement("div");subs.className="subs";subs.style.display="none";'
+ 'names.forEach(function(n){var l=document.createElement("label");l.className="sub";l.innerHTML="<input type=checkbox class=nc checked>"+swatch(nameIcon[c+"|"+n],col)+esc(n)+" ("+TAX[c][n]+")";'
+ 'var nb=l.querySelector("input");nb.onchange=function(){nameOn[c+"|"+n]=nb.checked;var any=names.some(function(x){return nameOn[c+"|"+x]!==false;});head.querySelector(".cc").checked=any;render();};subs.appendChild(l);});'
+ 'var cc=head.querySelector(".cc");cc.onchange=function(){var on=cc.checked;names.forEach(function(n){nameOn[c+"|"+n]=on;});subs.querySelectorAll(".nc").forEach(function(x){x.checked=on;});render();};'
+ 'head.querySelector(".exp").onclick=function(){var open=subs.style.display==="none";subs.style.display=open?"block":"none";this.textContent=open?"\\u25be":"\\u25b8";};'
+ 'g.appendChild(head);g.appendChild(subs);box.appendChild(g);});}'
+ 'document.getElementById("L_ic").onchange=function(e){showIcons=e.target.checked;render();};document.getElementById("L_poi").onchange=function(e){showPoi=e.target.checked;render();};document.getElementById("L_lab").onchange=function(e){showLab=e.target.checked;render();};'
+ 'q.oninput=function(){var s=q.value.trim().toLowerCase();if(!s)return;var best=null,bd=1e9;function consider(x,z,n){if(n.toLowerCase().indexOf(s)<0)return;var d=(x-cx)*(x-cx)+(z-cz)*(z-cz);if(d<bd){bd=d;best=[x,z];}}D.ob.forEach(function(o){consider(o.x,o.z,o.n+" "+o.c);});D.pi.forEach(function(P){consider(P.x,P.z,P.n);});if(best)goTo(best[0],best[1]);};'
+ 'buildTax();window.addEventListener("resize",resize);var ld=0;[terrain].concat(ICONS,MM).forEach(function(im){im.addEventListener("load",function(){if(++ld%40==0)render();});});setTimeout(render,400);setTimeout(render,1500);'
+ (live ? ('var follow=true;'
  + 'if(window.electron&&window.electron.ipcRenderer&&window.electron.ipcRenderer.on){window.electron.ipcRenderer.on("map-window:update",function(e,u){if(!u)return;'
  + 'if(u.full){var nd=u.full;D.t=nd.t;terrain=new Image();terrain.src=D.t;D.ic=nd.ic;ICONS=D.ic.map(function(s){var i=new Image();i.src=s;return i;});D.ob=nd.ob;D.ct=nd.ct;D.pi=nd.pi;D.mm=nd.mm;MM=D.mm.map(function(s){var i=new Image();i.src=s;return i;});D.W=nd.W;D.H=nd.H;'
  + 'TAX={};D.ob.forEach(function(o){if(!TAX[o.c])TAX[o.c]={};TAX[o.c][o.n]=(TAX[o.c][o.n]||0)+o.k;});Object.keys(TAX).forEach(function(c){Object.keys(TAX[c]).forEach(function(n){if(nameOn[c+"|"+n]===undefined)nameOn[c+"|"+n]=true;});});buildTax();}'
  + 'if(u.p!==undefined){D.p=u.p;if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;}}render();});}'
  + 'var fb=document.createElement("label");fb.style.cssText="display:block;padding:3px 0;cursor:pointer";fb.innerHTML="<input type=checkbox id=L_follow checked> Follow player";document.getElementById("layers").appendChild(fb);'
  + 'document.getElementById("L_follow").onchange=function(e){follow=e.target.checked;if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;render();}};'
  + 'view.addEventListener("mousedown",function(){var fc=document.getElementById("L_follow");if(fc&&fc.checked){fc.checked=false;follow=false;}});')
  : '')
+ 'resize();fit();})();</script></body></html>';
    }

    /** The detached map window's viewer. Renders the live snapshot locally (terrain, icons,
     *  POIs, NPCs, players, player marker) with the in-game overlay's controls (search, floor
     *  stepper, follow, filters). When the game is live it receives streamed data updates and
     *  forwards click-to-move / floor changes back over IPC; offline it stays a static
     *  snapshot with Follow greyed out. */
    private buildMapWindowHtml(data: any, host: 'window' | 'overlay' = 'window'): string {
        const json = JSON.stringify(data);
        // The window is a file:// page (cross-origin to evilquest.net), so it can't rotate the
        // stone tile itself — use the pre-baked rotated data URL, falling back to the raw tile.
        const bg = this.stoneTexBaked || 'https://evilquest.net/ui/stone-dark.png';
        return `<!doctype html><html><head><meta charset="utf-8"><title>EvilLite — World Map</title><style>
html,body{margin:0;height:100%;background:#101012;color:#e8e8e8;font:13px/1.4 Inter,system-ui,sans-serif;overflow:hidden;user-select:none}
#app{display:flex;flex-direction:column;height:100vh}
#hdr{display:flex;align-items:center;gap:8px;padding:6px 8px;background:linear-gradient(rgba(15,12,10,.35),rgba(15,12,10,.5)),url("${bg}");border-bottom:1px solid #333}
#hdr h1{font-size:14px;margin:0 4px 0 2px;white-space:nowrap}
#q{flex:1;max-width:240px;padding:5px 8px;border:1px solid #555;border-radius:4px;background:#111;color:#fff;font-size:13px}
.fl{display:flex;align-items:center;gap:1px;background:rgba(0,0,0,.28);border-radius:6px;padding:2px 3px}
.fl button{padding:2px 7px;background:transparent;border:none;border-radius:4px;color:#cfd6dc;font-size:12px;cursor:pointer}
.fl button:hover{background:#3a4046}.fl span{font-weight:600;min-width:50px;text-align:center;font-size:12px}
.btn{padding:5px 12px;border:none;border-radius:4px;color:#fff;font-size:13px;cursor:pointer;white-space:nowrap}
#follow{background:#27ae60}#follow.off{background:#3a3f44}#follow.dis{opacity:.45;cursor:default}
#close{background:transparent;color:#ccc;font-size:16px;padding:4px 9px;line-height:1}#close:hover{background:#e74c3c;color:#fff}
#modeToggle{background:#2f6db0;color:#fff;font-weight:600;border:1px solid #5a9fe0}#modeToggle:hover{background:#3f86d6}
#body{flex:1;display:flex;min-height:0}
#side{width:210px;flex:none;overflow:auto;background:#161616;border-right:1px solid #333;padding:6px 10px}
#layers{padding-bottom:6px;border-bottom:1px solid #333;margin-bottom:6px}
#layers label,#cats label{display:block;padding:3px 0;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cats .cat{margin-bottom:1px}#cats .chead{display:flex;align-items:center;padding:3px 0}
#cats .chead .cn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#cats .exp{cursor:pointer;padding:0 5px;color:#9aa}#cats .subs{padding-left:18px}
#cats .sub{display:block;padding:2px 0;font-size:12px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
#cats .sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin:0 6px;vertical-align:middle}
#cats .ci{width:20px;height:20px;object-fit:contain;vertical-align:middle;margin:0 5px}#cats .sub .ci{width:16px;height:16px}
#view{flex:1;position:relative;overflow:hidden;background:linear-gradient(rgba(8,7,6,.55),rgba(8,7,6,.7)),url("${bg}");cursor:grab}
#view.drag{cursor:grabbing}#c{position:absolute;inset:0}
#tip{position:absolute;background:#000d;border:1px solid #444;border-radius:4px;padding:4px 7px;font-size:12px;pointer-events:none;display:none;max-width:240px}
#hint{position:absolute;right:8px;bottom:8px;background:#000a;padding:4px 8px;border-radius:4px;font-size:11px;pointer-events:none;color:#bbb}
#loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#101012;color:#cbd2d8;font:13px Inter,system-ui,sans-serif;z-index:6}
.lspin{width:34px;height:34px;border:3px solid #2a3038;border-top-color:#19b9ff;border-radius:50%;animation:lspin .8s linear infinite}
@keyframes lspin{to{transform:rotate(360deg)}}
</style></head><body><div id="app">
<div id="hdr"><h1>World Map</h1><input id="q" placeholder="Search objects & NPCs…">
<div class="fl"><button id="fdown" title="Floor down">▾</button><span id="fl">Floor 0</span><button id="fup" title="Floor up">▴</button></div>
<button id="follow" class="btn">◉ Follow</button><button id="modeToggle" class="btn" title="Switch between overlay and window mode">⇆ ${host === 'window' ? 'Overlay' : 'Window'}</button>${host === 'overlay' ? '<button id="close" class="btn" title="Close">✕</button>' : ''}</div>
<div id="body"><div id="side"><div id="layers">
<label><input type="checkbox" id="L_ic" checked> Model icons</label>
<label><input type="checkbox" id="L_poi" checked> Minimap markers</label>
<label id="npcmode" style="cursor:pointer" title="Click to cycle: Off / Stored / Live">NPCs: <b id="npcmodelbl">Live</b></label>
<label><input type="checkbox" id="L_pl" checked> Players</label>
<label><input type="checkbox" id="L_lab"> Labels</label></div><div id="cats"></div></div>
<div id="view"><canvas id="c"></canvas><div id="tip"></div><div id="hint">drag to pan · scroll to zoom · click to walk</div><div id="loading"><div class="lspin"></div><div>Loading map…</div></div></div></div></div>
<script>(function(){var D=${json};
var HOST=${JSON.stringify(host)};
var MOBILE=${this.isMobile};
/* One viewer, two hosts: a detached BrowserWindow talks over IPC; an in-page iframe overlay
   talks over postMessage. sendInput()/applyUpdate() abstract the transport so the rest of the
   viewer is identical in both. */
var IPC=(window.electron&&window.electron.ipcRenderer)?window.electron.ipcRenderer:null;
function sendInput(m){if(window.__wmInlineSend){window.__wmInlineSend(m);return;}if(IPC){IPC.send("map-window:input",m);}else{try{parent.postMessage({__wmInput:m},"*");}catch(e){}}}
var view=document.getElementById("view"),cv=document.getElementById("c"),ctx=cv.getContext("2d"),tip=document.getElementById("tip"),q=document.getElementById("q");
var terrain,ICONS,MM,ICONS_S;
function loadImgs(){terrain=new Image();terrain.onload=function(){var l=document.getElementById("loading");if(l)l.style.display="none";baseSig="";requestRender();};terrain.src=D.t;ICONS=(D.ic||[]).map(function(s){var i=new Image();i.src=s;return i;});ICONS_S=new Array(ICONS.length);MM=(D.mm||[]).map(function(s){var i=new Image();i.src=s;return i;});}
loadImgs();
/* Bake each icon's drop-shadow once into an offscreen canvas; per-icon shadowBlur in the
   draw loop is the single most expensive op, so we drop it and draw the pre-shadowed icon. */
function shadowed(idx){if(ICONS_S[idx])return ICONS_S[idx];var im=ICONS[idx];if(!im||!im.complete||!im.naturalWidth)return null;var pad=4;var c=document.createElement("canvas");c.width=im.naturalWidth+pad*2;c.height=im.naturalHeight+pad*2;var x=c.getContext("2d");x.shadowColor="rgba(0,0,0,.55)";x.shadowBlur=2;x.drawImage(im,pad,pad);ICONS_S[idx]=c;return c;}
var nameOn={};function taxState(){(D.ob||[]).forEach(function(o){if(nameOn[o.c+"|"+o.n]===undefined)nameOn[o.c+"|"+o.n]=true;});}taxState();
/* Which legend categories are expanded — persisted across rebuilds so a full-snapshot
   refresh (every ~7s) never collapses a dropdown the user opened. lastCatSig skips the
   rebuild entirely when the category/name set is unchanged. */
var catOpen={},lastCatSig="";
/* NPC name -> model-icon index, learned from full snapshots; light position-only updates
   reuse it so NPCs keep their 3D model icon between full snapshots. */
var npcIcon={};function buildNpcIcon(){(D.npc||[]).forEach(function(N){if(N.i!==undefined&&N.i>=0)npcIcon[N.n]=N.i;});}buildNpcIcon();
var showIcons=true,showPoi=true,showLab=false,npcMode=2,showPl=true,follow=true;
var cx=D.W/2,cz=D.H/2,Z=4,W=0,Hh=0,hits=[];
function clamp(v,a,b){return Math.max(a,Math.min(v,b));}
/* Render-on-demand: coalesce every change into a single rAF render instead of redrawing
   on a timer. Callers use requestRender(); render() does the actual draw. */
var _raf=null;function requestRender(){if(_raf)return;_raf=requestAnimationFrame(function(){_raf=null;render();});}
function resize(){var r=view.getBoundingClientRect();W=cv.width=Math.floor(r.width);Hh=cv.height=Math.floor(r.height);render();}
/* Static map content (terrain + object icons + POIs) is composited once into an offscreen
   base canvas and reused; it only rebuilds when a signature of view/data/filters changes.
   Dynamic overlays (NPCs, players, the player marker, the destination flag) draw on top
   every frame, so walking / the flag pulse just blits the base + a few dots. */
var base=document.createElement("canvas"),bctx=base.getContext("2d"),baseHits=[],baseSig="",nameVer=0,dataVer=0;
function buildBase(){base.width=W;base.height=Hh;bctx.clearRect(0,0,W,Hh);baseHits=[];
var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);
if(terrain.complete&&terrain.naturalWidth){bctx.imageSmoothingEnabled=true;bctx.save();bctx.translate(-sl*Z,-st*Z);bctx.scale(Z,Z);bctx.drawImage(terrain,0,0);bctx.restore();}
if(D.wl&&D.wl.length){bctx.fillStyle="rgb(220,216,200)";var wt=Math.max(1.5,Z*0.15);for(var wi=0;wi<D.wl.length;wi+=3){var wx=D.wl[wi],wz=D.wl[wi+1],wf=D.wl[wi+2];var wsx=(wx-sl)*Z,wsy=(wz-st)*Z;if(wsx<-Z||wsx>W+Z||wsy<-Z||wsy>Hh+Z)continue;if(wf&1)bctx.fillRect(wsx,wsy,Z,wt);if(wf&4)bctx.fillRect(wsx,wsy+Z-wt,Z,wt);if(wf&8)bctx.fillRect(wsx,wsy,wt,Z);if(wf&2)bctx.fillRect(wsx+Z-wt,wsy,wt,Z);}}
if(showIcons){for(var j=0;j<D.ob.length;j++){var o=D.ob[j];if(nameOn[o.c+"|"+o.n]===false)continue;var sx=(o.x-sl)*Z,sy=(o.z-st)*Z;if(sx<-30||sx>W+30||sy<-30||sy>Hh+30)continue;
var hr;var sc=o.i>=0?shadowed(o.i):null;if(sc){var im=ICONS[o.i];var sz=clamp(Z*3,24,50);var k=sz/im.naturalWidth,dw=sc.width*k,dh=sc.height*k;bctx.globalAlpha=o.d?0.45:1;bctx.drawImage(sc,sx-dw/2,sy-dh/2,dw,dh);bctx.globalAlpha=1;hr=sz/2;}
else{var col=(D.ct.filter(function(c){return c.n==o.c;})[0]||{c:"#ffd24a"}).c;var br=clamp(Z*0.55,3,9);bctx.fillStyle=col;bctx.globalAlpha=o.d?0.4:1;bctx.beginPath();bctx.arc(sx,sy,br,0,6.28);bctx.fill();bctx.globalAlpha=1;hr=br;}
if(o.k>1){bctx.fillStyle="#c0392b";bctx.beginPath();bctx.arc(sx+hr*0.8,sy-hr*0.8,6,0,6.28);bctx.fill();bctx.fillStyle="#fff";bctx.font="9px sans-serif";bctx.textAlign="center";bctx.textBaseline="middle";bctx.fillText(o.k>9?"9+":""+o.k,sx+hr*0.8,sy-hr*0.8);}
baseHits.push({sx:sx,sy:sy,r:hr,n:o.n+(o.k>1?" +"+(o.k-1):""),s:o.c+" - "+o.x+","+o.z});
if(showLab){bctx.fillStyle="#fff";bctx.font="11px sans-serif";bctx.textAlign="center";bctx.textBaseline="bottom";bctx.shadowColor="#000";bctx.shadowBlur=3;bctx.fillText(o.n,sx,sy-hr-2);bctx.shadowBlur=0;}}}
if(showPoi){for(var p=0;p<D.pi.length;p++){var P=D.pi[p];var px=(P.x-sl)*Z,py=(P.z-st)*Z;if(px<-30||px>W+30||py<-30||py>Hh+30)continue;var u=P.s;
bctx.save();bctx.globalAlpha=0.7;bctx.fillStyle="rgba(0,0,0,.68)";bctx.beginPath();bctx.arc(px,py,u*0.55,0,6.28);bctx.fill();bctx.restore();
if(P.m>=0&&MM[P.m].complete&&MM[P.m].naturalWidth)bctx.drawImage(MM[P.m],px-u/2,py-u/2,u,u);baseHits.push({sx:px,sy:py,r:u/2,n:P.n,s:P.x+","+P.z});}}}
function render(){if(!W)return;
var sig=[cx,cz,Z,W,Hh,showIcons,showPoi,showLab,nameVer,dataVer].join(",");
if(sig!==baseSig){buildBase();baseSig=sig;}
ctx.clearRect(0,0,W,Hh);ctx.drawImage(base,0,0);hits=baseHits.slice();
var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);
function drawNpc(N,alpha,tag){var nx=(N.x-sl)*Z,ny=(N.z-st)*Z;if(nx<-20||nx>W+20||ny<-20||ny>Hh+20)return;
var nii=(N.i!==undefined&&N.i>=0)?N.i:(npcIcon[N.n]!==undefined?npcIcon[N.n]:-1);var nsc=nii>=0?shadowed(nii):null;var nhr;ctx.globalAlpha=alpha;
if(nsc){var nim=ICONS[nii];var nsz=clamp(Z*2.6,20,44);var nk=nsz/nim.naturalWidth,ndw=nsc.width*nk,ndh=nsc.height*nk;ctx.drawImage(nsc,nx-ndw/2,ny-ndh/2,ndw,ndh);nhr=nsz/2;}
else{ctx.fillStyle=tag==="live"?"#f1c40f":"#9aa0a6";ctx.strokeStyle="rgba(0,0,0,.6)";ctx.lineWidth=1;ctx.beginPath();ctx.arc(nx,ny,4,0,6.28);ctx.fill();ctx.stroke();nhr=5;}
ctx.globalAlpha=1;hits.push({sx:nx,sy:ny,r:nhr,n:N.n+(N.l?" (lv "+N.l+")":"")+(tag==="stored"?" · spawn":""),s:"NPC - "+N.x+","+N.z});}
if(npcMode>0){
if(npcMode===1){var SN=D.ns||[];for(var si=0;si<SN.length;si++)drawNpc(SN[si],0.85,"stored");}
else{var LV=D.npc||[],SN2=D.ns||[];
// A live NPC only takes over from its spawn ONCE its model icon is ready — until then we keep the
// spawn marker (with its cached icon) and skip the live one, so there's no bare yellow dot on login.
function npcReady(N){var ii=(N.i!==undefined&&N.i>=0)?N.i:(npcIcon[N.n]!==undefined?npcIcon[N.n]:-1);return ii>=0&&!!shadowed(ii);}
for(var si2=0;si2<SN2.length;si2++){var S=SN2[si2],near=false;for(var li=0;li<LV.length;li++){if(!npcReady(LV[li]))continue;var ddx=LV[li].x-S.x,ddz=LV[li].z-S.z;if(ddx*ddx+ddz*ddz<=16){near=true;break;}}if(!near)drawNpc(S,0.5,"stored");}
for(var li2=0;li2<LV.length;li2++){if(npcReady(LV[li2]))drawNpc(LV[li2],1,"live");}}}
if(showPl&&D.pl){for(var pl2=0;pl2<D.pl.length;pl2++){var L=D.pl[pl2];var lx=(L.x-sl)*Z,ly=(L.z-st)*Z;if(lx<-10||lx>W+10||ly<-10||ly>Hh+10)continue;ctx.fillStyle="#2ecc71";ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.beginPath();ctx.arc(lx,ly,4,0,6.28);ctx.fill();ctx.stroke();hits.push({sx:lx,sy:ly,r:5,n:L.n,s:"Player - "+L.x+","+L.z});}}
if(D.dest){var dsx=(D.dest.x-sl)*Z,dsy=(D.dest.z-st)*Z;drawDest(ctx,dsx,dsy);}
if(D.p){var ppx=(D.p.x-sl)*Z,ppy=(D.p.z-st)*Z;ctx.save();ctx.translate(ppx,ppy);if(D.p.a!=null){ctx.rotate(D.p.a);ctx.fillStyle="#fff";ctx.strokeStyle="#1a1a1a";ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(5.5,7);ctx.lineTo(0,3.5);ctx.lineTo(-5.5,7);ctx.closePath();ctx.fill();ctx.stroke();}else{ctx.fillStyle="#19b9ff";ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,6,0,6.28);ctx.fill();ctx.stroke();}ctx.restore();}drawPings();}
var destT0=0,destRAF=null;
function drawDest(t,e,i){var s=(performance.now()-destT0)/1000,n=(Math.sin(s*8)+1)*.5,o=Math.max(0,1-s/.55);t.save();t.translate(e,i);t.lineJoin="round";
if(o>0){t.globalAlpha=.65*o;t.strokeStyle="#fff0b8";t.lineWidth=2;t.beginPath();t.arc(0,0,7+(1-o)*17,0,Math.PI*2);t.stroke();}
t.globalAlpha=.26+n*.2;t.strokeStyle="#ffdf64";t.lineWidth=1.75;t.shadowColor="rgba(255,210,80,0.55)";t.shadowBlur=3+n*2;t.beginPath();t.arc(0,0,7.5+n*1.2,0,Math.PI*2);t.stroke();t.globalAlpha=1;t.shadowBlur=0;t.lineCap="square";
t.strokeStyle="rgba(0,0,0,0.72)";t.lineWidth=3;t.beginPath();t.moveTo(0,-17);t.lineTo(0,0);t.stroke();
t.strokeStyle="#f7ead1";t.lineWidth=1.5;t.beginPath();t.moveTo(0,-17);t.lineTo(0,0);t.stroke();
t.fillStyle="#d8372b";t.strokeStyle="#230b07";t.lineWidth=1.25;t.shadowColor="rgba(0,0,0,0.35)";t.shadowBlur=2;t.beginPath();t.moveTo(1,-17);t.lineTo(10,-14);t.lineTo(1,-10);t.closePath();t.fill();t.stroke();t.restore();}
/* Pulse the destination flag at ~22fps (coalesced) instead of a full 60fps re-render. */
function destAnim(){if(D.dest){requestRender();destRAF=setTimeout(destAnim,45);}else destRAF=null;}
function ensureDestAnim(){if(D.dest&&!destRAF){destT0=performance.now();destAnim();}}
/* Legend ping: clicking a legend icon pulses a yellow glow ring around every matching
   object so you can spot them. 3 pulses (~650ms each) then it stops. */
var pingPts=null,pingT0=0,pingRAF=null,PING_PULSES=3,PING_DUR=650;
function pingObjects(pts){if(!pts||!pts.length)return;pingPts=pts;pingT0=performance.now();if(!pingRAF)pingAnim();}
function pingAnim(){if(pingPts&&(performance.now()-pingT0)<PING_PULSES*PING_DUR){requestRender();pingRAF=setTimeout(pingAnim,33);}else{pingPts=null;pingRAF=null;requestRender();}}
function drawPings(){if(!pingPts)return;var el=performance.now()-pingT0;if(el>=PING_PULSES*PING_DUR){pingPts=null;return;}
var ph=(el%PING_DUR)/PING_DUR,a=1-ph,sl=cx-W/(2*Z),st=cz-Hh/(2*Z);
var r0=Math.max(9,Z*1.5),rad=r0+ph*Math.max(13,Z*1.5);
ctx.save();ctx.lineWidth=Math.max(2,Z*0.16);ctx.strokeStyle="rgba(255,226,72,"+(0.95*a)+")";ctx.shadowColor="rgba(255,216,60,0.95)";ctx.shadowBlur=10*a+5;
for(var i=0;i<pingPts.length;i++){var px=(pingPts[i][0]-sl)*Z,py=(pingPts[i][1]-st)*Z;if(px<-40||px>W+40||py<-40||py>Hh+40)continue;ctx.beginPath();ctx.arc(px,py,rad,0,6.28);ctx.stroke();}
ctx.restore();}
function fit(){var pad=10;Z=clamp(Math.min(W/(D.W+pad),Hh/(D.H+pad)),0.3,48);cx=D.W/2;cz=D.H/2;render();}
function goTo(x,z){Z=Math.max(Z,16);cx=x+0.5;cz=z+0.5;render();}
/* Drag-vs-click (option C): panning only engages on a deliberate drag — moved past a
   generous threshold AND held a moment (or a big fast sweep). A quick tap, even with a few
   px of drift, stays a click → walk there. Click-to-move is handled on mouseup, not the
   browser 'click' event, so drift never eats the click. */
var dragging=false,pressed=false,sx0=0,sy0=0,lx0=0,ly0=0,pressT=0,DRAG_THRESH=18,HOLD_MS=150;
function clickAt(e){var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
var best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}
var sl=cx-W/(2*Z),st=cz-Hh/(2*Z);var wx=sl+mx/Z,wz=st+my/Z;
if(best){setFollow(false);var ox=sl+best.sx/Z,oz=st+best.sy/Z,hw=W/(2*Z),hh=Hh/(2*Z);cx=D.W>2*hw?Math.max(hw,Math.min(D.W-hw,ox)):D.W/2;cz=D.H>2*hh?Math.max(hh,Math.min(D.H-hh,oz)):D.H/2;render();}
else if(D.online){sendInput({t:"move",x:wx,z:wz});}}
view.addEventListener("mousedown",function(e){if(e.button!==0)return;pressed=true;dragging=false;sx0=lx0=e.clientX;sy0=ly0=e.clientY;pressT=Date.now();});
window.addEventListener("mouseup",function(e){var pth=(e.composedPath&&e.composedPath())||[];var onView=view===e.target||view.contains(e.target)||pth.indexOf(view)>=0;if(pressed&&!dragging&&onView)clickAt(e);pressed=false;dragging=false;view.classList.remove("drag");});
view.addEventListener("mousemove",function(e){if(pressed){if(!dragging){var dist=Math.abs(e.clientX-sx0)+Math.abs(e.clientY-sy0);if((dist>DRAG_THRESH&&(Date.now()-pressT)>HOLD_MS)||dist>DRAG_THRESH*3){dragging=true;setFollow(false);view.classList.add("drag");}}if(dragging){cx-=(e.clientX-lx0)/Z;cz-=(e.clientY-ly0)/Z;lx0=e.clientX;ly0=e.clientY;requestRender();tip.style.display="none";}return;}
var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}
if(best){tip.style.display="block";tip.style.left=(mx+14)+"px";tip.style.top=(my+10)+"px";tip.innerHTML="<b>"+best.n+"</b><br>"+best.s;}else tip.style.display="none";});
view.addEventListener("wheel",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var f=e.deltaY<0?1.15:1/1.15;Z=clamp(Z*f,0.3,48);cx=wx+W/(2*Z)-mx/Z;cz=wz+Hh/(2*Z)-my/Z;render();},{passive:false});
view.addEventListener("contextmenu",function(e){e.preventDefault();var r=view.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;var wx=cx-W/(2*Z)+mx/Z,wz=cz-Hh/(2*Z)+my/Z;var textToCopy="("+Math.round(wx)+","+Math.round(wz)+")";var best=null,bd=1e9;for(var i=hits.length-1;i>=0;i--){var h=hits[i],d=(h.sx-mx)*(h.sx-mx)+(h.sy-my)*(h.sy-my);if(d<(h.r+4)*(h.r+4)&&d<bd){bd=d;best=h;}}if(best){textToCopy+="["+best.n.replace(/\\s*\\+\\d+$/,"").trim()+"]";}var m=document.getElementById("eq-map-context-menu");if(m)m.remove();m=document.createElement("div");m.id="eq-map-context-menu";m.style.cssText="position:fixed;left:"+e.clientX+"px;top:"+e.clientY+"px;background:#473e32;border:1px solid #1a1612;border-top-color:#72624d;border-left-color:#72624d;z-index:10000;box-shadow:2px 2px 4px rgba(0,0,0,0.5);user-select:none;min-width:120px;font-family:sans-serif;";var hdr=document.createElement("div");hdr.style.cssText="background:#362e24;padding:4px 8px;border-bottom:1px solid #1a1612;color:#ffd24a;font-weight:bold;text-align:center;font-size:12px;cursor:default";hdr.textContent="Select an Option";m.appendChild(hdr);var itm=document.createElement("div");itm.style.cssText="padding:6px 10px;cursor:pointer;color:#fff;font-size:13px";itm.textContent="Share "+textToCopy;itm.onmouseenter=function(){itm.style.background="#5c5040";};itm.onmouseleave=function(){itm.style.background="transparent";};itm.onclick=function(ev){ev.stopPropagation();m.remove();if(typeof sendInput!=="undefined"){sendInput({t:"chat",text:textToCopy});}else if(window.electron&&window.electron.ipcRenderer){window.electron.ipcRenderer.send("map-window:input",{t:"chat",text:textToCopy});}};if(D.online){var itm2=document.createElement("div");itm2.style.cssText="padding:6px 10px;cursor:pointer;color:#fff;font-size:13px";itm2.textContent="Walk Here";itm2.onmouseenter=function(){itm2.style.background="#5c5040";};itm2.onmouseleave=function(){itm2.style.background="transparent";};itm2.onclick=function(ev){ev.stopPropagation();m.remove();if(typeof sendInput!=="undefined"){sendInput({t:"move",x:wx,z:wz});}else if(window.electron&&window.electron.ipcRenderer){window.electron.ipcRenderer.send("map-window:input",{t:"move",x:wx,z:wz});}};m.appendChild(itm2);}m.appendChild(itm);document.body.appendChild(m);var closeM=function(ev){var pth=(ev.composedPath&&ev.composedPath())||[];if(!m.contains(ev.target)&&pth.indexOf(m)<0){m.remove();window.removeEventListener("mousedown",closeM);}};setTimeout(function(){window.addEventListener("mousedown",closeM);},0);});
function setFollow(on){follow=on&&!!D.online;var b=document.getElementById("follow");b.className="btn"+(D.online?"":" dis")+(follow?"":" off");b.innerText=(follow?"◉":"○")+" Follow";if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;render();}}
document.getElementById("follow").onclick=function(){if(!D.online)return;setFollow(!follow);};
document.getElementById("fdown").onclick=function(){sendInput({t:"floor",f:(D.floor||0)-1});};
document.getElementById("fup").onclick=function(){sendInput({t:"floor",f:(D.floor||0)+1});};
var _mt=document.getElementById("modeToggle");if(_mt)_mt.onclick=function(){sendInput({t:"mode"});};
var _cb=document.getElementById("close");if(_cb)_cb.onclick=function(){sendInput({t:"close"});};
document.getElementById("L_ic").onchange=function(e){showIcons=e.target.checked;render();};
document.getElementById("L_poi").onchange=function(e){showPoi=e.target.checked;render();};
var NPCLBL=["Off","Stored","Live"];function setNpcMode(m){npcMode=((m%3)+3)%3;var el=document.getElementById("npcmodelbl");if(el)el.textContent=NPCLBL[npcMode];requestRender();}
document.getElementById("npcmode").onclick=function(){setNpcMode(npcMode+1);};setNpcMode(2);
document.getElementById("L_pl").onchange=function(e){showPl=e.target.checked;render();};
document.getElementById("L_lab").onchange=function(e){showLab=e.target.checked;render();};
q.oninput=function(){var s=q.value.trim().toLowerCase();if(!s)return;var best=null,bd=1e9;function consider(x,z,n){if(n.toLowerCase().indexOf(s)<0)return;var d=(x-cx)*(x-cx)+(z-cz)*(z-cz);if(d<bd){bd=d;best=[x,z];}}D.ob.forEach(function(o){consider(o.x,o.z,o.n+" "+o.c);});(D.npc||[]).forEach(function(N){consider(N.x,N.z,N.n);});D.pi.forEach(function(P){consider(P.x,P.z,P.n);});if(best)goTo(best[0],best[1]);};
function esc(t){var d=document.createElement("span");d.textContent=t;return d.innerHTML;}
function buildCats(){var box=document.getElementById("cats");var TAX={};D.ob.forEach(function(o){if(!TAX[o.c])TAX[o.c]={};TAX[o.c][o.n]=(TAX[o.c][o.n]||0)+o.k;});
var sig=Object.keys(TAX).sort().map(function(c){return c+":"+Object.keys(TAX[c]).sort().join(",");}).join("|");
if(sig===lastCatSig)return; /* unchanged → keep current DOM (expand + scroll state) */
lastCatSig=sig;box.innerHTML="";
var catIcon={},nameIcon={};D.ob.forEach(function(o){if(o.i>=0){if(catIcon[o.c]===undefined)catIcon[o.c]=o.i;if(nameIcon[o.c+"|"+o.n]===undefined)nameIcon[o.c+"|"+o.n]=o.i;}});
var swatch=function(i,col){return i!==undefined?"<img class=ci src=\\""+D.ic[i]+"\\">":"<span class=sw style=background:"+col+"></span>";};
Object.keys(TAX).sort().forEach(function(c){var col=(D.ct.filter(function(x){return x.n==c;})[0]||{c:"#ffd24a"}).c;var names=Object.keys(TAX[c]).sort();var tot=0;names.forEach(function(n){tot+=TAX[c][n];});
var g=document.createElement("div");g.className="cat";var head=document.createElement("div");head.className="chead";
head.innerHTML="<input type=checkbox class=cc checked>"+swatch(catIcon[c],col)+"<span class=cn>"+esc(c)+" ("+tot+")</span><span class=exp>"+(catOpen[c]?"▾":"▸")+"</span>";
var subs=document.createElement("div");subs.className="subs";subs.style.display=catOpen[c]?"block":"none";
names.forEach(function(n){var l=document.createElement("label");l.className="sub";l.innerHTML="<input type=checkbox class=nc "+(nameOn[c+"|"+n]===false?"":"checked")+">"+swatch(nameIcon[c+"|"+n],col)+esc(n)+" ("+TAX[c][n]+")";
var nb=l.querySelector("input");nb.onchange=function(){nameOn[c+"|"+n]=nb.checked;var any=names.some(function(x){return nameOn[c+"|"+x]!==false;});head.querySelector(".cc").checked=any;nameVer++;render();};
var nsw=l.querySelector(".ci,.sw");if(nsw){nsw.style.cursor="pointer";nsw.title="Ping on map";nsw.onclick=function(ev){ev.stopPropagation();ev.preventDefault();if(!nb.checked){nb.checked=true;nameOn[c+"|"+n]=true;head.querySelector(".cc").checked=true;nameVer++;}var pts=[];D.ob.forEach(function(o){if(o.c===c&&o.n===n)pts.push([o.x,o.z]);});pingObjects(pts);render();};}
subs.appendChild(l);});
var cc=head.querySelector(".cc");cc.onchange=function(){var on=cc.checked;names.forEach(function(n){nameOn[c+"|"+n]=on;});subs.querySelectorAll(".nc").forEach(function(x){x.checked=on;});nameVer++;render();};
var chSw=head.querySelector(".ci,.sw");if(chSw){chSw.style.cursor="pointer";chSw.title="Ping on map";chSw.onclick=function(ev){ev.stopPropagation();ev.preventDefault();if(!cc.checked){cc.checked=true;names.forEach(function(n){nameOn[c+"|"+n]=true;});subs.querySelectorAll(".nc").forEach(function(x){x.checked=true;});nameVer++;}var pts=[];D.ob.forEach(function(o){if(o.c===c&&nameOn[c+"|"+o.n]!==false)pts.push([o.x,o.z]);});pingObjects(pts);render();};}
head.querySelector(".exp").onclick=function(){var open=subs.style.display==="none";subs.style.display=open?"block":"none";this.textContent=open?"▾":"▸";catOpen[c]=open;};
g.appendChild(head);g.appendChild(subs);box.appendChild(g);});}
function setLabel(){document.getElementById("fl").innerText="Floor "+(D.floor||0);}
function applyUpdate(u){if(!u)return;
if(u.full){var nd=u.full;D=nd;loadImgs();taxState();buildNpcIcon();buildCats();setLabel();dataVer++;}
if(u.terrain){D.t=u.terrain;terrain=new Image();terrain.onload=function(){baseSig="";requestRender();};terrain.src=u.terrain;}
if(u.p!==undefined)D.p=u.p;if(u.npc!==undefined)D.npc=u.npc;if(u.pl!==undefined)D.pl=u.pl;if(u.online!==undefined)D.online=u.online;
if(u.dest!==undefined){var had=!!D.dest;D.dest=u.dest;if(D.dest&&!had)destT0=performance.now();}
setFollow(follow);if(follow&&D.p){cx=D.p.x+0.5;cz=D.p.z+0.5;}if(u.goTo){setFollow(false);goTo(u.goTo.x,u.goTo.z);}ensureDestAnim();requestRender();}
if(IPC&&IPC.on)IPC.on("map-window:update",function(e,u){applyUpdate(u);});
window.addEventListener("message",function(e){var d=e&&e.data;if(d&&d.__wmUpdate)applyUpdate(d.__wmUpdate);});
buildCats();setLabel();setFollow(true);ensureDestAnim();
window.addEventListener("resize",resize);[terrain].concat(ICONS,MM).forEach(function(im){im.addEventListener("load",requestRender);});setTimeout(render,300);setTimeout(render,1200);
if(MOBILE){(function(){
var ms=document.createElement("style");ms.textContent=
"#hdr h1{display:none}#hdr{flex-wrap:wrap;gap:5px;padding:5px 8px}"
+"#q{flex:1 1 120px;font-size:15px;padding:7px 8px}#modeToggle{display:none!important}"
+".btn{padding:7px 10px;font-size:13px}#hint{display:none}#body{position:relative}"
+"#side{position:absolute;left:0;top:0;bottom:0;z-index:7;max-width:80%;overflow:auto;transform:translateX(-100%);transition:transform .2s;box-shadow:2px 0 12px rgba(0,0,0,.5)}"
+"body.side-open #side{transform:translateX(0)}"
+"#legendToggle{position:absolute;left:8px;top:8px;z-index:8;width:40px;height:40px;border:none;border-radius:8px;background:rgba(20,20,24,.85);color:#fff;font-size:20px;cursor:pointer}"
+"#zoomBtns{position:absolute;right:10px;bottom:14px;z-index:8;display:flex;flex-direction:column;gap:10px}"
+"#zoomBtns button{width:46px;height:46px;border:none;border-radius:10px;background:rgba(20,20,24,.85);color:#fff;font-size:24px;cursor:pointer}";
document.head.appendChild(ms);
var lt=document.createElement("button");lt.id="legendToggle";lt.textContent="\\u2630";lt.onclick=function(){document.body.classList.toggle("side-open");};view.appendChild(lt);
var zb=document.createElement("div");zb.id="zoomBtns";var zi=document.createElement("button");zi.textContent="+";var zo=document.createElement("button");zo.textContent="\\u2212";zb.appendChild(zi);zb.appendChild(zo);view.appendChild(zb);
function zoomBy(f){Z=clamp(Z*f,0.3,48);render();}zi.onclick=function(){zoomBy(1.4);};zo.onclick=function(){zoomBy(1/1.4);};
var tP=false,tD=false,x0=0,y0=0,lx=0,ly=0,lp=null,pin=false,pd=0,pz=0;
view.addEventListener("touchstart",function(e){
 if(e.touches.length===2){pin=true;tP=false;if(lp){clearTimeout(lp);lp=null;}var a=e.touches[0],b=e.touches[1];pd=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);pz=Z;return;}
 var t=e.touches[0];tP=true;tD=false;x0=lx=t.clientX;y0=ly=t.clientY;
 if(lp)clearTimeout(lp);lp=setTimeout(function(){if(tP&&!tD){tP=false;view.dispatchEvent(new MouseEvent("contextmenu",{clientX:x0,clientY:y0,bubbles:true,cancelable:true}));}},500);
},{passive:true});
view.addEventListener("touchmove",function(e){
 if(pin&&e.touches.length>=2){var a=e.touches[0],b=e.touches[1];var d=Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);if(pd>0){Z=clamp(pz*(d/pd),0.3,48);render();}e.preventDefault();return;}
 if(!tP)return;var t=e.touches[0];var dd=Math.abs(t.clientX-x0)+Math.abs(t.clientY-y0);
 if(!tD&&dd>12){tD=true;if(lp){clearTimeout(lp);lp=null;}setFollow(false);}
 if(tD){cx-=(t.clientX-lx)/Z;cz-=(t.clientY-ly)/Z;lx=t.clientX;ly=t.clientY;requestRender();tip.style.display="none";e.preventDefault();}
},{passive:false});
view.addEventListener("touchend",function(e){if(lp){clearTimeout(lp);lp=null;}
 if(pin){if(e.touches.length===0)pin=false;return;}
 if(tP&&!tD){clickAt({clientX:x0,clientY:y0});}tP=false;tD=false;
},{passive:true});
})();}
resize();fit();})();</script></body></html>`;
    }

    /** Save text to a file via a download link (lands in the user's Downloads). */
    private downloadFile(name: string, content: string) {
        try {
            const blob = new Blob([content], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (e: any) { this.warn('export download failed: ' + (e?.message || e)); }
    }

    // ── Model-thumbnail icons (Phase 1) ───────────────────────────────────────────
    // Render the game's own 3D models to small sprites by reusing its already-loaded
    // Babylon instance (dynamically imported from the page's babylon-core module).
    // Object model files come from the bundle's `Cs` table (defId -> files), NPCs from
    // the `Lu` table (defId -> file); both are parsed out of window.__eqSourceCode.
    // Icons render lazily on demand, are cached, and replace the colour/shape markers.
    private iconsEnabled = true;
    private iconCache = new Map<string, HTMLImageElement>();
    /** Rendered model icons live in the CORE-managed shared 'model-icons' namespace
     *  (data/model-icons.json) so any plugin can read them — the map is just the
     *  producer (it can render the 3D models). See ModelIconCache. */
    private iconCacheStore = new ModelIconCache();
    /** Build-committed prebake of explored terrain (per map+floor), via the same core
     *  asset cache (data/world-map-terrain.json). Packaged users load a full map up
     *  front; in dev it re-bakes as you explore so the shipped cache can be updated. */
    private terrainCacheStore = new PluginAssetCache('world-map-terrain');
    /** In-memory copy of the shipped terrain prebake (key `${id}:${floor}` -> bundle JSON),
     *  loaded once so the offline snapshot can fall back to it synchronously when the user's
     *  localStorage bundle is missing or has blank/weak terrain (e.g. a fresh install that
     *  never logged in, or a force-logout that wiped the live terrain). */
    private shippedBundles: Record<string, string> | null = null;
    private iconFailed = new Set<string>();
    private iconPending = new Set<string>();
    private iconQueue: { key: string; file: string }[] = [];
    private iconRendering = false;
    // Back-off when model fetches start returning 401/403 (the EvilQuest session token lapsed):
    // stop hammering the server so we don't spam failures while the token refresh kicks in.
    private iconAuthFailStreak = 0;
    private iconQueuePausedUntil = 0;
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
    // The offscreen Babylon engine accumulates GPU memory across GLB loads (textures/effects
    // that scene.dispose() doesn't fully reclaim). Recycle it every N renders to bound RAM
    // while STILL rendering every object (so the dev cache builds a complete map).
    private rendersSinceEngineReset = 0;
    private static readonly RENDERS_PER_ENGINE = 20;

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
            // Mobile: use the prebaked (APK-bundled) cache ONLY. Never spin up the offscreen Babylon
            // engine to render icons live — a second WebGL context blanks the game's 3D view. Uncached
            // icons fall back to coloured dots.
            if (this.isMobile) { this.bjsState = 'failed'; this.info('icons: mobile — prebaked cache only (no live render)'); return; }
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
            const icons = await this.iconCacheStore.load();
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
        for (const m of src.matchAll(/(?:\bdefId\s*:\s*|['"]?id['"]?\s*:\s*)(\d+)[^}]*?(?:file|files|model|modelPath|assetId)['"]?\s*:\s*(?:\[\s*)?['"]([^'"]+\.(?:glb|gltf))['"]/gi)) {
            const id = Number(m[1]);
            if (!this.objModelFiles.has(id)) this.objModelFiles.set(id, m[2]);
        }
        // NPC model table (`pp`): robust negative lookahead to find the FIRST .glb within an NPC block.
        // It prevents crossing into the next NPC definition (`\d+:{`) while allowing nested braces.
        for (const m of src.matchAll(/(\d+)\s*:\s*\{(?:(?!\d+\s*:\s*\{)[\s\S])*?['"]([^'"]+\.(?:glb|gltf))['"]/gi)) {
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
        const isGlb = (s: any) => typeof s === 'string' && WorldMapPlugin.MODEL_EXT.test(s);
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
        if (file) this.modelFileCache.set(key, file);
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
    /** Model file extensions Babylon's loader can import for our icons. The game's
     *  bought-asset packs (e.g. Medieval_Dracula: Lamp, Coffin, Notice Board) ship as
     *  .gltf, not .glb — accept both or those objects fall back to plain dots. */
    private static readonly MODEL_EXT = /\.(glb|gltf)(\?|#|$)/i;

    private objAssetFile(assetId: string): string | null {
        if (!assetId) return null;
        const path = this.getAssetRegistry()?.get(assetId)?.path;
        if (typeof path !== 'string' || !WorldMapPlugin.MODEL_EXT.test(path)) return null;
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
        // Still nothing — the placed mesh isn't loaded near us (e.g. a distant fishing spot), so it
        // has no runtime assetId. Fall back to the def's declared model identity: fishing spots carry
        // a stable modelAssetId (e.g. FishingSpotBubblesCrayfish) that resolves via the asset registry
        // / icon bake, so the icon shows even before the object's own mesh streams in.
        if (!assetId) {
            const mAsset = this.gm?.objectDefsCache?.get(o.defId)?.modelAssetId;
            if (typeof mAsset === 'string' && mAsset) assetId = mAsset;
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
        // Cache-first: a prebaked npc:<defId> icon wins directly. On mobile the live model tables
        // aren't built (no live rendering), so without this every NPC fell back to the humanoid icon.
        const cached = this.iconFor('npc:' + defId, () => null);
        if (cached) return cached;
        const file = this.modelFileFor('npc', defId);
        if (file) return this.iconFor('npc:' + defId, () => file);

        // modelFileFor returned null. Before falling back to the humanoid icon, check
        // whether the NPC model tables (regex-parsed at init) say this defId HAS a model.
        // If so, modelFileFor just hasn't resolved it yet (def still streaming in from
        // the network) — return null (clean dot) instead of the wrong humanoid icon.
        if (this.npcModelFiles?.has(defId)) return null;

        // Also check the live def: if findGlb can extract a .glb from the live def object
        // right now (even though modelFileFor missed it — e.g. due to cache miss), use it.
        const def = this.gm?.entities?.npcDefsCache?.get(defId);
        if (def) {
            const glb = this.findGlb(def);
            if (glb) return this.iconFor('npc:' + defId, () => glb);
            // Def loaded AND no .glb anywhere → genuinely a humanoid NPC.
            return this.iconFor('npc:__humanoid__', () => WorldMapPlugin.HUMANOID_MODEL);
        }
        return null;
    }

    /** Hard cap on queued renders — prevents OOM when many objects become visible at once. */
    private static readonly MAX_ICON_QUEUE = 40;

    /** True while renderAllIcons() is bulk-baking, so the queue's MAX_ICON_QUEUE trim
     *  is suspended (we WANT to render everything, not just what's visible). */
    private bulkRendering = false;

    /**
     * DEV TOOL: pre-render an icon for every model the def tables / asset registry
     * currently know about, so the prebaked cache can be completed without walking the
     * whole map. Trigger with Ctrl+Shift+B (dev builds only); also callable directly.
     *
     * Deliberately resilient and best-effort, because this WON'T hold forever:
     *   - EvilQuest plans to lock assets behind auth — any model that 404s / 401s just
     *     gets marked failed and skipped (per-model try/catch in processIconQueue), the
     *     pass keeps going, and the normal explore-as-you-go rendering still works.
     *   - It only bakes what the def/registry tables expose right now; if the game moves
     *     to streaming defs (so exploration is required again), this simply bakes less,
     *     and the on-demand path remains the source of truth.
     * Saves are dev-only (the main-process cache is read-only in packaged builds), so
     * running this in a shipped build renders in memory but writes nothing.
     */
    public async renderAllIcons(): Promise<void> {
        if (this.bulkRendering) { this.info('render-all: already running'); return; }
        if (this.bjsState !== 'ready') {
            void this.initIconSystem();
            this.warn('render-all: icon system not ready (need to be in-game) — try again in a moment');
            return;
        }
        this.bulkRendering = true;
        try {
            // Dedupe (key -> model file); skip anything already cached/failed/pending.
            const jobs = new Map<string, string>();
            const add = (key: string, file: string | null | undefined) => {
                if (!key || !file) return;
                if (this.iconCache.has(key) || this.iconFailed.has(key) || this.iconPending.has(key) || jobs.has(key)) return;
                jobs.set(key, file);
            };

            // 1) Objects keyed by assetId (the primary icon identity) from the asset registry.
            const reg = this.getAssetRegistry();
            if (reg && typeof (reg as any).forEach === 'function') {
                (reg as any).forEach((entry: any, assetId: any) => {
                    const path = entry?.path;
                    if (typeof assetId === 'string' && typeof path === 'string' && WorldMapPlugin.MODEL_EXT.test(path)) {
                        add('obj:' + assetId, this.objAssetFile(assetId) ?? path);
                    }
                });
            }
            // 2) Objects keyed by defId (the fallback key, e.g. trees defined that way).
            const objDefs: any = this.gm?.objectDefsCache;
            if (objDefs && typeof objDefs.forEach === 'function') {
                objDefs.forEach((def: any, defId: any) => add('objdef:' + defId, this.findGlb(def) ?? this.objModelFiles?.get(Number(defId)) ?? null));
            }
            this.objModelFiles?.forEach((file, defId) => add('objdef:' + defId, file));
            // 3) NPCs keyed by defId (+ the shared humanoid base for model-less defs).
            const npcDefs: any = this.gm?.entities?.npcDefsCache;
            if (npcDefs && typeof npcDefs.forEach === 'function') {
                npcDefs.forEach((_def: any, defId: any) => {
                    const file = this.modelFileFor('npc', Number(defId));
                    if (file) add('npc:' + defId, file);
                    else add('npc:__humanoid__', WorldMapPlugin.HUMANOID_MODEL);
                });
            }
            this.npcModelFiles?.forEach((file, defId) => add('npc:' + defId, file));

            const total = jobs.size;
            this.info(`render-all: queuing ${total} models (already have ${this.iconCache.size} cached, ${this.iconFailed.size} failed)`);
            this.sendDiag(`RENDER-ALL queuing ${total} (cached=${this.iconCache.size} failed=${this.iconFailed.size})`);
            if (!total) return;
            for (const [key, file] of jobs) { this.iconPending.add(key); this.iconQueue.push({ key, file }); }
            await this.processIconQueue();
            this.info(`render-all: done — cache now ${this.iconCache.size}, failed ${this.iconFailed.size}`);
            this.sendDiag(`RENDER-ALL done cache=${this.iconCache.size} failed=${this.iconFailed.size}`);
        } finally {
            this.bulkRendering = false;
        }
    }

    private async processIconQueue(): Promise<void> {
        if (this.iconRendering || !this.bjs) return;
        if (Date.now() < this.iconQueuePausedUntil) return; // backing off after auth failures
        this.iconRendering = true;
        try {
            while (this.iconQueue.length) {
                if (Date.now() < this.iconQueuePausedUntil) break;
                // Trim queue if it grew too large (new objects all visible at once on first load).
                // Drop from the tail so the nearest/most-needed items (pushed first) render first.
                if (!this.bulkRendering && this.iconQueue.length > WorldMapPlugin.MAX_ICON_QUEUE) {
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
                        // Report to the generic asset cache so the dev cache accumulates
                        // this icon for the build (no-op in packaged builds).
                        this.iconCacheStore.save(key, dataUrl);
                        this.iconAuthFailStreak = 0; // a success means auth is fine
                    } else this.iconFailed.add(key);
                } catch (e: any) {
                    this.iconFailed.add(key);
                    this.lastIconDiag = `ERR ${key} ${file}: ${e?.message || e}`;
                    this.sendDiag(`QUEUE-ERR ${key} ${file}: ${e?.message || e} :: ${(e?.stack || '').slice(0, 300)}`);
                    // Auth lapse (token expired) → 401/403. Back off so we stop hammering the
                    // server with failing model fetches until the token refresh restores access.
                    if (/\b(401|403|unauthorized|forbidden)\b/i.test(`${e?.message || e}`)) {
                        if (++this.iconAuthFailStreak >= 4) {
                            this.iconQueue.length = 0; this.iconPending.clear();
                            this.iconQueuePausedUntil = Date.now() + 90 * 1000; // resume after refresh
                            this.sendDiag('icon queue paused 90s — model fetches returning auth errors (token likely expired)');
                            this.iconPending.delete(key);
                            break;
                        }
                    } else this.iconAuthFailStreak = 0;
                } finally {
                    this.iconPending.delete(key);
                }
                // Recycle the offscreen engine periodically to release accumulated GPU
                // memory (this is what was OOM-killing us during a full render).
                if (++this.rendersSinceEngineReset >= WorldMapPlugin.RENDERS_PER_ENGINE) {
                    this.rendersSinceEngineReset = 0;
                    try { this.offEngine?.dispose(); } catch { /* ignore */ }
                    this.offEngine = null;
                    this.offCanvas = null;
                }
                // Throttle so the queue doesn't burst-allocate and the GC keeps pace.
                await new Promise((r) => setTimeout(r, 25));
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
            // Aggressively free GPU resources — textures especially are the big leak across
            // many GLB loads; scene.dispose() alone leaves engine caches behind.
            try {
                if (scene) {
                    for (const t of (scene.textures ?? []).slice()) { try { t.dispose(); } catch { /**/ } }
                    for (const m of (scene.materials ?? []).slice()) { try { m.dispose(true, true); } catch { /**/ } }
                    for (const g of (scene.geometries ?? []).slice()) { try { g.dispose(); } catch { /**/ } }
                    for (const mesh of (scene.meshes ?? []).slice()) { try { mesh.dispose(false, true); } catch { /**/ } }
                    scene.dispose();
                }
            } catch { /* ignore */ }
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















    private setStatus(text: string) {
        if (this.statusEl) this.statusEl.innerText = text;
    }
}
