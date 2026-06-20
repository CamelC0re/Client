import { Plugin } from '@evillite/core/src/interfaces/highlite/plugin/plugin.class';
import { SettingsTypes } from '@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface';
import { ModelIconCache } from '@evillite/core/src/utilities/modelIconCache';

/**
 * Collection Log / Drop Log (MVP) — tracks every item you EARN, in a bank-style UI, organised by
 * SOURCE (the mob/stall/chest/quest that gave it). READ-ONLY: it only observes game state.
 *
 * What counts as "collected":
 *   • a drop from a mob YOU killed,  • a stall/chest/quest reward.
 * What does NOT: random items picked up off the ground (not from your kill).
 *
 * How mob drops are attributed (ground items have no owner field): we track which NPC you're
 * fighting (gm.combatTargetId); when an NPC you were engaged with dies near you, the ground items
 * that spawn at its tile within a short window are *your* loot → logged to that mob's source.
 *
 * Chest/stall rewards add straight to the inventory (no ground item): we capture the worldObject
 * you're skilling (lockpick/steal) and attribute inventory gains to it by category. Quest rewards
 * (dialog-based, no skill object) are the remaining source — not yet wired.
 *
 * Item data: EntityManager.itemDefsCache (id → {name, icon}); icons at https://evilquest.net/items/<icon>.
 * Each source also shows its 3D MODEL icon (chicken, chest…) from the shared, core-managed
 * ModelIconCache ('model-icons') — the same renders the World Map produces. Sources are grouped in
 * the UI into collapsible NPCs / Stalls & Chests / Quest Rewards categories.
 */

const ICON_BASE = 'https://evilquest.net/items/';
const DROP_MATCH_TILES = 2;     // ground item must spawn within this many tiles of the death
const DROP_WINDOW_MS = 6000;    // …and within this long after the death
const ENGAGED_TTL_MS = 15000;   // an NPC counts as "yours" if you targeted it within this window
const REWARD_WINDOW_MS = 5000;  // an inventory gain counts as a chest/stall reward if you skilled it this recently
// Object categories whose skilling action yields a "reward" worth logging (vs. gathering/combat).
// Chests (Lockpick/Unlock) and stalls (Steal-from) deposit straight into the inventory.
const REWARD_CATEGORIES = new Set(['chest', 'stall', 'tree', 'rock', 'fishingspot']);

interface Engaged { name: string; x: number; z: number; defId: number; t: number; }
interface PendingDrop { name: string; x: number; z: number; defId: number; t: number; }
interface SkillObj { id: number; name: string; category: string; defId: number; assetId: string; t: number; }

// What kind of thing a source is — drives both the model icon and the category group.
type SourceType = 'npc' | 'chest' | 'stall' | 'quest' | 'tree' | 'rock' | 'fishingspot' | 'other';
interface SourceMeta { type: SourceType; defId?: number; assetId?: string; }

// The collapsible category groups, in display order. Chests + stalls share one group.
const GROUPS: { key: string; label: string; emoji: string; types: SourceType[] }[] = [
    { key: 'npc',    label: 'NPCs',            emoji: '⚔️', types: ['npc', 'other'] },
    { key: 'object', label: 'Rougery',         emoji: '📦', types: ['chest', 'stall'] },
    { key: 'quest',  label: 'Quest Rewards',   emoji: '📜', types: ['quest'] },
    { key: 'tree',   label: 'Woodcutting',     emoji: '🪓', types: ['tree'] },
    { key: 'rock',   label: 'Mining',          emoji: '⛏️', types: ['rock'] },
    { key: 'fishing',label: 'Fishing',         emoji: '🎣', types: ['fishingspot'] },
];
function groupKeyForType(t: SourceType): string {
    return GROUPS.find((g) => g.types.includes(t))?.key ?? 'npc';
}

export default class CollectionLogPlugin extends Plugin {
    pluginName = 'Collection Log';
    author = 'atapifire';

    private static readonly ICON = '📒';
    private menuIcon: HTMLElement | null = null;
    private ui: HTMLDivElement | null = null;
    private engineId: any = null;

    private engaged = new Map<number, Engaged>();   // npc id -> last-seen while I targeted it
    private liveNpcIds = new Set<number>();
    private pending: PendingDrop[] = [];
    private seenGround = new Set<number>();          // ground-item instance ids already processed
    private selectedSource = '';
    private searchQuery = '';

