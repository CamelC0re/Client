// Launch the locally-built UNPACKED app (from `electron-builder --dir`) so devs can test
// the real packaged client without installing it. Used by `yarn try`.
//
// Finds the app binary for the host OS under dist/<platform>-unpacked and runs it
// (passing --no-sandbox on Linux, which unsigned local builds need).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
const plat = process.platform;

function firstExisting(dirs) { return dirs.map((d) => resolve(dist, d)).find((d) => existsSync(d)); }

let bin = null;
let args = [];
if (plat === 'linux') {
    const dir = firstExisting(['linux-unpacked', 'linux-arm64-unpacked']);
    if (dir) {
        // The app binary is the executable that isn't a known Electron/Chromium helper.
        const skip = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);
        const cand = readdirSync(dir).find((f) => {
            if (skip.has(f) || f.includes('.')) return false;
            try { return !!(statSync(join(dir, f)).mode & 0o111); } catch { return false; }
        });
        if (cand) bin = join(dir, cand);
    }
    args = ['--no-sandbox'];
} else if (plat === 'win32') {
    const dir = firstExisting(['win-unpacked', 'win-arm64-unpacked']);
    if (dir) { const exe = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe')); if (exe) bin = join(dir, exe); }
} else if (plat === 'darwin') {
    const dir = firstExisting(['mac', 'mac-arm64', 'mac-universal']);
    if (dir) {
        const appName = readdirSync(dir).find((f) => f.endsWith('.app'));
        if (appName) { bin = 'open'; args = [join(dir, appName)]; }
    }
}

if (!bin) {
    console.error('[run-unpacked] no unpacked build found under dist/ — run `yarn build:unpack` first.');
    process.exit(1);
}
console.log('[run-unpacked] launching', bin, args.join(' '));
const child = spawn(bin, args, { stdio: 'inherit', detached: false });
child.on('exit', (code) => process.exit(code ?? 0));
