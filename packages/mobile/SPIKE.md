# EvilLite Mobile — Android Spike

Status: **VALIDATED on an emulator — the full client loads to the EvilQuest login screen.**
APK builds (Java interceptor, no Kotlin plugin), installs, and runs on an Android-14 AVD; the
renderer, the JS-rewrite interception, the game-script injection and Babylon.js (WebGL2) all work.
The remaining gap is login (OAuth/reCAPTCHA from a mobile WebView).

Tracking: Metsutan/EvilLite **#4** (spike), under epic **#2**.

## What was proven on-device (Android 14 AVD)

Booting the APK reached, in order (logcat / screenshots):
1. interceptor serves `/__evillite__/client.html` from assets ✅
2. renderer loads — but needs Electron preload globals it doesn't have in a WebView. We inject a
   shim into the served HTML for the three `exposeInMainWorld` globals: **`electron`** (ipcRenderer/
   process/webFrame), **`settings`**, **`screenshot`** ✅
3. `[EvilLite] OAuth auto-login: no session` → `Found 1 scripts in /play HTML` →
   `Script injection complete` → `Preparing game client interception...` ✅ (the Reflector path works)
4. `Babylon.js v7.54.3 - WebGL2` ✅ (game engine initialises under software GL)
5. **EvilQuest login screen renders** with the "Authorize EvilLite Login" (OAuth) button ✅

So the two big unknowns — interception and the Reflector — are **answered: they work.** The shim
(`ELECTRON_SHIM` in EvilLiteWebViewClient) is how a WebView stands in for the Electron preload.

## Login: WORKS on a real device (validated on a Galaxy S22)
The native `OAuthBridge` runs the RFC 8252 loopback flow through the **system browser**, so reCAPTCHA
runs in real Chrome — and a real phone scores fine (an **emulator scores too low**, so the AVD can't
finish login; use a device). Two device-specific fixes were needed:
- **Token exchange in the foreground.** The browser doesn't auto-return from a loopback redirect, and
  Android/Samsung restricts background DNS — so the native `/oauth/token` POST failed with
  `UnknownHostException` while the app was backgrounded. Fix: bring the app to front on the callback +
  **retry the exchange for ~20s** so it completes once foregrounded.
- **Keep the post-login reload in the WebView.** `window.location.reload()` after login was punted to
  an external browser by Capacitor (evilquest.net is "external" to the localhost app) → client.html
  404. Fix: override `shouldOverrideUrlLoading` to keep evilquest.net navigation in the WebView.

## Still open (next child issues)
- **Auto-return after login** (UX): Android 12+ blocks an app from foregrounding itself from the
  background, so the user must swipe back manually. Proper fix = a **custom-scheme / App Link redirect**
  (`evillite://oauth/callback`) so the browser launches the app — but the OAuth **server must whitelist
  that redirect_uri** (today it only allows the 127.0.0.1 loopback). Coordinate with the EQ devs.
- **`PluginAssetCache` on mobile**: the shim's `ipcRenderer.invoke` returns undefined for the cache →
  model-icons/terrain load empty. A Capacitor Filesystem backend (or serve the bundled JSON via the
  interceptor) restores them.
- reCAPTCHA-from-a-mobile-WebView is moot for login (system browser handles it), but watch it for any
  in-game flows that re-trigger it.

## The one finding that matters

EvilLite is not "a website in a WebView." The desktop client only works because the Electron
main process runs a **network MITM** (`protocol.handle('https')`, see
`packages/client/src/main/windows/client/index.ts`):

1. it serves `/__evillite__/*` from local renderer files **under the real evilquest.net origin**, and
2. it **rewrites every game `.js`** to append a shim that exposes the game's classes
   (`document.client.set(<Class>, <Class>)`) and accumulates module source
   (`window.__eqSourceModules`). **That rewrite is the Reflector.** No rewrite → no hooks → no plugins.

So a mobile port stands or falls on whether we can reproduce that interception. **We can:**
Android's `WebViewClient.shouldInterceptRequest` is the direct analog of `protocol.handle`.
`EvilLiteWebViewClient.kt` in this folder ports the serve-local + rewrite-JS logic verbatim.
This is the feasibility proof — the rest is wiring.

## Architecture map (desktop → mobile)