    // chest/stall reward detection (rewards land straight in the inventory, no ground item)
    private invSnapshot = new Map<number, number>(); // itemId -> total qty currently in inventory
    private invReady = false;                         // first snapshot taken (don't log the starting inventory)
    private lastSkillObj: SkillObj | null = null;     // most-recent worldObject we were skilling on

    // Shared, core-managed model icons (rendered by the World Map plugin, read-only here).
    private modelIcons: Record<string, string> = {};
    private readonly iconStore = new ModelIconCache();

    constructor() {
        super();
        this.settings.deathRangeTiles = { text: 'Max kill distance (tiles)', type: SettingsTypes.range, value: 6, min: 2, max: 14, callback: () => {} } as any;
    }

    init(): void { this.settings.enable.value = true; this.ensureData(); }
    start(): void { this.ensureData(); this.loadModelIcons(); this.registerSidebarIcon(); this.installKeyHandler(); this.startEngine(); this.info('Collection Log started.'); }

    /** Pull the shared model-icon cache (NPC/object renders) once at startup. */
    private loadModelIcons(): void {
        this.iconStore.load().then((m) => { this.modelIcons = m || {}; if (this.ui) this.renderUI(); }).catch(() => {});
    }
    stop(): void { this.stopEngine(); if (this.ui) { this.ui.remove(); this.ui = null; } if (this.menuIcon) { this.menuIcon.remove(); this.menuIcon = null; } }

