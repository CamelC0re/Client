# Releasing & local builds

## Branches
- **`dev`** — active development / integration. All feature branches PR into here.
- **`main`** — stable. `dev → main` when we cut a stable release.

Work on a feature branch → PR into `dev`. Don't push straight to `dev`/`main`.

## Two release channels (already wired)
The client has a **Release Channel** setting (Beta / Stable) and the auto-updater respects it.
Which channel a build belongs to is decided by the **version/tag suffix** — one workflow does both:

| Tag you push | GitHub Release | Channel | Audience |
|---|---|---|---|
| `v0.2.0-beta.16` (has `-`) | **pre-release** | **Beta** | devs + testers |
| `v0.2.0` (clean) | **full release** | **Stable** | players |

- Cut **betas from `dev`** (`vX.Y.Z-beta.N`) → testers on the Beta channel auto-update.
- Cut **stable from `main`** (`vX.Y.Z`) → players on the Stable channel auto-update.

## Cutting a release
1. Bump `packages/client/package.json` `version` (e.g. `0.2.0-beta.16`).
2. Commit, then tag + push the tag:
   ```bash
   git tag -a v0.2.0-beta.16 -m "EvilLite v0.2.0-beta.16"
   git push origin v0.2.0-beta.16
   ```
3. CI (`.github/workflows/build.yml`) builds Linux/Windows/macOS and publishes the GitHub
   Release on **this repo** (where the tag was pushed). Pre-release flag is automatic
   (`contains(ref,'-')`). The in-app updater reads from `build.publish` → `Metsutan/EvilLite`.

> CI only runs on the repo that holds the workflow + tag. Since CI lives here now, you can't
> rely on it for quick local iteration — build locally (below).

## Testing builds locally
CI won't trigger until a PR/tag, so use these for day-to-day testing:

| Command (`cd packages/client`) | What it does |
|---|---|
| `yarn dev` | Run from source with HMR — the fast inner loop (not a packaged build). |
| `yarn sync:plugin` | Pull the latest World Map plugin + prebaked cache into the tree (same as CI). |
| `yarn try` | **Build the packaged app (unpacked) and launch it** — fastest way to test the *built* client. Syncs the plugin first. |
| `yarn dist` | Build a full installer for your OS (`.deb`/`.exe`/`.dmg`) into `dist/`, to test install. |

Notes:
- `yarn try` / `yarn dist` auto-run `sync:plugin`. To point at a local plugin checkout other
  than the `../evillite-worldmap` sibling, set `WORLDMAP_DIR=/path/to/evillite-worldmap`.
- Each dev builds for their own OS (electron-builder targets the host platform).
- Linux unsigned builds run with `--no-sandbox` (handled automatically by `yarn try`).

## Plugins
Plugins live in their own repos (e.g. `evillite-worldmap`) and are synced in at build time.
The Plugin Hub loads them. New plugin → new repo from the base template.
