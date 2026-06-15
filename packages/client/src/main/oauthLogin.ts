// Copyright (C) 2025  HighLite
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// ─── OAuth 2.0 Authorization Code + PKCE login (the sanctioned EvilQuest path) ──
//
// This is the PRIMARY login for EvilLite, replacing both the reCAPTCHA in-app
// login (which never worked for Electron) and the dev CDP relay (Ctrl+Shift+L,
// kept only as a fallback until this is proven).
//
// Flow (RFC 8252 / 7636):
//   1. main generates PKCE (S256) + state, opens a loopback listener, and opens
//      the SYSTEM browser to /oauth/authorize. reCAPTCHA runs there, in a real
//      browser — the app never touches it.
//   2. The browser redirects the one-time code back to http://127.0.0.1:<port>/cb.
//   3. main exchanges the code at /oauth/token (no foreign browser Origin), gets
//      { access_token (= EvilQuest session token), refresh_token, username } and
//      the eq_ws_session / eq_device_id cookies.
//   4. The renderer drops the access_token into localStorage (evilquest_token) and
//      the SPA authenticates exactly as the website does — the injected game client
//      then handles the device-key + WebSocket handshake itself.
//
// Refresh tokens rotate and are persisted (OS-keychain encrypted) in userData,
// OUTSIDE the session storage we wipe each launch — so subsequent launches log in
// silently with NO browser.
//
// Client identity: evillite-dev for local dev builds, evillite for the official
// packaged release (overridable via EVILLITE_OAUTH_CLIENT).

import { app, ipcMain, session, shell, net, safeStorage } from 'electron';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const BASE = 'https://evilquest.net';
const AUTHORIZE = `${BASE}/oauth/authorize`;
const TOKEN = `${BASE}/oauth/token`;
const REVOKE = `${BASE}/oauth/revoke`;
const SCOPE = 'game';

function clientId(): string {
    return process.env.EVILLITE_OAUTH_CLIENT || (app.isPackaged ? 'evillite' : 'evillite-dev');
}

function storeFile(): string {
    return path.join(app.getPath('userData'), 'evillite-oauth.json');
}

// ─── Persistent store: device_id (UUID v4, stable) + rotating refresh token ─────

interface Store {
    device_id: string;
    refresh_token?: string;
    // Epoch ms of the last time this session was known active (login / refresh / heartbeat).
    // Silent auto-login is only allowed within AUTO_LOGIN_WINDOW_MS of this — see oauth:auto-login.
    last_active?: number;
}

function readStore(): Store {
    try {
        const obj = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as {
            device_id?: string; refresh_token?: string; refresh_token_enc?: string; last_active?: number;
        };
        if (obj.device_id) {
            let refresh = obj.refresh_token;
            if (obj.refresh_token_enc && safeStorage.isEncryptionAvailable()) {
                try { refresh = safeStorage.decryptString(Buffer.from(obj.refresh_token_enc, 'base64')); } catch { /* ignore */ }
            }
            return { device_id: obj.device_id, refresh_token: refresh, last_active: obj.last_active };
        }
    } catch { /* missing / corrupt — fall through to fresh */ }
    const fresh: Store = { device_id: crypto.randomUUID() };
    writeStore(fresh);
    return fresh;
}

function writeStore(s: Store): void {
    try {
        const out: Record<string, string | number> = { device_id: s.device_id };
        if (typeof s.last_active === 'number') out.last_active = s.last_active;
        if (s.refresh_token) {
            if (safeStorage.isEncryptionAvailable()) {
                out.refresh_token_enc = safeStorage.encryptString(s.refresh_token).toString('base64');
            } else {
                out.refresh_token = s.refresh_token; // fallback (no OS keychain available)
            }
        }
        fs.writeFileSync(storeFile(), JSON.stringify(out), { mode: 0o600 });
    } catch (e) {
        console.warn('[OAuth] writeStore failed', e);
    }
}

