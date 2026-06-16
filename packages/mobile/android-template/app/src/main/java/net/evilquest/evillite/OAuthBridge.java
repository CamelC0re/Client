package net.evilquest.evillite;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Android port of the desktop Electron OAuth handler (main/oauthLogin.ts).
 *
 * Same RFC 8252 loopback flow: generate PKCE + state, run a 127.0.0.1 server, open the
 * SYSTEM browser to /oauth/authorize (reCAPTCHA runs there, in real Chrome — never in our
 * WebView), catch the redirected code on the loopback, exchange it at /oauth/token, persist
 * the eq_* cookies (CookieManager) + the rotating refresh token (SharedPreferences), and hand
 * the access token back to the renderer.
 *
 * Exposed to the page as `EvilLiteNative` (addJavascriptInterface). The injected ELECTRON_SHIM
 * routes window.electron.ipcRenderer's oauth:* channels here and resolves the JS promise via
 * window.__eqNativeResolve(callbackId, resultJson).
 */
public class OAuthBridge {
    private static final String BASE = "https://evilquest.net";
    private static final String AUTHORIZE = BASE + "/oauth/authorize";
    private static final String TOKEN = BASE + "/oauth/token";
    private static final String REVOKE = BASE + "/oauth/revoke";
    private static final String SCOPE = "game";
    private static final String CLIENT_ID = "evillite-dev"; // matches the desktop dev client
    private static final String PREFS = "evillite_oauth";

    private final Context ctx;
    private final WebView webView;

    private String sessionToken = null;
    private String sessionUser = "";

    OAuthBridge(Context ctx, WebView webView) {
        this.ctx = ctx;
        this.webView = webView;
    }

    // ── JS-facing surface (routed from the ipcRenderer shim) ───────────────────

    @JavascriptInterface
    public void login(final String cbId) {
        new Thread(() -> {
            try {
                JSONObject tok = runAuthorizationFlow();
                persist(tok);
                resolve(cbId, ok(tok));
            } catch (Exception e) {
                resolve(cbId, err(e));
            }
        }, "eq-oauth-login").start();
    }

    @JavascriptInterface
    public void autoLogin(final String cbId) {
        new Thread(() -> {
            if (sessionToken != null) { resolve(cbId, okCached()); return; }
            String refresh = prefs().getString("refresh_token", null);
            if (refresh == null) { resolve(cbId, reason("no-refresh-token")); return; }
            try {
                JSONObject tok = tokenRequest(form(
                    "grant_type", "refresh_token",
                    "client_id", CLIENT_ID,
                    "refresh_token", refresh,
                    "device_id", deviceId()));
                persist(tok);
                resolve(cbId, ok(tok));
            } catch (Exception e) {
                prefs().edit().remove("refresh_token").apply();
                resolve(cbId, reason("refresh-failed: " + e.getMessage()));
            }
        }, "eq-oauth-auto").start();
    }

    @JavascriptInterface
    public void ensureFresh(final String cbId) {
        // Spike: the session token is long-lived enough for testing; no-op-refresh OK here.
        resolve(cbId, sessionToken != null ? okCached() : reason("no-session"));
    }

    @JavascriptInterface
    public void logout(final String cbId) {
        clearSession();
        resolve(cbId, "{\"ok\":true}");
    }

    @JavascriptInterface
    public void status(final String cbId) {
        resolve(cbId, "{\"clientId\":\"" + CLIENT_ID + "\",\"loggedIn\":" + (sessionToken != null)
            + ",\"hasRefresh\":" + (prefs().getString("refresh_token", null) != null) + "}");
    }

    @JavascriptInterface
    public void heartbeat() {
        if (sessionToken != null) prefs().edit().putLong("last_active", System.currentTimeMillis()).apply();
    }

    /** sendSync('oauth:logged-out') — clear the session synchronously and return true. */
    @JavascriptInterface
    public boolean loggedOut() {
        clearSession();
        return true;
    }

    // ── the loopback authorization-code flow ───────────────────────────────────