| Electron main process | Android / Capacitor equivalent | Status |
|---|---|---|
| `protocol.handle` serve `/__evillite__/*` | `shouldInterceptRequest` → app assets | ✅ ported (`EvilLiteWebViewClient`) |
| `protocol.handle` rewrite game `.js` (class exposure) | `shouldInterceptRequest` → fetch + rewrite | ✅ ported (the centerpiece) |
| cookie inject + Set-Cookie persist | `CookieManager` (+ interceptor for httpOnly) | ⚠️ sketched, validate on device |
| UA / Client-Hint normalisation (reCAPTCHA) | `WebSettings.userAgentString` + header rewrite | ⚠️ placeholder UA, must test |
| `ipcMain` / `ipcRenderer` | Capacitor plugin bridge (or in-WebView JS) | ⛔ not started |
| `PluginAssetCache` file I/O (model-icons, terrain) | Capacitor Filesystem backend | ⛔ not started (caches blank on mobile until then) |
| OAuth via system browser | Capacitor Browser / AppAuth | ⛔ not started |
| detached map BrowserWindow | in-page overlay host (already unified) | ✅ free — the "one viewer, two hosts" work pays off |
| desktop window chrome / title bar | mobile full-screen WebView | n/a |

## What's in this folder

```
packages/mobile/
  package.json            # Capacitor deps + scripts
  capacitor.config.ts     # appId net.evilquest.evillite; bypasses Capacitor's localhost server
  scripts/build-web.mjs   # stages the client renderer into www/public/ (APK assets)
  www/index.html          # Capacitor-required entry; only shows if navigation failed
  android-template/       # native files to drop into the generated android/ project:
    .../MainActivity.java           # installs the interceptor, points WebView at the entry URL
    .../EvilLiteWebViewClient.java  # the shouldInterceptRequest MITM (serve-local + rewrite-JS)
  android-env.sh          # sources JDK 17 + Android SDK from ~ (no sudo) — see below
  SPIKE.md
```

The native `android/` project itself is **generated** by `npx cap add android` (gitignored);
the `android-template/` files are copied into it (see steps below). Java, not Kotlin, so no extra
Gradle plugin is needed (Capacitor's app module is Java by default).

## Toolchain (no sudo — installs into your home dir)

```bash
# JDK 17
curl -sL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" \
  -o /tmp/jdk17.tgz && mkdir -p ~/opt && tar xzf /tmp/jdk17.tgz -C ~/opt
# Android SDK command-line tools + packages
curl -sL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" -o /tmp/cmdtools.zip
mkdir -p ~/Android/Sdk/cmdline-tools && unzip -q /tmp/cmdtools.zip -d ~/Android/Sdk/cmdline-tools
mv ~/Android/Sdk/cmdline-tools/cmdline-tools ~/Android/Sdk/cmdline-tools/latest
source packages/mobile/android-env.sh
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

## Build an APK

```bash
cd packages/mobile
source android-env.sh                 # JAVA_HOME + ANDROID_HOME (no sudo)
yarn install

# 1. Build the renderer and stage it into www/public
yarn workspace @evillite/client build
yarn build:web

# 2. Generate the native Android project + drop in the EvilLite native files
npx cap add android
cp android-template/app/src/main/java/net/evilquest/evillite/*.java \
   android/app/src/main/java/net/evilquest/evillite/   # overwrites the generated stub MainActivity
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# 3. Build a debug APK
npx cap sync android
cd android && ./gradlew assembleDebug   # → app/build/outputs/apk/debug/app-debug.apk

# 4. Sideload onto a plugged-in phone (USB debugging on)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Risks to validate on-device (the point of the spike)

1. **reCAPTCHA from an Android WebView.** The desktop work is all about a *consistent* browser
   identity. A WebView UA + Client-Hints must be internally consistent or login fails. This is the
   highest-risk unknown. Test the login flow first.
2. **WebSocket same-origin.** The game opens a WS to evilquest.net. Confirm it connects when the
   page origin is the intercepted https origin (cookies must ride along).
3. **Rewrite cost.** We re-fetch + re-scan every `.js` on each load. Bundles are large; measure the
   latency on a mid-range phone (consider caching the parsed class list, not the response).
4. **`assets.open` path mapping.** Confirm the renderer's relative asset references resolve under
   `assets/public/`.

## Recommended next steps (child issues under #2)

- [ ] Get login working (OAuth backend + reCAPTCHA UA) — unblocks everything.
- [ ] Capacitor Filesystem backend for `PluginAssetCache` (restores model-icons + terrain).
- [ ] ipc shim so plugins that use `electron.ipcRenderer` degrade cleanly / route via a Capacitor plugin.
- [ ] iOS target (same Capacitor project; needs a Mac + Apple Developer account).
