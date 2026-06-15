import { Plugin } from '@evillite/core/src/interfaces/highlite/plugin/plugin.class';
import { SettingsTypes } from '@evillite/core/src/interfaces/highlite/plugin/pluginSettings.interface';

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
 * Item data: EntityManager.itemDefsCache (id → {name, icon}); icons at https://evilquest.net/items/<icon>.
 *
 * Stall/chest/quest rewards add straight to inventory (no ground item) — that path needs inventory
 * hooks and is wired via logCollected() once we finish probing the inventory live. The engine +
 * UI + persistence already support arbitrary sources.
 */

const ICON_BASE = 'https://evilquest.net/items/';
const DROP_MATCH_TILES = 2;     // ground item must spawn within this many tiles of the death
const DROP_WINDOW_MS = 6000;    // …and within this long after the death
const ENGAGED_TTL_MS = 15000;   // an NPC counts as "yours" if you targeted it within this window

interface Engaged { name: string; x: number; z: number; defId: number; t: number; }
interface PendingDrop { name: string; x: number; z: number; t: number; }

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

    constructor() {
        super();
        this.settings.deathRangeTiles = { text: 'Max kill distance (tiles)', type: SettingsTypes.range, value: 6, min: 2, max: 14, callback: () => {} } as any;
    }

    init(): void { this.settings.enable.value = true; this.ensureData(); }
    start(): void { this.ensureData(); this.registerSidebarIcon(); this.installKeyHandler(); this.startEngine(); this.info('Collection Log started.'); }
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

    private get gm(): any { return this.gameHooks?.GameManager?.Instance ?? (window as any).gm ?? null; }
    private get em(): any { return this.gameHooks?.EntityManager?.Instance ?? null; }

    private ensureData(): void { if (!this.data.log || typeof this.data.log !== 'object') this.data.log = {}; }

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
                    this.pending.push({ name: e.name, x: e.x, z: e.z, t: now });
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
                if (match) this.logCollected(gi.itemId | 0, gi.quantity | 0 || 1, match.name);
            }
            // forget ground ids that are gone so re-spawned ids don't leak memory
            for (const id of this.seenGround) if (!seenNow.has(id)) this.seenGround.delete(id);
        }
    }

    /** Generic entry point — also used for stall/chest/quest rewards once inventory hooks land. */
    private logCollected(itemId: number, qty: number, source: string): void {
        if (!itemId || qty <= 0) return;
        this.ensureData();
        const src = source || 'Unknown';
        if (!this.data.log[src]) this.data.log[src] = {};
        this.data.log[src][itemId] = (this.data.log[src][itemId] || 0) + qty;
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
    /** 2D icon if the item ships one, else the pre-rendered 3D icon (every item has one). */
    private itemIcon(itemId: number): string { const ic = this.itemDef(itemId)?.icon; return ic ? ICON_BASE + ic : this.itemIcon3d(itemId); }
    private itemIcon3d(itemId: number): string { return `${ICON_BASE}3d/${itemId}.png`; }

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
        Object.assign(el.style, {
            position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483600',
            width: '520px', height: '640px', display: 'flex', flexDirection: 'column',
            background: '#3a3026', border: '2px solid #1a1612', borderTopColor: '#6b5b45', borderLeftColor: '#6b5b45',
            borderRadius: '4px', color: '#e8dfce', font: '13px Inter,system-ui,sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.6)',
        } as CSSStyleDeclaration);
        el.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#2c241b;border-bottom:1px solid #1a1612">
            <b style="color:#ffd24a">📒 Collection Log</b>
            <button id="cl-close" style="background:transparent;border:none;color:#ccc;font-size:16px;cursor:pointer">✕</button>
          </div>
          <div style="display:flex;flex:1;min-height:0">
            <div id="cl-tabs" style="width:150px;flex:none;overflow:auto;background:#2c241b;border-right:1px solid #1a1612;padding:4px"></div>
            <div id="cl-grid" style="flex:1;overflow:auto;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,48px);grid-auto-rows:48px;gap:8px;align-content:start"></div>
          </div>
          <div id="cl-foot" style="padding:5px 12px;background:#2c241b;border-top:1px solid #1a1612;font-size:11px;color:#b3a890"></div>`;
        document.body.appendChild(el);
        this.ui = el;
        (el.querySelector('#cl-close') as HTMLButtonElement).onclick = () => this.toggleUI();
        this.renderUI();
    }

    private renderUI(): void {
        if (!this.ui) return;
        const log = this.data.log || {};
        const sources = Object.keys(log).sort();
        if (!this.selectedSource || !log[this.selectedSource]) this.selectedSource = sources[0] || '';

        const tabs = this.ui.querySelector('#cl-tabs') as HTMLDivElement;
        tabs.innerHTML = '';
        for (const src of sources) {
            const n = Object.keys(log[src]).length;
            const t = document.createElement('div');
            t.textContent = `${src} (${n})`;
            Object.assign(t.style, { padding: '5px 8px', cursor: 'pointer', borderRadius: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                background: src === this.selectedSource ? '#4a3d2c' : 'transparent', color: src === this.selectedSource ? '#ffd24a' : '#d8cdb6' } as CSSStyleDeclaration);
            t.onclick = () => { this.selectedSource = src; this.renderUI(); };
            tabs.appendChild(t);
        }
        if (!sources.length) tabs.innerHTML = '<div style="padding:8px;color:#8a8070;font-size:11px">No drops yet — go kill something.</div>';

        const grid = this.ui.querySelector('#cl-grid') as HTMLDivElement;
        grid.innerHTML = '';
        const items = log[this.selectedSource] || {};
        let total = 0;
        for (const idStr of Object.keys(items).sort((a, b) => items[b] - items[a])) {
            const itemId = Number(idStr), count = items[idStr]; total += count;
            const slot = document.createElement('div');
            slot.title = `${this.itemName(itemId)} ×${count}`;
            Object.assign(slot.style, { position: 'relative', width: '48px', height: '48px', background: '#2a2219', border: '1px solid #1a1612', borderRadius: '3px' } as CSSStyleDeclaration);
            const url = this.itemIcon(itemId), fb = this.itemIcon3d(itemId);
            slot.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:contain" onerror="if(this.dataset.fb){this.style.display='none'}else{this.dataset.fb=1;this.src='${fb}'}">` +
                `<span style="position:absolute;right:1px;bottom:0;font-size:11px;color:#fff;text-shadow:0 0 3px #000,1px 1px 2px #000">${count > 999 ? Math.floor(count / 1000) + 'k' : count}</span>`;
            grid.appendChild(slot);
        }
        (this.ui.querySelector('#cl-foot') as HTMLDivElement).textContent =
            sources.length ? `${this.selectedSource}: ${Object.keys(items).length} unique · ${total} total` : 'Tracks kills, stalls, chests & quest rewards.';
    }
}

function dist(ax: number, az: number, bx: number, bz: number): number { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
