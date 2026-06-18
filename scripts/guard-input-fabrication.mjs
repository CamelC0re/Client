#!/usr/bin/env node
// Anti-bot guard — fails the build if the source contains an input-fabrication / trusted-input
// bypass that would help bot EvilQuest. EvilQuest enforces anti-bot server-side (commands need an
// inputSeq minted by a TRUSTED browser input event); this keeps EvilLite from ever shipping a way
// around it. See docs/anti-bot.md. Pure Node, no deps, so it runs in CI without install.
//
// Allowlisting a genuinely-benign line: append a trailing comment `anti-bot:allow <reason>`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['packages/client/src', 'packages/core/src'];
const EXTS = new Set(['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'out', 'build', '.git']);

// Each rule: a regex + why it's dangerous. Benign UI events (new Event('input'|'change'|'resize'))
// are deliberately NOT matched — only synthetic POINTER/KEY/MOUSE/TOUCH events (real game input).
const RULES = [
  { re: /\bsendInputActivity\b/, msg: "calls the game's input-activity fn (mints an anti-bot ticket without a real user event)" },
  { re: /\b(consumePendingInputTicket|pendingInputTicketSeq|sendInputTicket|inputTicketBurst)\b/, msg: 'touches EvilQuest input-ticket internals (ticket forgery)' },
  { re: /new\s+(KeyboardEvent|PointerEvent|TouchEvent)\b/, msg: 'constructs a synthetic input event (fabricated game input; isTrusted=false but still a botting pattern)' },
  // Synthetic MouseEvent, EXCEPT "contextmenu" — a right-click context menu is plugin UI, not a
  // gameplay input (and isTrusted=false can't drive the game anyway). e.g. the World Map's mobile
  // long-press opens its own "Share location" menu via a synthetic contextmenu.
  { re: /new\s+MouseEvent\s*\(\s*["'](?!contextmenu\b)/, msg: 'constructs a synthetic mouse input event (fabricated game input)' },
  { re: /\b(robotjs|nut-js|@nut-tree)\b/, msg: 'OS-level input automation library (auto-clicker / bot)' },
];

// remote-debugging-port must be hard-gated to dev (!app.isPackaged) — CDP injects isTrusted input.
const RDP = /['"]remote-debugging-port['"]/;

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name))) out.push(p);
  }
}

const files = [];
for (const r of ROOTS) walk(r, files);

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (/anti-bot:allow/.test(line)) return; // explicitly justified
    for (const rule of RULES) {
      if (rule.re.test(line)) violations.push({ file, line: i + 1, text: line.trim(), msg: rule.msg });
    }
    if (RDP.test(line)) {
      // require !app.isPackaged within the preceding 8 lines (the dev gate)
      const ctx = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      if (!/!\s*app\.isPackaged/.test(ctx)) {
        violations.push({ file, line: i + 1, text: line.trim(), msg: 'remote-debugging-port not hard-gated to !app.isPackaged (CDP injects trusted input → anti-bot bypass)' });
      }
    }
  });
}

if (violations.length) {
  console.error('\n❌ Anti-bot guard FAILED — input-fabrication / trusted-input bypass found:\n');
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n    ${v.text}\n    ↳ ${v.msg}\n`);
  console.error(`${violations.length} violation(s). EvilLite must never fabricate input or weaken EvilQuest's anti-bot.`);
  console.error('If a match is genuinely benign, append a trailing `anti-bot:allow <reason>` comment.\n');
  process.exit(1);
}
console.log(`✅ Anti-bot guard passed (${files.length} files scanned, no input-fabrication vectors).`);
