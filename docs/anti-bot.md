# EvilLite anti-bot policy

EvilLite is a mod client for EvilQuest. **It must never be — or become — a tool for botting EvilQuest.**
This document is the policy for the client and plugins, the reasoning behind it, and the review
checklist for the Plugin Hub.

## The one principle

**Every action in the game must originate from a real, in-the-moment user input. EvilLite never
fabricates input and never weakens EvilQuest's server-side anti-bot.**

## Why this is enough (and where the real protection lives)

EvilQuest enforces anti-bot **server-side**. Every game command is stamped with an `inputSeq` taken
from a ticket that is minted **only** when the game's own `window`-level `pointerdown`/key listener
sees a **trusted** browser input event (`Event.isTrusted === true`). A command with no ticket ships
`inputSeq = 0` and the server discards it as an *inputless (bot) command*.

Consequence: a bot that drives the game programmatically — calling `gm.handleGroundClick(...)`,
crafting move packets, dispatching synthetic events (`dispatchEvent` → `isTrusted === false`) —
**already fails server-side.** We do not need to build our own bot detection. We need to **not hand
anyone a bypass.** That shapes everything below.

### The bypasses we must never provide
1. **Trusted-input injection.** Chrome DevTools Protocol (`Input.dispatchMouseEvent` /
   `dispatchKeyEvent`) produces events with `isTrusted === true`, which *do* mint the ticket. So
   **remote debugging is an anti-bot backdoor** and is hard-gated to unpackaged (dev) builds only —
   a release can never open the port (`main/index.ts`, enforced by the CI guard).
2. **Ticket forgery.** Calling the game's `sendInputActivity` / input-ticket internals directly mints
   a ticket without a real event. Forbidden in client and plugins (CI guard).
3. **Synthetic game input.** Constructing `KeyboardEvent`/`MouseEvent`/`PointerEvent`/`TouchEvent` to
   drive the game, or OS-level input automation (`robotjs`, `nut-js`). Forbidden (CI guard).
4. **Automation affordances.** No macro/scripting engine that emits input, no headless mode, no
   "auto-fish/auto-fight" behaviour, no replaying recorded inputs.

## What plugins MAY and MAY NOT do

**Allowed**
- **Read** game state (positions, inventory, map, skills, events) and render UI/overlays.
- **Reorder or relabel existing** menu options / UI the game already provides.
- Audio/visual cues (e.g. a tick timer) that inform a human; the human still acts.
- Translate a **real user click** on plugin UI into a game action the game already supports — e.g. the
  World Map's click-to-move, which fires synchronously inside the user's genuine click so it rides
  *that click's* ticket (it is rejected otherwise, by design). It never fabricates the click.

**Forbidden**
- Generate an input the game lacks, or issue an action not tied to a real user input.
- Anything in "the bypasses we must never provide" above.
- Auto-respond to game state (auto-eat, auto-prayer-flick, auto-aggro, pathing bots, etc.).

## Plugin Hub review checklist (for approval/build)

Reject a plugin if it:
- references `sendInputActivity`, `*InputTicket*`, or other input-ticket internals;
- constructs/dispatches `KeyboardEvent`/`MouseEvent`/`PointerEvent`/`TouchEvent`, or uses `robotjs` /
  `nut-js` or similar;
- enables remote debugging, spawns a debuggable browser, or attaches over CDP;
- issues game actions (move/attack/interact/bank/etc.) not gated on a real, immediate user input;
- ships a macro/automation/scripting loop, timer-driven actions, or input replay.

The same CI guard (`scripts/guard-input-fabrication.mjs`) can run over a submitted plugin's source as
the first gate before a human review.

## What we deliberately do NOT do, and why

We do **not** sandbox `window.gm` away from plugins. Legit plugins need broad **read** access (the
World Map reads `gm` extensively), and the server already rejects ticketless actions — so hiding
methods adds breakage for little gain. The defense is layered instead: **server-side ticket
enforcement** (EvilQuest) + **no client bypasses** (this policy + the CI guard) + **Hub review**.

## The honest limit

EvilLite is open source; a hostile fork can strip anything we add. We cannot technically stop that.
What we guarantee is that the **official client and ecosystem ship zero automation capability and
never weaken EvilQuest's defenses.** A fork that adds botting is on the botter — and is still caught
by the server-side ticket system. We compete on *not being the easy on-ramp*, and we cooperate with
the EvilQuest developers rather than working around them (consistency, not spoofing).

## Mobile (Android / Capacitor)

The Android client is a native WebView (Chromium) in a Capacitor shell — same trusted-input concern.
`WebView.setWebContentsDebuggingEnabled(true)` (or a `debuggable` APK) makes the WebView inspectable
via `chrome://inspect` over adb, and CDP there injects `isTrusted:true` input that bypasses the ticket
system — the mobile equivalent of the desktop remote-debugging port.

So distribution splits the same way as the desktop updater (fork = test, canonical = shipped):
- **Fork builds (`atapifire/EvilLite`)** → **debug APK** (debuggable, WebView inspectable) — for our
  own testing. `v*` tags on the fork still produce installable debug APKs.
- **Canonical builds (`CamelC0re/Client`)** → **signed release APK** (`debuggable=false`) — WebView
  debugging stays off. The CI build **fails** if the signing secrets are missing rather than shipping
  a debuggable APK (`build.yml`, keyed on `github.repository`).
- `MainActivity` calls `setWebContentsDebuggingEnabled(FLAG_DEBUGGABLE)` — explicit and auditable, so
  a non-debuggable release keeps it off regardless of Capacitor defaults.
- Release signing + the CI secrets it needs: **`docs/release-signing.md`**.

## Enforcement in this repo
- `scripts/guard-input-fabrication.mjs` — scans `packages/client/src` + `packages/core/src` +
  `packages/mobile` (incl. the Android shell `.java`), run in CI after the plugin sync so bundled
  plugins are covered. Fails the build on any vector above, and on a literal
  `setWebContentsDebuggingEnabled(true)`.
- `main/index.ts` — `remote-debugging-port` hard-gated to `!app.isPackaged`.
- `main/devLogin.ts` — the dev browser-login (CDP session relay) is not even registered in packaged
  builds.
- `MainActivity.java` — WebView debugging gated to `FLAG_DEBUGGABLE`; canonical CI ships a signed,
  non-debuggable release APK.
