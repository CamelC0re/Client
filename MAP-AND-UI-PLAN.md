# Map + UI plan (client · plugin · hub)

Cross-repo effort:
- **EvilLite client** (this repo) — window/layout, titlebar, sidebar, settings.
- **evillite-worldmap** — the World Map plugin + prebaked icon cache (CI pulls both).
- **EL-Hub** (Oni) — homepage + API; will host the exported map and the plugin hub.

Near-term goal (api): hand the **wiki team a basic exported map** soon. Mid-term (Oni):
integrate the map into the Hub and **iframe it on the wiki** (like Mango's current map).

---

## A. Map export for the wiki  — near-term, highest external value
A self-contained, hostable artifact of the explored map the wiki can `<iframe>`.
- **Approach:** an in-game "Export map" action renders the full explored map at high
  resolution — terrain (the accumulated `worldCanvas`) + object/NPC markers + the
  prebaked model icons — and writes a **standalone bundle**: one HTML pan/zoom viewer +
  the map image (or tiles) + an optional searchable marker list. Opens with no game/login.
- **Data:** terrain from `worldCanvas`; markers from `plugin.data` (objects/NPCs); icons
  from the cache. All captured in one in-game pass.
- **Hub/wiki:** Oni hosts the exported page on EL-Hub; wiki embeds via `<iframe>`.
- **Status:** TODO. Needs the export function + a viewer template. (Claude can build a
  first cut; needs an in-game session with a decently explored map to produce real output.)

## B. Window layout: static titlebar + visible plugin sidebar  — structural, unblocks a lot
**Problem (root cause of Oni's feedback):** the game element is sized to fill the whole
window — done earlier to fix a click-offset bug — so the **titlebar auto-hides** and the
**plugin sidebar is hidden** behind the game canvas.
- **Fix:** lock the game element into a sized container that leaves room for the top bar +
  right sidebar (the RuneLite/HighLite layout). The game canvas must render to the
  container size **with clicks aligned** — the original offset bug came from the game
  sizing its canvas to `window.innerHeight`; handle that properly instead of filling the
  window. (This is the part api + Claude struggled with; it's the real fix to revisit.)
- **Titlebar:** **static by default** + a **Setting** for auto-hide (Oni + api agreed).
  The current auto-hide reveal zone is too tall — raise it.
- **Sidebar:** already exists — `panelManager` builds `highlite_bar` and exposes
  `requestMenuItem(icon, title)` per plugin (the HighLite/RuneLite model). It just isn't
  visible (the layout) and plugins need to register their icon.
- **Status:** TODO — highest structural priority; unblocks the sidebar, the static
  titlebar, and a discoverable map-open button.

## C. Open the map discoverably
- `M` opens it (works today, but undiscoverable — Oni couldn't find it).
- Add a **sidebar plugin icon** via `panelManager.requestMenuItem` once the sidebar is
  visible (B) — RuneLite-style. Optionally a button near the minimap too.
- **Status:** depends on B.

## D. World Map UI polish (the "Claude notes")
- **Follow ON/OFF:** route every change through one source of truth + show a clear visual
  ON/OFF state (was buggy — Jump/drag flipped it without updating the button). — **DONE**
- **Close → ✕** icon instead of a red "Close" button. — **DONE**
- **Floor controls:** compact stepper; **hide entirely when the map has one floor** (the
  overworld is all floor 0), reappear in multi-floor areas. — TODO
- **Jump:** keep (Enter already triggers it); only enable with search text; clearer
  tooltip. Could be removed in favor of Enter-only — TBD with api.
- **Background:** replace flat near-black (`#0a0a0a`) with the **game's chat-panel tile
  texture** as a repeating `CanvasPattern`, so the map matches the vanilla UI. Needs the
  live chat-panel `background-image` URL (grab it in-game). — TODO

## Cross-repo / coordination
- **Plugin** source of truth = `evillite-worldmap` (CI copies its `WorldMapPlugin.ts` +
  `data/` into the client build). UI/plugin changes land there.
- **Client structural** (layout/titlebar/sidebar/settings) = this repo (fork `dev` → CI →
  releases). api merges to `main` / opens PRs when stable.
- **Hub** = Oni (homepage, API, plugin manifest, hosting the exported map).
- Builds: any `v*` tag → CI builds Linux/Windows/macOS + publishes a GitHub Release.
