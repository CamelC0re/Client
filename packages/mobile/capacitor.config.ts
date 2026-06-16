import type { CapacitorConfig } from '@capacitor/cli';

// EvilLite mobile shell (Android spike).
//
// The desktop client loads `https://evilquest.net/__evillite__/client.html`: a LOCAL
// page served under the REAL evilquest.net origin (so cookies / WebSocket are
// same-origin), with every game `.js` rewritten on the fly to expose its classes to
// the Reflector. On mobile we reproduce that with a native WebViewClient that
// implements `shouldInterceptRequest` (see android-template/EvilLiteWebViewClient.kt).
//
// So we do NOT use Capacitor's default local server. Instead the native layer
// navigates the WebView to the https URL and the interceptor serves /__evillite__/*
// from app assets + rewrites the game JS. `webDir` still holds the built renderer that
// the interceptor reads from.
const config: CapacitorConfig = {
    appId: 'net.evilquest.evillite',
    appName: 'EvilLite',
    webDir: 'www',
    // We navigate to the real origin ourselves; don't let Capacitor host a localhost server.
    server: {
        androidScheme: 'https',
        // The interceptor owns evilquest.net; the WebView is pointed there in MainActivity.
        // (Documented in SPIKE.md — Capacitor's bundled-web flow is bypassed on purpose.)
    },
    android: {
        // Allow the WebView to load the live origin + rewrite its assets.
        allowMixedContent: false,
    },
};

export default config;