// The silent auto-login window. Mirrors EvilQuest's 5-minute in-game AFK logout: a
// reload/reconnect within this window of the last activity silently re-logs in; a colder
// start (first login of a session) must be a deliberate, manual login.
const AUTO_LOGIN_WINDOW_MS = 5 * 60 * 1000;

/** Record that the session is active right now (gates silent auto-login on next launch). */
function touchActivity(): void {
    const s = readStore();
    s.last_active = Date.now();
    writeStore(s);
}

function clearRefresh(): void {
    const s = readStore();
    s.refresh_token = undefined;
    writeStore(s);
}

// ─── PKCE helpers ───────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce(): { verifier: string; challenge: string } {
    const verifier = b64url(crypto.randomBytes(64)); // 86 chars, all in the unreserved set
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

// ─── Token endpoint (code exchange + refresh) ───────────────────────────────

interface TokenResult {
    access_token: string;
    refresh_token?: string;
    username?: string;
    expires_in?: number;
}

async function persistSetCookies(setCookies: string[]): Promise<void> {
    for (const raw of setCookies) {
        const parts = raw.split(';').map((s) => s.trim());
        const [name, ...rest] = parts[0].split('=');
        const details: Electron.CookiesSetDetails = {
            url: BASE,
            name: name.trim(),
            value: rest.join('=').trim(),
            secure: parts.some((p) => /^secure$/i.test(p)),
            httpOnly: parts.some((p) => /^httponly$/i.test(p)),
        };
        const maxAge = parts.find((p) => /^max-age=/i.test(p));
        const expires = parts.find((p) => /^expires=/i.test(p));
        if (maxAge) {
            const secs = parseInt(maxAge.split('=')[1], 10);
            if (!isNaN(secs)) details.expirationDate = Date.now() / 1000 + secs;
        } else if (expires) {
            const d = new Date(expires.split('=').slice(1).join('='));
            if (!isNaN(d.getTime())) details.expirationDate = d.getTime() / 1000;
        }
        await session.defaultSession.cookies.set(details).catch(() => {});
    }
}

/** POST /oauth/token from the MAIN process (no foreign browser Origin), persist the
 *  returned eq_ws_session / eq_device_id cookies, and return the token payload. */
async function tokenRequest(body: Record<string, string>): Promise<TokenResult> {
    const res = await net.fetch(TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        bypassCustomProtocolHandlers: true,
    } as any);
    await persistSetCookies(res.headers.getSetCookie?.() ?? []);
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`token endpoint ${res.status}: ${t.slice(0, 200)}`);
    }
    return (await res.json()) as TokenResult;
}

// ─── Authorization-code flow (system browser + loopback listener) ───────────

let flowInProgress = false;

function runAuthorizationFlow(): Promise<TokenResult> {
    return new Promise((resolve, reject) => {
        const store = readStore();
        const { verifier, challenge } = makePkce();
        const state = b64url(crypto.randomBytes(16));
        let redirectUri = '';
        let settled = false;

        const server = http.createServer();
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { server.close(); } catch { /* ignore */ }
            fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error('login timed out (5 min)'))), 5 * 60 * 1000);

        server.on('request', async (req, res) => {
            const u = new URL(req.url || '', 'http://127.0.0.1');
            if (u.pathname !== '/cb') { res.writeHead(404); res.end(); return; }
            const code = u.searchParams.get('code');
            const retState = u.searchParams.get('state');
            const err = u.searchParams.get('error');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                `<!doctype html><meta charset=utf-8><body style="font:16px system-ui;background:#111;color:#eee;text-align:center;padding-top:18vh">` +
                `<h2 style="color:#b33">EvilLite</h2><p>${err ? 'Login failed: ' + err : 'Login complete — you can close this tab and return to EvilLite.'}</p></body>`,
            );
            if (err) return finish(() => reject(new Error('authorize error: ' + err)));
            if (!code) return finish(() => reject(new Error('no authorization code in callback')));
            if (retState !== state) return finish(() => reject(new Error('state mismatch (possible CSRF) — aborted')));
            try {
                const tok = await tokenRequest({
                    grant_type: 'authorization_code',
                    client_id: clientId(),
                    code,
                    redirect_uri: redirectUri,
                    code_verifier: verifier,
                    device_id: store.device_id,
                });
                finish(() => resolve(tok));
            } catch (e) {
                finish(() => reject(e as Error));
            }
        });

        server.on('error', (e) => finish(() => reject(e)));

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            redirectUri = `http://127.0.0.1:${port}/cb`;
            const authUrl = `${AUTHORIZE}?` + new URLSearchParams({
                response_type: 'code',
                client_id: clientId(),
                redirect_uri: redirectUri,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                state,
                scope: SCOPE,
            }).toString();
            console.log(`[OAuth] opening system browser for "${clientId()}" login (redirect ${redirectUri})`);
            shell.openExternal(authUrl);
        });
    });
}

