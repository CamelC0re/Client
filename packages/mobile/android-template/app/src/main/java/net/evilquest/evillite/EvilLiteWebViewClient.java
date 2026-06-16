package net.evilquest.evillite;

import android.net.Uri;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Android analog of the desktop client's Electron protocol.handle('https').
 *
 * Two jobs, both via intercepting WebView resource loads:
 *   1. Serve EvilLite's own renderer from app assets under the real evilquest.net origin
 *      (so the page is genuinely https://evilquest.net — cookies/WebSocket stay same-origin).
 *   2. Rewrite every game .js to append the class-exposure shim the Reflector needs
 *      (document.client.set(<Class>, <Class>) + window.__eqSourceModules.push(...)).
 *      That rewrite is the whole reason hooks/plugins work; ported from the Electron handler.
 *
 * Anything we don't handle is delegated to Capacitor's BridgeWebViewClient (super), so the
 * bridge keeps working.
 *
 * SPIKE status: interception + rewrite is the feasibility proof. Cookie persistence,
 * UA/Client-Hint normalisation (reCAPTCHA) and asset MIME coverage need on-device validation.
 */
public class EvilLiteWebViewClient extends BridgeWebViewClient {
    private static final Pattern CLASS_RE = Pattern.compile("\\bclass\\s+([A-Za-z0-9_]+)");

    // The renderer is built for Electron and expects the @electron-toolkit preload globals
    // (window.electron / settings / screenshot via exposeInMainWorld). A WebView has no preload,
    // so we inject this shim into the served HTML before the renderer's modules run. The
    // ipcRenderer's oauth:* channels are routed to the native EvilLiteNative (OAuthBridge);
    // everything else is a no-op (asset-cache load resolves to undefined → caches empty until a
    // Filesystem backend lands; see SPIKE.md).
    private static final String ELECTRON_SHIM =
        "(function(){var noop=function(){};var N=function(){return window.EvilLiteNative;};" +
        "var cbN=0,cbM={};" +
        "window.__eqNativeResolve=function(id,res){var f=cbM[id];if(f){delete cbM[id];f(res);}};" +
        "function nat(m){return new Promise(function(res){var n=N();if(!n||typeof n[m]!=='function'){res(undefined);return;}" +
        "var id='cb'+(++cbN);cbM[id]=res;try{n[m](id);}catch(e){delete cbM[id];res(undefined);}});}" +
        "var ipc={postMessage:noop," +
        "on:function(){return ipc;},once:function(){return ipc;},off:function(){return ipc;}," +
        "addListener:function(){return ipc;},removeListener:function(){return ipc;},removeAllListeners:function(){return ipc;}," +
        "invoke:function(ch){" +
        "if(ch==='oauth:login')return nat('login');" +
        "if(ch==='oauth:auto-login')return nat('autoLogin');" +
        "if(ch==='oauth:ensure-fresh')return nat('ensureFresh');" +
        "if(ch==='oauth:logout')return nat('logout');" +
        "if(ch==='oauth:status')return nat('status');" +
        "return Promise.resolve(undefined);}," +
        "send:function(ch){var n=N();if(!n)return;try{if(ch==='oauth:heartbeat')n.heartbeat();else if(ch==='oauth:logged-out')n.loggedOut();}catch(e){}}," +
        "sendSync:function(ch){var n=N();if(n&&ch==='oauth:logged-out'){try{return n.loggedOut();}catch(e){}}return null;}};" +
        "if(!window.electron){window.electron={ipcRenderer:ipc," +
        "process:{platform:'android',env:{},versions:{},argv:[]}," +
        "webFrame:{setZoomFactor:noop,setZoomLevel:noop,getZoomLevel:function(){return 0;},getZoomFactor:function(){return 1;}}};}" +
        "if(!window.process){window.process={platform:'android',env:{},versions:{},argv:[],nextTick:function(f){setTimeout(f,0);}};}" +
        // window.settings + window.screenshot are the other two preload globals (exposeInMainWorld).
        "if(!window.settings){window.settings={getAll:function(){return Promise.resolve({});}," +
        "getByName:function(){return Promise.resolve(undefined);},set:function(){return Promise.resolve();}," +
        "selectDirectory:function(){return Promise.resolve(null);}};}" +
        "if(!window.screenshot){window.screenshot={capture:function(){return Promise.resolve(null);}};}" +
        "})();";

    public EvilLiteWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        // Keep evilquest.net navigations (incl. the post-login window.location.reload() and the
        // SPA's own routing) INSIDE the WebView, where our interceptor serves them. Capacitor's
        // default treats evilquest.net as "external" and would punt it to a real browser — which
        // has no interceptor, so client.html 404s and the in-app client never logs in.
        String host = request.getUrl().getHost();
        if ("evilquest.net".equals(host)) return false; // false = let the WebView load it
        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String host = url.getHost();
        String path = url.getPath();
        if ("evilquest.net".equals(host) && path != null) {

            // 1. EvilLite's own renderer files, served from bundled assets.
            if (path.startsWith("/__evillite__/")) {
                String asset = "public/" + path.substring("/__evillite__/".length());
                try {
                    InputStream stream = view.getContext().getAssets().open(asset);
                    Map<String, String> h = new HashMap<>();
                    h.put("Access-Control-Allow-Origin", "*");
                    if (asset.endsWith(".html")) {
                        // Inject the electron preload shim before the renderer's scripts run.
                        String html = injectShim(readAll(stream));
                        return new WebResourceResponse("text/html", "UTF-8", 200, "OK", h,
                            new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                    }
                    return new WebResourceResponse(mimeOf(asset), "UTF-8", 200, "OK", h, stream);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                        new HashMap<>(), new ByteArrayInputStream(
                            ("EvilLite asset not found: " + asset).getBytes(StandardCharsets.UTF_8)));
                }
            }

            // 2. Game JS: fetch the real file, append the class-exposure shim, return rewritten.
            if (path.endsWith(".js")) {
                try {
                    return rewriteGameJs(url.toString());
                } catch (Exception e) {
                    return null; // fall back to the network on any error
                }
            }
        }

        // Everything else: let Capacitor / the WebView handle it normally.
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse rewriteGameJs(String fullUrl) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(fullUrl).openConnection();
        conn.setRequestMethod("GET");
        conn.setInstanceFollowRedirects(true);
        String cookie = CookieManager.getInstance().getCookie(fullUrl);
        if (cookie != null) conn.setRequestProperty("Cookie", cookie);
        conn.setRequestProperty("Referer", "https://evilquest.net/");

        StringBuilder bodyBuf = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) != -1) bodyBuf.append(buf, 0, n);
        }
        String src = bodyBuf.toString();

        // Same shim the Electron handler injects (see windows/client/index.ts).
        StringBuilder sb = new StringBuilder(src);
        sb.append("\nif (!document.client) document.client = new Map();\n");
        Matcher m = CLASS_RE.matcher(src);
        while (m.find()) {
            String cls = m.group(1);
            sb.append("try { document.client.set('").append(cls).append("', ").append(cls).append("); } catch(e){}\n");
        }
        sb.append("if (!window.__eqSourceCode) window.__eqSourceCode = \"\";\n");
        sb.append("window.__eqSourceCode += ").append(jsString(src + "\n")).append(";\n");
        sb.append("if (!window.__eqSourceModules) window.__eqSourceModules = [];\n");
        sb.append("window.__eqSourceModules.push(").append(jsString(src + "\n")).append(");\n");
        sb.append("if (window.onEqModuleLoaded) window.onEqModuleLoaded();\n");

        // no-store: the Reflector must re-run the shim on every module load.
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Cache-Control", "no-store, must-revalidate");
        return new WebResourceResponse("application/javascript", "UTF-8", 200, "OK", h,
            new ByteArrayInputStream(sb.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static String readAll(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) != -1) sb.append(buf, 0, n);
        }
        return sb.toString();
    }

    private String injectShim(String html) {
        String tag = "<script>" + ELECTRON_SHIM + "</script>";
        int i = html.indexOf("<head>");
        if (i >= 0) return html.substring(0, i + 6) + tag + html.substring(i + 6);
        return tag + html;
    }

    private String mimeOf(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".webm")) return "video/webm";
        return "application/octet-stream";
    }

    /** Minimal JSON-string encode (matches JSON.stringify for embedding source as a JS literal). */
    private String jsString(String s) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            int code = (int) c;
            if (c == '\\') out.append("\\\\");
            else if (c == '"') out.append("\\\"");
            else if (c == '\n') out.append("\\n");
            else if (c == '\r') out.append("\\r");
            else if (c == '\t') out.append("\\t");
            else if (code == 0x2028) out.append("\\u2028"); // JS line separator
            else if (code == 0x2029) out.append("\\u2029"); // JS paragraph separator
            else if (code < 0x20) out.append(String.format("\\u%04x", code));
            else out.append(c);
        }
        return out.append("\"").toString();
    }
}