    private JSONObject runAuthorizationFlow() throws Exception {
        String verifier = b64url(randomBytes(64));
        String challenge = b64url(sha256(verifier));
        String state = b64url(randomBytes(16));

        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(5 * 60 * 1000); // 5-min login timeout
            int port = server.getLocalPort();
            String redirectUri = "http://127.0.0.1:" + port + "/cb";

            String authUrl = AUTHORIZE + "?"
                + "response_type=code"
                + "&client_id=" + enc(CLIENT_ID)
                + "&redirect_uri=" + enc(redirectUri)
                + "&code_challenge=" + enc(challenge)
                + "&code_challenge_method=S256"
                + "&state=" + enc(state)
                + "&scope=" + enc(SCOPE);
            openBrowser(authUrl);

            // Wait for the browser to redirect the code back to the loopback.
            while (true) {
                Socket sock = server.accept();
                String[] cs = handleCallback(sock); // [code, state, error]
                if (cs == null) continue; // not /cb — keep listening
                if (cs[2] != null) throw new Exception("authorize error: " + cs[2]);
                if (cs[0] == null) throw new Exception("no authorization code in callback");
                if (!state.equals(cs[1])) throw new Exception("state mismatch (possible CSRF)");
                return tokenRequest(form(
                    "grant_type", "authorization_code",
                    "client_id", CLIENT_ID,
                    "code", cs[0],
                    "redirect_uri", redirectUri,
                    "code_verifier", verifier,
                    "device_id", deviceId()));
            }
        }
    }

    /** Read one HTTP request off the loopback socket; if it's /cb, return [code,state,error]. */
    private String[] handleCallback(Socket sock) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
        String line = in.readLine(); // e.g. "GET /cb?code=...&state=... HTTP/1.1"
        String code = null, st = null, error = null;
        boolean isCb = false;
        if (line != null && line.startsWith("GET ")) {
            String pathQ = line.split(" ")[1];
            if (pathQ.startsWith("/cb")) {
                isCb = true;
                int q = pathQ.indexOf('?');
                if (q >= 0) {
                    for (String kv : pathQ.substring(q + 1).split("&")) {
                        int eq = kv.indexOf('=');
                        if (eq < 0) continue;
                        String k = kv.substring(0, eq), v = dec(kv.substring(eq + 1));
                        if (k.equals("code")) code = v;
                        else if (k.equals("state")) st = v;
                        else if (k.equals("error")) error = v;
                    }
                }
            }
        }
        String html = "<!doctype html><meta charset=utf-8><body style=\"font:16px system-ui;background:#111;color:#eee;text-align:center;padding-top:18vh\">"
            + "<h2 style=\"color:#b33\">EvilLite</h2><p>" + (isCb ? "Login complete — return to the EvilLite app." : "Not found") + "</p></body>";
        OutputStream out = sock.getOutputStream();
        String status = isCb ? "200 OK" : "404 Not Found";
        out.write(("HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n" + html)
            .getBytes(StandardCharsets.UTF_8));
        out.flush();
        sock.close();
        return isCb ? new String[]{code, st, error} : null;
    }

    private void openBrowser(String url) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(i);
    }

    // ── token endpoint + persistence ───────────────────────────────────────────

    private JSONObject tokenRequest(String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(TOKEN).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream os = conn.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }

        int status = conn.getResponseCode();
        persistSetCookies(conn.getHeaderFields().get("Set-Cookie"));
        BufferedReader r = new BufferedReader(new InputStreamReader(
            status < 400 ? conn.getInputStream() : conn.getErrorStream(), StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (String l; (l = r.readLine()) != null; ) sb.append(l);
        if (status >= 400) throw new Exception("token endpoint " + status + ": " + sb.substring(0, Math.min(200, sb.length())));
        return new JSONObject(sb.toString());
    }

    private void persistSetCookies(List<String> setCookies) {
        if (setCookies == null) return;
        CookieManager cm = CookieManager.getInstance();
        for (String c : setCookies) cm.setCookie(BASE, c);
        cm.flush();
    }

    private void persist(JSONObject tok) {
        sessionToken = tok.optString("access_token", null);
        sessionUser = tok.optString("username", "");
        SharedPreferences.Editor e = prefs().edit();
        String refresh = tok.optString("refresh_token", null);
        if (refresh != null && !refresh.isEmpty()) e.putString("refresh_token", refresh); // rotates
        e.putLong("last_active", System.currentTimeMillis());
        e.apply();
    }

    private void clearSession() {
        sessionToken = null;
        sessionUser = "";
        prefs().edit().remove("refresh_token").apply();
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    private SharedPreferences prefs() { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private String deviceId() {
        SharedPreferences p = prefs();
        String id = p.getString("device_id", null);
        if (id == null) { id = UUID.randomUUID().toString(); p.edit().putString("device_id", id).apply(); }
        return id;
    }

    private void resolve(String cbId, String resultJson) {
        final String js = "window.__eqNativeResolve && window.__eqNativeResolve(" + jsLit(cbId) + "," + resultJson + ");";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private String ok(JSONObject tok) {
        return "{\"ok\":true,\"token\":" + jsLit(tok.optString("access_token", "")) + ",\"username\":"
            + jsLit(tok.optString("username", "")) + ",\"clientId\":\"" + CLIENT_ID + "\"}";
    }
    private String okCached() {
        return "{\"ok\":true,\"token\":" + jsLit(sessionToken == null ? "" : sessionToken) + ",\"username\":"
            + jsLit(sessionUser) + ",\"clientId\":\"" + CLIENT_ID + "\"}";
    }
    private String err(Exception e) { return "{\"ok\":false,\"error\":" + jsLit(String.valueOf(e.getMessage())) + "}"; }
    private String reason(String r) { return "{\"ok\":false,\"reason\":" + jsLit(r) + "}"; }

    private static String form(String... kv) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < kv.length; i += 2) {
            if (sb.length() > 0) sb.append('&');
            sb.append(enc(kv[i])).append('=').append(enc(kv[i + 1]));
        }
        return sb.toString();
    }
    private static String enc(String s) throws Exception { return URLEncoder.encode(s, "UTF-8"); }
    private static String dec(String s) throws Exception { return java.net.URLDecoder.decode(s, "UTF-8"); }

    private static byte[] randomBytes(int n) { byte[] b = new byte[n]; new SecureRandom().nextBytes(b); return b; }
    private static byte[] sha256(String s) throws Exception { return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)); }
    private static String b64url(byte[] b) {
        return android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
    }

    /** JSON string literal (for embedding values into the result/JS-call strings). */
    private static String jsLit(String s) {
        if (s == null) return "\"\"";
        StringBuilder o = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\') o.append("\\\\");
            else if (c == '"') o.append("\\\"");
            else if (c == '\n') o.append("\\n");
            else if (c == '\r') o.append("\\r");
            else if (c < 0x20) o.append(String.format("\\u%04x", (int) c));
            else o.append(c);
        }
        return o.append("\"").toString();
    }
}
