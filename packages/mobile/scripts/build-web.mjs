// Stage the EvilLite renderer for the Android build.
//
// The mobile shell reuses the SAME renderer the desktop client ships. We build the
// client's renderer, then copy its output into `www/` (alongside the placeholder
// index.html). Capacitor bundles `www/` into the APK at `assets/public/`, so at runtime
// EvilLiteWebViewClient.shouldInterceptRequest serves `/__evillite__/<file>` from
// `assets/public/<file>` — i.e. client.html lands at assets/public/client.html and the
// renderer's relative `./assets/...` references resolve under /__evillite__/.
//
// NOTE: the desktop renderer is built for Electron (electron-vite). For mobile it must be
// built WITHOUT Electron-only assumptions (ipcRenderer is already a safe no-op outside
// Electron via PluginAssetCache; OAuth + asset-cache file I/O still need mobile backends —
// see SPIKE.md). For the spike we copy the existing renderer output as-is to see how far
// the WebView gets.

import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = join(here, '..');
const repoRoot = join(mobileRoot, '..', '..');

// electron-vite emits the renderer here by default. Adjust if the client build output moves.
const rendererOut = join(repoRoot, 'packages', 'client', 'out', 'renderer');
const wwwDir = join(mobileRoot, 'www');

if (!existsSync(rendererOut)) {
    console.error(`[build-web] renderer output not found at ${rendererOut}`);
    console.error('[build-web] run `yarn workspace @evillite/client build` first.');
    process.exit(1);
}

// Clear previously-staged renderer files but keep the Capacitor entry index.html.
for (const entry of readdirSync(wwwDir)) {
    if (entry === 'index.html') continue;
    rmSync(join(wwwDir, entry), { recursive: true, force: true });
}
cpSync(rendererOut, wwwDir, { recursive: true });
console.log(`[build-web] staged renderer → ${wwwDir} (client.html → assets/public/client.html)`);