// ─── Session state + IPC ────────────────────────────────────────────────────

type LoginResult = { ok: boolean; token?: string; username?: string; clientId?: string; error?: string; reason?: string };

/** The access token obtained this app session, cached so the renderer's per-load
 *  auto-login call doesn't trigger a fresh network refresh (which rotates the token). */
let sessionAccess: { token: string; username: string } | null = null;
// Epoch ms when the current access token / session cookie expires. The EvilQuest session
// token is only good for a couple hours; without a proactive refresh, auth-gated assets
// (item icons under /items/3d, model GLBs) start 401-ing mid-session. Default to 1h if the
// server doesn't send expires_in.
let accessExpiresAt = 0;
let refreshing: Promise<LoginResult> | null = null;

function persist(tok: TokenResult): void {
    const s = readStore();
    if (tok.refresh_token) s.refresh_token = tok.refresh_token; // rotates — store new, discard old
    s.last_active = Date.now(); // a successful login/refresh counts as activity
    writeStore(s);
    sessionAccess = { token: tok.access_token, username: tok.username || '' };
    accessExpiresAt = Date.now() + (tok.expires_in && tok.expires_in > 0 ? tok.expires_in * 1000 : 60 * 60 * 1000);
}

/** Clear the persisted + in-memory session so the silent auto-login won't immediately
 *  re-login. Called by the in-game logout (via /api/logout interception) and the logout
 *  IPC. Clears SYNCHRONOUSLY (so a reload's auto-login sees no token), revokes in the
 *  background. */
export function clearOAuthSession(): void {
    const rt = readStore().refresh_token;
    clearRefresh();        // sync: auto-login finds no refresh token after this
    sessionAccess = null;  // sync: drop the in-session cached access token
    accessExpiresAt = 0;
    if (rt) {
        net.fetch(REVOKE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: clientId(), token: rt }).toString(),
            bypassCustomProtocolHandlers: true,
        } as any).catch(() => {});
    }
}

