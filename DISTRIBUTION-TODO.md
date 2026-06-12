# Distribution — open items

The build/release pipeline works: pushing a `v*` tag builds Linux/Windows/macOS on
native CI runners and publishes a GitHub Release with all installers + the
`latest*.yml` updater feed. These are the remaining setup items.

## 1. Plugin hub — Oni is setting this up
Plugins are currently **bundled into the client build** (the World Map is loaded via
`import.meta.glob`, and CI pulls its source + prebaked cache from the
`evillite-worldmap` repo). The hub will instead distribute plugins **dynamically from a
manifest**. Open questions:
- The manifest endpoint (currently hardcoded to `ryelite.org` in `pluginManager`) needs
  an EvilLite equivalent.
- Where a hub plugin's **prebaked asset cache** lives — today it's baked into the client;
  a hub-distributed plugin needs the cache to travel *with the plugin* (bundled in its
  dist, or hub-fetched) rather than read from the client's packaged files.

**Owner: Oni.** (Full notes in `ONI-HANDOFF-distribution.md`, kept out of git.)

## 3. Code signing — NEEDS setup (builds are currently unsigned)
Unsigned builds make testers hit **Windows SmartScreen** and **macOS Gatekeeper**
warnings. To remove them:
- **Windows:** a code-signing certificate (standard or EV) added as CI secrets; sign the
  NSIS output.
- **macOS:** an Apple Developer ID certificate + notarization — set `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` as
  secrets and flip `CSC_IDENTITY_AUTO_DISCOVERY` back on in `.github/workflows/build.yml`.

Until then, the auto-generated release notes tell testers how to bypass the warnings.

## 4. To discuss later
Misc distribution/polish — e.g. wiring the **in-app updater** to the GitHub Releases feed
(the `latest*.yml` are already attached, and `electron-builder` `publish` points at
`atapifire/EvilLite`), and finalizing whether the plugin lives in the fork or solely in
its own repo.

---
*(#2 — packaged builds shipping a stale plugin that broke the prebaked icon cache — is
fixed: CI now syncs `WorldMapPlugin.ts` from the plugin repo before building.)*
