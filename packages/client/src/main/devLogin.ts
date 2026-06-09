// Copyright (C) 2025  HighLite
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// ─── DEV-ONLY: seamless browser-login session relay ──────────────────────────
//
// Problem: reCAPTCHA v3 structurally penalises Electron, so the in-app login
// intermittently fails with "score too low". A real Chrome on the same machine
// passes fine. Until EvilQuest ships first-party OAuth (see OAUTH-PROPOSAL.md),
// developers need a way to log in without fighting the captcha.
//
// This pops out the *real* Google Chrome (isolated dev profile) for the user to
// log in normally — where reCAPTCHA works — then captures the resulting session
// cookies over the Chrome DevTools Protocol (CDP) and injects them into our
// Electron session. No copy-paste, no browser extension, no MITM proxy.
//
// CDP is required because the game's session cookie (eq_ws_session) is httpOnly:
// it is invisible to document.cookie / bookmarklets, but CDP's Storage.getCookies
// returns it. We talk CDP over a raw-socket WebSocket (no `Origin` header — a
// real browser can't omit Origin, and Chrome's remote-debugging endpoint rejects
// any WebSocket that sends one).
//
// Everything here is gated behind app.isPackaged === false (dev builds only).

import { app, ipcMain, session, BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

const CHROME_CANDIDATES = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
];

const LOGIN_URL = 'https://evilquest.net/play';
// The SPA authenticates a TOKEN it stores in localStorage (not just the cookie):
// on load it reads evilquest_token/evilquest_username and only then POSTs /api/validate.
// So a real login relay must capture these too — the cookie alone never logs you in.
const TOKEN_KEY = 'evilquest_token';
const USERNAME_KEY = 'evilquest_username';
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for the human to log in
const POLL_INTERVAL_MS = 1500;

function findChrome(): string | null {
    for (const c of CHROME_CANDIDATES) {
        try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ─── Minimal CDP-over-WebSocket client (raw socket, no Origin header) ─────────

interface CdpCookie {
    name: string; value: string; domain: string; path: string;
    secure: boolean; httpOnly: boolean; expires: number; sameSite?: string;
}

/**
 * Opens one raw WebSocket to the CDP browser endpoint, sends a single command,
 * and resolves its result. We open a fresh socket per call (simpler than keeping
 * a long-lived connection alive across the poll loop).
 */
function cdpCommand<T = any>(wsUrl: string, method: string, params: object = {}): Promise<T> {
    return new Promise((resolve, reject) => {
        let u: URL;
        try { u = new URL(wsUrl); } catch (e) { return reject(e); }
        const port = Number(u.port || 80);
        const host = u.hostname;
        const reqPath = u.pathname + (u.search || '');

        const socket = net.connect(port, host);
        let handshakeDone = false;
        let buf = Buffer.alloc(0);
        const key = crypto.randomBytes(16).toString('base64');

        const fail = (err: Error) => { try { socket.destroy(); } catch { /**/ } reject(err); };
        const timer = setTimeout(() => fail(new Error('CDP command timed out')), 10000);

        socket.on('error', fail);

        socket.on('connect', () => {
            socket.write(
                `GET ${reqPath} HTTP/1.1\r\n` +
                `Host: ${host}:${port}\r\n` +
                `Upgrade: websocket\r\n` +
                `Connection: Upgrade\r\n` +
                `Sec-WebSocket-Key: ${key}\r\n` +
                `Sec-WebSocket-Version: 13\r\n\r\n`
            );
        });

        const sendFrame = (text: string) => {
            const payload = Buffer.from(text, 'utf8');
            const len = payload.length;
            let header: Buffer;
            const mask = crypto.randomBytes(4);
            if (len < 126) {
                header = Buffer.from([0x81, 0x80 | len]);
            } else if (len < 65536) {
                header = Buffer.alloc(4);
                header[0] = 0x81; header[1] = 0x80 | 126;
                header.writeUInt16BE(len, 2);
            } else {
                header = Buffer.alloc(10);
                header[0] = 0x81; header[1] = 0x80 | 127;
                header.writeBigUInt64BE(BigInt(len), 2);
            }
            const masked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
            socket.write(Buffer.concat([header, mask, masked]));
        };

        socket.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);

            if (!handshakeDone) {
                const sep = buf.indexOf('\r\n\r\n');
                if (sep === -1) return;
                const headerText = buf.slice(0, sep).toString('utf8');
                if (!/101/.test(headerText.split('\r\n')[0] || '')) {
                    return fail(new Error('CDP handshake rejected: ' + headerText.split('\r\n')[0]));
                }
                handshakeDone = true;
                buf = buf.slice(sep + 4);
                sendFrame(JSON.stringify({ id: 1, method, params }));
            }

            // Parse server frames (unmasked) until we get our reply.
            while (buf.length >= 2) {
                const opcode = buf[0] & 0x0f;
                let len = buf[1] & 0x7f;
                let offset = 2;
                if (len === 126) {
                    if (buf.length < 4) return;
                    len = buf.readUInt16BE(2); offset = 4;
                } else if (len === 127) {
                    if (buf.length < 10) return;
                    len = Number(buf.readBigUInt64BE(2)); offset = 10;
                }
                if (buf.length < offset + len) return; // wait for the rest
                const payload = buf.slice(offset, offset + len);
                buf = buf.slice(offset + len);

                if (opcode === 0x8) return fail(new Error('CDP socket closed'));
                if (opcode === 0x9 || opcode === 0xa) continue; // ping/pong
                try {
                    const msg = JSON.parse(payload.toString('utf8'));
                    if (msg.id === 1) {
                        clearTimeout(timer);
                        try { socket.destroy(); } catch { /**/ }
                        if (msg.error) return reject(new Error('CDP error: ' + JSON.stringify(msg.error)));
                        return resolve(msg.result as T);
                    }
                } catch { /* not our frame / fragment, keep reading */ }
            }
        });
    });
}