export function registerOAuthLogin(): void {
    // Full interactive login: opens the system browser once.
    ipcMain.handle('oauth:login', async (): Promise<LoginResult> => {
        if (flowInProgress) return { ok: false, error: 'a login is already in progress' };
        flowInProgress = true;
        try {
            const tok = await runAuthorizationFlow();
            persist(tok);
            console.log(`[OAuth] logged in as "${tok.username}" via ${clientId()}`);
            return { ok: true, token: tok.access_token, username: tok.username || '', clientId: clientId() };
        } catch (e) {
            return { ok: false, error: String(e) };
        } finally {
            flowInProgress = false;
        }
    });

    // Silent auto-login on launch: refresh the persisted token, no browser. Cached
    // for the rest of the app session so repeated calls don't re-rotate the token.
    ipcMain.handle('oauth:auto-login', async (): Promise<LoginResult> => {
        if (sessionAccess) return { ok: true, token: sessionAccess.token, username: sessionAccess.username, clientId: clientId() };
        const store = readStore();
        if (!store.refresh_token) return { ok: false, reason: 'no-refresh-token' };
        // First login of a session is always manual: only silently re-login if the session
        // was active within the last 5 minutes (a reload/reconnect, matching the AFK window).
        const idle = store.last_active ? Date.now() - store.last_active : Infinity;
        if (idle > AUTO_LOGIN_WINDOW_MS) {
            console.log(`[OAuth] silent auto-login skipped — session idle ${Math.round(idle / 1000)}s (> ${AUTO_LOGIN_WINDOW_MS / 1000}s); manual login required`);
            return { ok: false, reason: 'manual-login-required' };
        }
        try {
            const tok = await tokenRequest({
                grant_type: 'refresh_token',
                client_id: clientId(),
                refresh_token: store.refresh_token,
                device_id: store.device_id,
            });
            persist(tok);
            console.log(`[OAuth] silent refresh ok — "${tok.username}"`);
            return { ok: true, token: tok.access_token, username: tok.username || '', clientId: clientId() };
        } catch (e) {
            clearRefresh(); // expired/revoked — fall back to interactive login next
            return { ok: false, reason: 'refresh-failed: ' + String(e) };
        }
    });

    ipcMain.handle('oauth:logout', async (): Promise<LoginResult> => {
        clearOAuthSession();
        return { ok: true };
    });

    // Proactive token refresh: the renderer calls this periodically while logged in. When the
    // access token / session cookie is near expiry we refresh it (refresh_token grant), which
    // also re-sets the eq_ws_session cookie that auth-gates assets — preventing the multi-hour
    // session 401s (item icons, model GLBs failing to load). Returns the new token so the
    // renderer can update localStorage.evilquest_token. Coalesced so concurrent calls share one
    // network refresh; rotates the refresh token like the silent auto-login.
    ipcMain.handle('oauth:ensure-fresh', async (): Promise<LoginResult & { refreshed?: boolean }> => {
        if (!sessionAccess) return { ok: false, reason: 'no-session' };
        const SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry
        if (Date.now() < accessExpiresAt - SKEW_MS) return { ok: true, refreshed: false };
        const store = readStore();
        if (!store.refresh_token) return { ok: false, reason: 'no-refresh-token' };
        if (!refreshing) {
            refreshing = (async (): Promise<LoginResult> => {
                try {
                    const tok = await tokenRequest({
                        grant_type: 'refresh_token',
                        client_id: clientId(),
                        refresh_token: store.refresh_token!,
                        device_id: store.device_id!,
                    });
                    persist(tok);
                    console.log('[OAuth] proactive token refresh ok — session extended');
                    return { ok: true, token: tok.access_token, username: tok.username || '', clientId: clientId() };
                } catch (e) {
                    console.warn('[OAuth] proactive token refresh failed', e);
                    return { ok: false, reason: 'refresh-failed: ' + String(e) };
                } finally {
                    refreshing = null;
                }
            })();
        }
        const r = await refreshing;
        return { ...r, refreshed: r.ok };
    });

    // The renderer pings this while the user is logged in + in-world, keeping last_active
    // fresh so a reload/reopen within the 5-min window silently re-logs in. Once the pings
    // stop (app closed, or AFK kick clears the session), a later cold start needs a manual
    // login. Only counts while we actually hold a session.
    ipcMain.on('oauth:heartbeat', () => { if (sessionAccess) touchActivity(); });

    ipcMain.handle('oauth:status', () => ({
        clientId: clientId(),
        loggedIn: !!sessionAccess,
        hasRefresh: !!readStore().refresh_token,
    }));

    // The game clears localStorage.evilquest_token on EVERY logout — the manual button,
    // the server's 5-min AFK kick, and session-expiry all funnel through it. The renderer
    // hooks that removal and sendSync's here, so we drop our session BEFORE the page can
    // reload: the silent auto-login then finds nothing and cannot bounce the user back in
    // (which would otherwise bypass the game's logout / AFK timer). sendSync = no race.
    ipcMain.on('oauth:logged-out', (e) => {
        console.log('[OAuth] game logout detected (token cleared) — clearing our session');
        clearOAuthSession();
        e.returnValue = true; // unblock the renderer's sendSync
    });
}
