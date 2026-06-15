// Pull the World Map plugin source + its prebaked cache into the client tree — the same
// thing the CI does inline, so a LOCAL packaged build matches what CI would ship.
//
// Source resolution order:
//   1. $WORLDMAP_DIR (explicit path to a local evillite-worldmap checkout)
//   2. ../evillite-worldmap sibling of the repo root (the common dev layout)
//   3. a shallow git clone of the plugin repo (fallback for fresh machines)
//
// Run via `yarn sync:plugin` (or it's invoked by the build:* helpers).

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));      // packages/client/scripts
const clientRoot = resolve(here, '..');                   // packages/client
const repoRoot = resolve(here, '..', '..', '..');         // monorepo root
const PLUGIN_REPO = 'https://github.com/atapifire/evillite-worldmap.git';

let src = process.env.WORLDMAP_DIR;
if (src && !existsSync(src)) { console.warn(`[sync-plugin] WORLDMAP_DIR=${src} not found, ignoring`); src = undefined; }
if (!src) {
    const sib = resolve(repoRoot, '..', 'evillite-worldmap');
    if (existsSync(sib)) src = sib;
}
let tmpClone = null;
if (!src) {
    tmpClone = resolve(repoRoot, '.worldmap-cache');
    rmSync(tmpClone, { recursive: true, force: true });
    console.log('[sync-plugin] no local checkout — cloning the plugin repo…');
    execSync(`git clone --depth 1 ${PLUGIN_REPO} "${tmpClone}"`, { stdio: 'inherit' });
    src = tmpClone;
}

const destPlugins = resolve(clientRoot, 'src/renderer/client/plugins');
const destData = resolve(destPlugins, 'data');
mkdirSync(destData, { recursive: true });

const pluginSrc = resolve(src, 'src/WorldMapPlugin.ts');
if (existsSync(pluginSrc)) cpSync(pluginSrc, resolve(destPlugins, 'WorldMapPlugin.ts'));
else console.warn('[sync-plugin] WorldMapPlugin.ts not found in', src);

const dataSrc = resolve(src, 'data');
let n = 0;
if (existsSync(dataSrc)) {
    for (const f of readdirSync(dataSrc)) {
        if (f.endsWith('.json')) { cpSync(resolve(dataSrc, f), resolve(destData, f)); n++; }
    }
}
console.log(`[sync-plugin] synced World Map plugin + ${n} cache file(s) from ${src}`);
if (tmpClone) rmSync(tmpClone, { recursive: true, force: true });