async function getBrowserWsUrl(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const data = await res.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl from CDP');
    return data.webSocketDebuggerUrl;
}

async function waitForCdp(port: number, timeoutMs = 15000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
        try { return await getBrowserWsUrl(port); }
        catch (e) { lastErr = e; await sleep(300); }
    }
    throw new Error('Chrome CDP did not come up: ' + String(lastErr));
}

/** The evilquest.net page target's WS endpoint (for Runtime.evaluate against its DOM). */
async function getPageWs(port: number): Promise<string | null> {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
    const page = list.find((t) => t.type === 'page' && /evilquest\.net/.test(t.url || '') && t.webSocketDebuggerUrl);
    return page?.webSocketDebuggerUrl ?? null;
}

/** Read the SPA's auth token + username out of the page's localStorage via CDP. */
async function readAuthToken(pageWs: string): Promise<{ token: string; username: string } | null> {
    const expr = `JSON.stringify({token: localStorage.getItem('${TOKEN_KEY}'), username: localStorage.getItem('${USERNAME_KEY}')})`;
    const res = await cdpCommand<any>(pageWs, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const raw = res?.result?.value;
    if (typeof raw !== 'string') return null;
    try {
        const o = JSON.parse(raw);
        return o?.token ? { token: String(o.token), username: String(o.username ?? '') } : null;
    } catch { return null; }
}

// ─── The capture flow ────────────────────────────────────────────────────────

let activeChrome: ChildProcess | null = null;
let activeProfileDir: string | null = null;

function cleanupChrome() {
    if (activeChrome && !activeChrome.killed) {
        try { activeChrome.kill('SIGTERM'); } catch { /**/ }
    }
    activeChrome = null;
    if (activeProfileDir) {
        const dir = activeProfileDir;
        activeProfileDir = null;
        // Best-effort, async — Chrome may still be releasing file locks.
        setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /**/ } }, 2000);
    }
}

