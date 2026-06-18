# Android release signing (canonical / shipped APK)

The shipped Android APK must be a **signed release** build (`debuggable=false`) so its WebView can't
be driven over `chrome://inspect` — see [anti-bot.md](anti-bot.md). Fork builds stay **debug** APKs
for testing and need none of this.

The canonical CI (`build.yml`, Android job) builds `assembleRelease` with **AGP injected signing**
(`-Pandroid.injected.signing.*`), so the Capacitor-generated `build.gradle` is left untouched — it
just needs a keystore + four secrets on the **`CamelC0re/Client`** repo.

## One-time: create a release keystore

```bash
keytool -genkeypair -v \
  -keystore evillite-release.keystore \
  -alias evillite \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass '<STORE_PASSWORD>' -keypass '<KEY_PASSWORD>' \
  -dname "CN=EvilLite, O=EvilLite, C=US"
```

Keep `evillite-release.keystore` **private and backed up** — losing it means a new app identity
(users must reinstall) and a new App Link fingerprint. Do **not** commit it.

## Add the CI secrets (CamelC0re/Client → Settings → Secrets → Actions)

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | `base64 -w0 evillite-release.keystore` (the keystore, base64-encoded) |
| `ANDROID_KEYSTORE_PASSWORD` | the `-storepass` above |
| `ANDROID_KEY_ALIAS` | `evillite` |
| `ANDROID_KEY_PASSWORD` | the `-keypass` above |

Until these exist, a **canonical** Android build fails on purpose (it refuses to ship a debuggable
APK). Fork builds are unaffected.

## App Link fingerprint (for mobile OAuth, later)

The release keystore's SHA-256 is the fingerprint EvilQuest's OAuth `assetlinks.json` must list for the
App Link redirect login (epic #2 / mobile OAuth). Get it with:

```bash
keytool -list -v -keystore evillite-release.keystore -alias evillite | grep SHA256
```

Hand that SHA-256 to the EvilQuest devs when wiring up the App Link redirect. (Debug builds have a
different, throwaway fingerprint.)