    /** Press L to toggle the log (ignored while typing in chat / an input). */
    private keyHandlerInstalled = false;
    private installKeyHandler(): void {
        if (this.keyHandlerInstalled) return;
        this.keyHandlerInstalled = true;
        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (!e.key || e.key.toLowerCase() !== 'l' || e.ctrlKey || e.altKey || e.metaKey) return;
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable)) return;
            this.toggleUI();
        });
    }

    private get isMobile(): boolean { return !!(window as any).EvilLiteMobile || (window as any).electron?.process?.platform === 'android' || (window as any).electron?.process?.platform === 'ios'; }
    private get gm(): any { return this.gameHooks?.GameManager?.Instance ?? (window as any).gm ?? null; }
    private get em(): any { return this.gameHooks?.EntityManager?.Instance ?? null; }

    private ensureData(): void {
        if (!this.data.log || typeof this.data.log !== 'object') this.data.log = {};
        if (!this.data.meta || typeof this.data.meta !== 'object') this.data.meta = {};       // source -> SourceMeta
        if (!this.data.collapsed || typeof this.data.collapsed !== 'object') this.data.collapsed = {}; // groupKey -> bool
        if (!this.data.itemIcons || typeof this.data.itemIcons !== 'object') this.data.itemIcons = {}; // itemId -> data-URL, harvested for items with no 2D icon
    }

    // ── detection engine ──────────────────────────────────────────────────────
    private startEngine(): void { this.stopEngine(); this.engineId = setInterval(() => this.tick(), 120); }
    private stopEngine(): void { if (this.engineId) { clearInterval(this.engineId); this.engineId = null; } }

    private tick(): void {
        const gm = this.gm, em = this.em;
        if (!gm || !em) return;
        const now = Date.now();
        const p = this.playerPos();

        // 1) track NPCs + which one I'm fighting
        const live = new Set<number>();
        const npcDefs: Map<any, any> | undefined = em.npcDefs;
        const sprites: Map<any, any> | undefined = em.npcSprites;
        if (npcDefs) for (const [id] of npcDefs) live.add(id as number);
        const target = gm.combatTargetId | 0;
        if (target > 0 && live.has(target)) {
            const pos = this.npcPos(target, sprites);
            const name = this.npcName(target, em);
            this.engaged.set(target, { name, x: pos?.x ?? p?.x ?? 0, z: pos?.z ?? p?.z ?? 0, defId: npcDefs?.get(target) ?? -1, t: now });
        }
        // refresh last-seen position/time of engaged NPCs while they're alive + close
        for (const [id, e] of this.engaged) {
            if (live.has(id)) { const pos = this.npcPos(id, sprites); if (pos) { e.x = pos.x; e.z = pos.z; } e.t = Math.max(e.t, this.engaged.get(id)!.t); }
        }

        // 2) deaths: an engaged NPC that just left the live set, while it was near me → a kill
        const maxKill = (this.settings.deathRangeTiles?.value as number) || 6;
        for (const id of this.liveNpcIds) {
            if (!live.has(id)) {
                const e = this.engaged.get(id);
                if (e && now - e.t < ENGAGED_TTL_MS && p && dist(e.x, e.z, p.x, p.z) <= maxKill) {
                    this.pending.push({ name: e.name, x: e.x, z: e.z, defId: e.defId, t: now });
                }
                this.engaged.delete(id);
            }
        }
        this.liveNpcIds = live;
        this.pending = this.pending.filter((d) => now - d.t < DROP_WINDOW_MS);

        // 3) new ground items → match to a pending kill → log
        const ground: Map<any, any> | undefined = em.groundItems;
        if (ground) {
            const seenNow = new Set<number>();
            for (const [, gi] of ground) {
                const gid = gi.id | 0; seenNow.add(gid);
                if (this.seenGround.has(gid)) continue;
                this.seenGround.add(gid);
                const match = this.pending.find((d) => dist(d.x, d.z, gi.x, gi.z) <= DROP_MATCH_TILES && now - d.t < DROP_WINDOW_MS);
                if (match) this.logCollected(gi.itemId | 0, gi.quantity | 0 || 1, match.name, { type: 'npc', defId: match.defId });
            }
            // forget ground ids that are gone so re-spawned ids don't leak memory
            for (const id of this.seenGround) if (!seenNow.has(id)) this.seenGround.delete(id);
        }

        // 4) chest/stall rewards: capture the worldObject we're skilling, then attribute
        //    inventory gains to it. Lockpicking a chest / stealing from a stall is a timed
        //    skilling action, so skillingObjectId is set for a window we poll here; it deposits
        //    straight into the inventory (no ground item), so we diff the inventory.
        const soid = gm.skillingObjectId | 0;
        if (soid >= 0) {
            const info = this.worldObjectInfo(soid);
            if (info) this.lastSkillObj = { id: soid, name: info.name, category: info.category, defId: info.defId, assetId: info.assetId, t: now };
        }
        const inv = this.readInventory();
        if (!this.invReady) { this.invSnapshot = inv; this.invReady = true; }
        else {
            const so = this.lastSkillObj;
            const isReward = so && now - so.t < REWARD_WINDOW_MS && REWARD_CATEGORIES.has(so.category);
            if (isReward && so) {
                for (const [itemId, qty] of inv) {
                    const gained = qty - (this.invSnapshot.get(itemId) || 0);
                    if (gained > 0) this.logCollected(itemId, gained, so.name, { type: so.category as SourceType, defId: so.defId, assetId: so.assetId });
                }
            }
            this.invSnapshot = inv;
        }
    }

    /** Sum the player's inventory by item id, read from the live inventory DOM. */
    private readInventory(): Map<number, number> {
        const m = new Map<number, number>();
        document.querySelectorAll<HTMLElement>('.item-icon[data-item-id]').forEach((el) => {
            const id = parseInt(el.dataset.itemId || '', 10);
            if (!id) return;
            const q = parseInt(el.dataset.itemQuantity || '1', 10) || 1;
            m.set(id, (m.get(id) || 0) + q);
            this.harvestItemIcon(id, el);
        });
        return m;
    }

    /** Items with no 2D `.icon` are drawn by the game from their 3D model into a data-URL in the
     *  inventory DOM. Cache it the first time we see the item so the log can show the same icon
     *  later, even once the item has left the bag. (Items that ship a 2D icon don't need this.) */
    private harvestItemIcon(id: number, slot: HTMLElement): void {
        if (!id || this.itemDef(id)?.icon || this.data.itemIcons?.[id]) return;
        const src = slot.querySelector('img')?.getAttribute('src') || '';
        if (src.startsWith('data:image')) { (this.data.itemIcons ||= {})[id] = src; }
    }

    /** Resolve a worldObject instance id → def name + category + defId + model assetId.
     *  assetId (e.g. "tier 1 chest") is the shared icon key; it lives on the loaded model. */
    private worldObjectInfo(id: number): { name: string; category: string; defId: number; assetId: string } | null {
        const gm = this.gm; if (!gm) return null;
        const wo = gm.worldObjectDefs?.get(id); if (!wo) return null;
        const def = gm.objectDefsCache?.get(wo.defId); if (!def) return null;
        const model = gm.worldObjectModels?.get(id);
        const assetId = (wo.metadata?.assetId ?? model?.metadata?.assetId ?? wo.assetId ?? '') + '';
        return { name: (def.name ?? `Object #${wo.defId}`) + '', category: (def.category ?? '') + '', defId: wo.defId | 0, assetId };
    }

    /** Generic entry point for every source (mob kill / chest / stall / quest). */
    private logCollected(itemId: number, qty: number, source: string, meta?: SourceMeta): void {
        if (!itemId || qty <= 0) return;
        this.ensureData();
        const src = source || 'Unknown';
        if (!this.data.log[src]) this.data.log[src] = {};
        this.data.log[src][itemId] = (this.data.log[src][itemId] || 0) + qty;
        if (meta) {
            const cur: SourceMeta = this.data.meta[src] || ({} as SourceMeta);
            // Keep the richest info we've ever seen for this source (e.g. assetId only
            // streams in while the object is loaded).
            this.data.meta[src] = { type: meta.type || cur.type || 'other', defId: meta.defId ?? cur.defId, assetId: meta.assetId || cur.assetId };
        }
        this.info(`+${qty} ${this.itemName(itemId)} from ${src}`);
        if (this.ui) this.renderUI();
    }

    // ── game-state helpers ────────────────────────────────────────────────────
    private playerPos(): { x: number; z: number } | null { const gm = this.gm; return gm ? { x: gm.playerX, z: gm.playerZ } : null; }
    private npcPos(id: number, sprites?: Map<any, any>): { x: number; z: number } | null {
        const s = sprites?.get(id); const pos = s?.position; return pos ? { x: pos.x, z: pos.z } : null;
    }
    private npcName(id: number, em: any): string {
        const defId = em.npcDefs?.get(id); const def = em.npcDefsCache?.get(defId); return (def?.name ?? `NPC #${defId}`) + '';
    }
    private itemDef(itemId: number): any { return this.em?.itemDefsCache?.get(itemId) ?? null; }
    private itemName(itemId: number): string { return (this.itemDef(itemId)?.name ?? `Item #${itemId}`) + ''; }
    /** The item's icon, matching what the inventory shows: its 2D icon if it ships one, otherwise
     *  the data-URL the game rendered from the item's 3D model (harvested from the live inventory —
     *  there is no static URL for those; `items/3d/<id>.png` 404s). '' if we've never seen it. */
    private itemIcon(itemId: number): string {
        const ic = this.itemDef(itemId)?.icon;
        if (ic) return ICON_BASE + encodeURIComponent(ic);
        return this.data.itemIcons?.[itemId] || '';
    }

    // ── source identity / icons ───────────────────────────────────────────────
    /** Stored meta for a source, backfilling type/defId by name for pre-existing log entries. */
    private sourceMeta(src: string): SourceMeta {
        const stored: SourceMeta | undefined = this.data.meta?.[src];
        if (stored && stored.type) return stored;
        const inferred = this.inferMeta(src);
        if (inferred && this.data.meta) this.data.meta[src] = inferred;
        return inferred ?? { type: 'other' };
    }

    /** Best-effort: resolve an old source name to its type/defId via the live def caches. */
    private inferMeta(name: string): SourceMeta | null {
        const em = this.em, gm = this.gm;
        const ndc: Map<any, any> | undefined = em?.npcDefsCache;
        if (ndc) for (const [defId, def] of ndc) if ((def?.name ?? '') + '' === name) return { type: 'npc', defId: defId | 0 };
        const odc: Map<any, any> | undefined = gm?.objectDefsCache;
        if (odc) for (const [defId, def] of odc) if ((def?.name ?? '') + '' === name) {
            const cat = (def?.category ?? '') + '';
            if (cat === 'chest' || cat === 'stall' || cat === 'tree' || cat === 'rock' || cat === 'fishingspot') return { type: cat as SourceType, defId: defId | 0 };
        }
        return null;
    }

    /** The shared model-icon dataURL for a source, or null if not cached yet. */
    private sourceIcon(src: string): string | null {
        const m = this.sourceMeta(src);
        if (m.type === 'npc' && m.defId != null) return ModelIconCache.resolveNpc(this.modelIcons, m.defId);
        // A fishing spot's own model is just water/bubbles; show its tool (net/rod) icon instead —
        // that's the icon the player recognises from their inventory.
        if (m.type === 'fishingspot') { const tool = this.toolItemIcon(m.defId); if (tool) return tool; }
        if (m.type === 'chest' || m.type === 'stall' || m.type === 'tree' || m.type === 'rock' || m.type === 'fishingspot') return ModelIconCache.resolveObject(this.modelIcons, m.assetId, m.defId);
        return null;
    }

    /** A gathering spot's tool item icon (e.g. a fishing spot's `visualToolItemId` → Fishing Net). */
    private toolItemIcon(defId?: number): string | null {
        if (defId == null) return null;
        const tid = this.gm?.objectDefsCache?.get(defId)?.visualToolItemId;
        const ic = tid != null ? this.itemDef(tid)?.icon : null;
        return ic ? ICON_BASE + encodeURIComponent(ic) : null;
    }

    // ── UI (bank-style) ───────────────────────────────────────────────────────
    private registerSidebarIcon(attempt = 0): void {
        if (this.menuIcon) return;
        const pm = (document as any).highlite?.managers?.PanelManager;
        if (!pm?.requestMenuItem) { if (attempt < 20) setTimeout(() => this.registerSidebarIcon(attempt + 1), 400); return; }
        try {
            const [iconEl] = pm.requestMenuItem(CollectionLogPlugin.ICON, 'Collection Log');
            this.menuIcon = iconEl as HTMLElement;
            this.menuIcon.title = 'Collection Log';
            this.menuIcon.onclick = (e: Event) => { e.preventDefault(); e.stopPropagation(); this.toggleUI(); };
        } catch { /* PanelManager race */ }
    }

    private toggleUI(): void { if (this.ui) { this.ui.remove(); this.ui = null; } else { this.buildUI(); } }

    private buildUI(): void {
        const el = document.createElement('div');
        el.id = 'eq-clog';
        const m = this.isMobile;
        Object.assign(el.style, m
            ? {
                position: 'fixed', inset: '0', zIndex: '2147483640',
                display: 'flex', flexDirection: 'column',
                color: '#e8dfce', font: '13px Inter,system-ui,sans-serif', overflow: 'hidden'
            }
            : {
                position: 'fixed', top: '35px', left: '15px', bottom: '175px', zIndex: '2147483600',
                width: '520px', maxWidth: 'calc(100vw - 265px)',
                display: 'flex', flexDirection: 'column',
                border: '2px solid #231109', borderTopColor: '#533221', borderLeftColor: '#533221',
                borderRadius: '2px', color: '#e8dfce', font: '13px Inter,system-ui,sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.6), inset 0 0 10px rgba(0,0,0,0.8)',
                overflow: 'hidden'
            } as CSSStyleDeclaration);
        el.innerHTML = `
          <div style="position:absolute;top:-100vw;left:-100vw;right:-100vw;bottom:-100vw;background:url('https://evilquest.net/ui/parchment.png') #3a3026;transform:rotate(90deg);z-index:-1;pointer-events:none"></div>
          <div style="position:relative;display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:2px solid #231109;box-shadow:inset 0 1px 0 rgba(255,255,255,0.1);overflow:hidden;z-index:1">
            <div style="position:absolute;top:-100vw;left:-100vw;right:-100vw;bottom:-100vw;background:url('https://evilquest.net/ui/stone-dark.png') #2c241b;transform:rotate(90deg);z-index:-1;pointer-events:none"></div>
            <b style="color:#ffd24a;text-shadow:1px 1px 0 #000;position:relative;z-index:1">📒 Collection Log</b>
            <button id="cl-close" style="position:relative;z-index:1;background:#5a2020;border:1px solid #1a1612;border-top-color:#a04040;border-left-color:#a04040;border-radius:2px;color:#e8e8e8;font-size:12px;font-weight:bold;cursor:pointer;padding:2px 7px;text-shadow:1px 1px 0 #000;box-shadow:inset 0 0 4px rgba(0,0,0,0.5)">X</button>
          </div>
          <div style="display:flex;flex:1;min-height:0">
            <div style="width:150px;display:flex;flex-direction:column;flex:none;background:rgba(0,0,0,0.2);border-right:2px solid #231109">
                <div style="padding:4px;border-bottom:1px solid rgba(0,0,0,0.3)">
                    <input id="cl-search" type="text" placeholder="Search..." style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.4);border:1px solid #1a1612;color:#e8dfce;padding:4px;font-size:11px;border-radius:2px;outline:none">
                </div>
                <div id="cl-tabs" style="flex:1;overflow:auto;padding:4px"></div>
            </div>
            <div id="cl-grid" style="flex:1;overflow:auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,48px);grid-auto-rows:48px;gap:8px;align-content:start"></div>
          </div>
          <div style="position:relative;padding:5px 12px;border-top:2px solid #231109;font-size:11px;overflow:hidden;z-index:1">
            <div style="position:absolute;top:-100vw;left:-100vw;right:-100vw;bottom:-100vw;background:url('https://evilquest.net/ui/stone-dark.png') #2c241b;transform:rotate(90deg);z-index:-1;pointer-events:none"></div>
            <div id="cl-foot" style="position:relative;z-index:1;color:#b3a890"></div>
          </div>`;
        document.body.appendChild(el);
        this.ui = el;
        (el.querySelector('#cl-close') as HTMLButtonElement).onclick = () => this.toggleUI();
        const searchInput = el.querySelector('#cl-search') as HTMLInputElement;
        searchInput.value = this.searchQuery;
        searchInput.oninput = () => { this.searchQuery = searchInput.value.toLowerCase(); this.renderUI(); };
        this.renderUI();
    }

    /** A small left-aligned source icon: the model render if cached, else a category glyph. */
    private sourceIconHtml(src: string, size: number): string {
        const url = this.sourceIcon(src);
        if (url) return `<img src="${url}" style="width:${size}px;height:${size}px;object-fit:contain;flex:none">`;
        const glyph = { npc: '⚔️', chest: '📦', stall: '📦', quest: '📜', tree: '🪓', rock: '⛏️', fishingspot: '🎣', other: '•' }[this.sourceMeta(src).type] ?? '•';
        return `<span style="width:${size}px;height:${size}px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:${Math.floor(size * 0.7)}px">${glyph}</span>`;
    }

    private renderUI(): void {
        if (!this.ui) return;
        const log = this.data.log || {};
        const sources = Object.keys(log);
        const isSpecialSource = this.selectedSource === '_all' || this.selectedSource.startsWith('_group:');
        if (!this.selectedSource || (!isSpecialSource && !log[this.selectedSource])) this.selectedSource = sources.sort()[0] || '';

        // bucket sources into their display group
        const byGroup = new Map<string, string[]>();
        for (const g of GROUPS) byGroup.set(g.key, []);
        for (const src of sources) byGroup.get(groupKeyForType(this.sourceMeta(src).type))!.push(src);
        for (const arr of byGroup.values()) arr.sort();

        const tabs = this.ui.querySelector('#cl-tabs') as HTMLDivElement;
        tabs.innerHTML = '';

        const isAllSelected = this.selectedSource === '_all';
        const allBtn = document.createElement('div');
        Object.assign(allBtn.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 6px', cursor: 'pointer',
            color: isAllSelected ? '#ffffff' : '#000000', background: isAllSelected ? '#4a3d2c' : 'transparent', fontWeight: '600', fontSize: '12px', borderRadius: '3px', userSelect: 'none', marginBottom: '6px' } as CSSStyleDeclaration);
        allBtn.innerHTML = `<span style="width:16px;text-align:center;flex:none">🌟</span><span>All Sources</span>`;
        allBtn.onclick = () => { this.selectedSource = '_all'; this.renderUI(); };
        tabs.appendChild(allBtn);
        for (const g of GROUPS) {
            const allMembers = byGroup.get(g.key)!;
            const members = this.searchQuery ? allMembers.filter(m => m.toLowerCase().includes(this.searchQuery)) : allMembers;
            if (!members.length) continue;
            const collapsed = this.searchQuery ? false : !!this.data.collapsed[g.key];

            const isGroupSelected = this.selectedSource === `_group:${g.key}`;
            const header = document.createElement('div');
            Object.assign(header.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 4px', cursor: 'pointer',
                color: isGroupSelected ? '#ffffff' : '#000000', background: isGroupSelected ? '#4a3d2c' : 'transparent', fontWeight: '600', fontSize: '12px', borderRadius: '3px', userSelect: 'none' } as CSSStyleDeclaration);
            header.innerHTML = `<div style="padding:6px;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;font-size:10px;margin:-6px -2px -6px -6px;width:12px">${collapsed ? '▶' : '▼'}</div><span>${g.emoji} ${g.label}</span><span style="margin-left:auto;color:#8a8070;font-size:11px">${members.length}</span>`;
            (header.children[0] as HTMLElement).onclick = (e) => { e.stopPropagation(); this.data.collapsed[g.key] = !collapsed; this.renderUI(); };
            header.onclick = () => { this.selectedSource = `_group:${g.key}`; this.data.collapsed[g.key] = false; this.renderUI(); };
            tabs.appendChild(header);

            if (collapsed) continue;
            for (const src of members) {
                const n = Object.keys(log[src]).length;
                const row = document.createElement('div');
                Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px 4px 8px', cursor: 'pointer',
                    borderRadius: '3px', whiteSpace: 'nowrap', overflow: 'hidden',
                    background: src === this.selectedSource ? '#4a3d2c' : 'transparent', color: src === this.selectedSource ? '#ffffff' : '#000000' } as CSSStyleDeclaration);
                row.innerHTML = `${this.sourceIconHtml(src, 22)}<span style="flex:1;overflow:hidden;text-overflow:ellipsis" onmouseenter="if(this.scrollWidth > this.clientWidth) this.innerHTML = '<marquee scrollamount=3>' + this.textContent + '</marquee>'" onmouseleave="if(this.querySelector('marquee')) this.innerHTML = this.textContent">${src}</span><span style="margin-left:auto;color:#8a8070;font-size:11px">${n}</span>`;
                row.onclick = () => { this.selectedSource = src; this.renderUI(); };
                tabs.appendChild(row);
            }
        }
        if (!sources.length) tabs.innerHTML = '<div style="padding:8px;color:#8a8070;font-size:11px">No drops yet — go kill something.</div>';

        const grid = this.ui.querySelector('#cl-grid') as HTMLDivElement;
        grid.innerHTML = '';
        let items: Record<string, number> = {};
        if (this.selectedSource === '_all') {
            for (const src of sources) {
                for (const [itemId, count] of Object.entries(log[src] || {})) {
                    items[itemId] = (items[itemId] || 0) + (count as number);
                }
            }
        } else if (this.selectedSource.startsWith('_group:')) {
            const gk = this.selectedSource.substring(7);
            for (const src of byGroup.get(gk) || []) {
                for (const [itemId, count] of Object.entries(log[src] || {})) {
                    items[itemId] = (items[itemId] || 0) + (count as number);
                }
            }
        } else {
            items = log[this.selectedSource] || {};
        }
        let total = 0;
        for (const idStr of Object.keys(items).sort((a, b) => items[b] - items[a])) {
            const itemId = Number(idStr), count = items[idStr]; total += count;
            const slot = document.createElement('div');
            slot.title = `${this.itemName(itemId)} ×${count}`;
            Object.assign(slot.style, { position: 'relative', width: '48px', height: '48px', background: '#2a2219', border: '1px solid #1a1612', borderRadius: '3px' } as CSSStyleDeclaration);
            const url = this.itemIcon(itemId);
            const countSpan = `<span style="position:absolute;right:1px;bottom:0;font-size:11px;color:#fff;text-shadow:0 0 3px #000,1px 1px 2px #000">${count > 999 ? Math.floor(count / 1000) + 'k' : count}</span>`;
            slot.innerHTML = (url
                ? `<img src="${url}" style="width:100%;height:100%;object-fit:contain" onerror="this.style.display='none'">`
                : `<span style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:22px;opacity:.45">📦</span>`) + countSpan;
            grid.appendChild(slot);
        }
        let displayName = this.selectedSource;
        if (this.selectedSource === '_all') displayName = 'All Collected Items';
        else if (this.selectedSource.startsWith('_group:')) displayName = 'All ' + (GROUPS.find(g => g.key === this.selectedSource.substring(7))?.label || '');
        
        (this.ui.querySelector('#cl-foot') as HTMLDivElement).textContent =
            sources.length ? `${displayName}: ${Object.keys(items).length} unique · ${total} total` : 'Tracks kills, stalls, chests & quest rewards.';
    }
}

function dist(ax: number, az: number, bx: number, bz: number): number { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