async function injectCookies(cookies: CdpCookie[]): Promise<string[]> {
    const wanted = cookies.filter((c) => /evilquest\.net$/.test(c.domain.replace(/^\./, '')));
    const set: string[] = [];
    for (const c of wanted) {
        const host = c.domain.replace(/^\./, '');
        const details: Electron.CookiesSetDetails = {
            url: `https://${host}${c.path || '/'}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: (c.sameSite?.toLowerCase() as any) || 'no_restriction',
        };
        if (c.expires && c.expires > 0) details.expirationDate = c.expires;
        try {
            await session.defaultSession.cookies.set(details);
            set.push(c.name);
        } catch (e) {
            console.warn('[DevLogin] failed to set cookie', c.name, e);
        }
    }
    return set;
}

/** Write the captured token into the client window's localStorage (same evilquest.net
 *  origin), then reload so the SPA's load-time /api/validate picks it up and logs in. */
async function applyAuthToClient(auth: { token: string; username: string }): Promise<void> {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    const js =
        `try{` +
        `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(auth.token)});` +
        `localStorage.setItem(${JSON.stringify(USERNAME_KEY)}, ${JSON.stringify(auth.username)});` +
        `localStorage.setItem('evilquest_saved_username', ${JSON.stringify(auth.username)});` +
        `}catch(e){}`;
    try { await win.webContents.executeJavaScript(js, true); } catch (e) { console.warn('[DevLogin] localStorage inject failed', e); }
    win.webContents.reload();
}

type DevLoginResult = { ok: boolean; captured?: string[]; error?: string };

async function runDevLogin(): Promise<DevLoginResult> {
    if (app.isPackaged) return { ok: false, error: 'dev-login is disabled in packaged builds' };
    if (activeChrome) return { ok: false, error: 'a dev-login is already in progress' };

    const chrome = findChrome();
    if (!chrome) return { ok: false, error: 'Google Chrome not found (looked in: ' + CHROME_CANDIDATES.join(', ') + ')' };

    const port = 9333;
    activeProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evillite-devlogin-'));

    console.log('[DevLogin] launching Chrome for browser login…');
    activeChrome = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${activeProfileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--new-window',
        LOGIN_URL,
    ], { detached: false, stdio: 'ignore' });

    let userClosed = false;
    activeChrome.on('exit', () => { userClosed = true; });

    try {
        const browserWs = await waitForCdp(port);
        console.log('[DevLogin] Chrome up — log in there; waiting for your session token…');

        const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (userClosed) return { ok: false, error: 'Chrome was closed before login completed' };

            // The real signal of a completed login is the SPA writing its token to
            // localStorage. Poll the page target for it.
            let auth: { token: string; username: string } | null = null;
            try {
                const pageWs = await getPageWs(port);
                if (pageWs) auth = await readAuthToken(pageWs);
            } catch { /* page navigating / target gone — retry */ }

            if (auth?.token) {
                // Grab the httpOnly session cookies too, then hand everything to the client.
                let cookies: CdpCookie[] = [];
                try { cookies = (await cdpCommand<{ cookies: CdpCookie[] }>(browserWs, 'Storage.getCookies')).cookies || []; }
                catch { /* cookies are a nice-to-have; the token is what authenticates */ }
                const injectedCookies = await injectCookies(cookies);
                await applyAuthToClient(auth);
                console.log(`[DevLogin] captured login for "${auth.username}" — token + cookies(${injectedCookies.join(',') || 'none'}) injected; reloading client`);
                cleanupChrome();
                return { ok: true, captured: [TOKEN_KEY, ...injectedCookies] };
            }
            await sleep(POLL_INTERVAL_MS);
        }
        return { ok: false, error: 'timed out waiting for login (5 min)' };
    } catch (e) {
        return { ok: false, error: String(e) };
    } finally {
        cleanupChrome();
    }
}

export function registerDevLogin() {
    ipcMain.handle('dev-login:start', async (): Promise<DevLoginResult> => {
        try { return await runDevLogin(); }
        catch (e) { return { ok: false, error: String(e) }; }
    });
    app.on('will-quit', cleanupChrome);
}
