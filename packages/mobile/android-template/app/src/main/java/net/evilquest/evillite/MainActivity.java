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
    // Placeholder; finalise against a real device UA during the spike (reCAPTCHA cares).
    static final String MOBILE_CHROME_UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = this.bridge.getWebView();

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.getSettings().setUserAgentString(MOBILE_CHROME_UA);

        // Take over resource loading: serve /__evillite__/* from assets + rewrite game JS.
        webView.setWebViewClient(new EvilLiteWebViewClient(this.bridge));

        // Same entry point as desktop: a local page under the real origin.
        webView.loadUrl(ENTRY_URL);
    }
}
