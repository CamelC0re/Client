// Copyright (C) 2025  HighLite
//
// reCAPTCHA v3 warm-up.
//
// EvilQuest's login uses invisible reCAPTCHA v3, whose score depends partly on how
// long Google has observed the session before the protected action runs. A cold
// first execute scores low (hence "the first login fails, the second works"); by
// the second attempt Google has watched the session longer and bumps the score.
//
// This module reproduces that observation time automatically: once grecaptcha is
// available it fires a few throwaway executes spaced over the first ~15s, so by the
// time the user clicks Login the session is already "warm" and the first real token
// scores like a normal second attempt. Tokens are discarded; this only builds trust
// and refreshes the _GRECAPTCHA cookie. Entirely client-side, ships in the package.

function findSiteKey(): string | null {
    // 1. The v3 loader script: recaptcha/api.js?render=<KEY>
    const scripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[];
    for (const s of scripts) {
        const m = s.src.match(/recaptcha\/(?:enterprise|api)\.js\?[^"']*\brender=([^&"']+)/);
        if (m && m[1] && m[1] !== 'explicit') return m[1];
    }
    // 2. The anchor iframe: recaptcha/api2/anchor?...&k=<KEY>
    const frames = Array.from(document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"]')) as HTMLIFrameElement[];
    for (const f of frames) {
        const m = f.src.match(/[?&]k=([^&]+)/);
        if (m && m[1]) return m[1];
    }
    // 3. grecaptcha's internal config, populated after load.
    try {
        const cfg = (window as any).___grecaptcha_cfg;
        const clients = cfg?.clients;
        if (clients) {
            for (const id of Object.keys(clients)) {
                const client = clients[id];
                // The sitekey lives on a nested object; scan one level deep for a plausible key.
                for (const k of Object.keys(client || {})) {
                    const v = client[k];
                    if (v && typeof v === 'object') {
                        for (const kk of Object.keys(v)) {
                            const sit = v[kk]?.sitekey;
                            if (typeof sit === 'string' && sit.length > 20) return sit;
                        }
                    }
                }
            }
        }
    } catch { /* ignore */ }
    return null;
}

function warmOnce(grecaptcha: any, key: string) {
    try {
        const p = grecaptcha.execute(key, { action: 'warmup' });
        if (p && typeof p.then === 'function') p.then(() => {}, () => {});
    } catch { /* ignore */ }
}

function startWarmup() {
    const deadline = Date.now() + 45_000;
    const poll = setInterval(() => {
        const grecaptcha = (window as any).grecaptcha;
        const key = findSiteKey();
        const ready = grecaptcha && typeof grecaptcha.execute === 'function' && key;
        if (ready) {
            clearInterval(poll);
            // A SINGLE warm execute a few seconds after load gives reCAPTCHA a little
            // observation time (the thing that made the historical "2nd try" pass)
            // without the bot-like rapid-fire executes that lower the score on their own.
            setTimeout(() => {
                try {
                    if (typeof grecaptcha.ready === 'function') grecaptcha.ready(() => warmOnce(grecaptcha, key));
                    else warmOnce(grecaptcha, key);
                } catch { warmOnce(grecaptcha, key); }
            }, 3_500);
            console.log('[reCAPTCHA] warm-up scheduled for site key …' + key.slice(-6));
        } else if (Date.now() > deadline) {
            clearInterval(poll);
        }
    }, 500);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWarmup, { once: true });
} else {
    startWarmup();
}
