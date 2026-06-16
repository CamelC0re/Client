package net.evilquest.evillite;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor host activity for the EvilLite mobile shell.
 *
 * Capacitor normally serves the bundled web app from a localhost server. We bypass that:
 * the EvilLite renderer must run under the REAL https://evilquest.net origin (same-origin
 * cookies + WebSocket), with game JS rewritten for the Reflector. So we install our own
 * WebViewClient (EvilLiteWebViewClient, which owns shouldInterceptRequest) and navigate
 * the WebView straight to the EvilLite entry URL.
 */
public class MainActivity extends BridgeActivity {
    static final String ENTRY_URL = "https://evilquest.net/__evillite__/client.html";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = this.bridge.getWebView();

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // NO User-Agent override: we present the WebView's REAL device identity (honest +
        // consistent with the underlying Client Hints), mirroring the desktop "consistency,
        // not spoofing" principle. Spoofing a different device is exactly what trips anti-abuse
        // false positives. Login itself runs in the system browser, so reCAPTCHA sees real Chrome.

        // Native OAuth (RFC 8252 loopback + system browser). The injected ELECTRON_SHIM routes
        // window.electron.ipcRenderer's oauth:* channels to this `EvilLiteNative` object.
        webView.addJavascriptInterface(new OAuthBridge(this, webView), "EvilLiteNative");

        // Take over resource loading: serve /__evillite__/* from assets + rewrite game JS.
        webView.setWebViewClient(new EvilLiteWebViewClient(this.bridge));

        // Same entry point as desktop: a local page under the real origin.
        webView.loadUrl(ENTRY_URL);
    }
}
