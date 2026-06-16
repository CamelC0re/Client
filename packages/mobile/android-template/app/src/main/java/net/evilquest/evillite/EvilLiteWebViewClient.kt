package net.evilquest.evillite

import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.Bridge
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * The Android analog of the desktop client's Electron `protocol.handle('https')`.
 *
 * Two jobs, both done by intercepting WebView resource loads:
 *   1. Serve EvilLite's own renderer from app assets under the real evilquest.net origin
 *      (so the page is genuinely https://evilquest.net — cookies/WebSocket stay same-origin).
 *   2. Rewrite every game `.js` to append the class-exposure shim the Reflector needs
 *      (`document.client.set(<Class>, <Class>)` + `window.__eqSourceModules.push(...)`).
 *      This rewrite is the whole reason hooks/plugins work; it is ported verbatim from
 *      the Electron protocol handler.
 *
 * Everything else returns null → the WebView fetches it normally.
 *
 * SPIKE status: the interception + rewrite path is the feasibility proof. Cookie
 * persistence, UA/Client-Hint normalisation (reCAPTCHA), and asset MIME coverage are
 * sketched but need on-device validation. See SPIKE.md.
 */
class EvilLiteWebViewClient(bridge: Bridge) : BridgeWebViewClient(bridge) {

    private val classRegex = Regex("""\bclass\s+([A-Za-z0-9_]+)""")

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        val host = url.host ?: return null
        if (host != "evilquest.net") return null
        val path = url.path ?: return null

        // 1. EvilLite's own renderer files, served from bundled assets.
        if (path.startsWith("/__evillite__/")) {
            val asset = "public/" + path.removePrefix("/__evillite__/")
            return try {
                val stream = view.context.assets.open(asset)
                WebResourceResponse(mimeOf(asset), "UTF-8", stream).withCors()
            } catch (e: Exception) {
                WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(),
                    ByteArrayInputStream("EvilLite asset not found: $asset".toByteArray()))
            }
        }

        // 2. Game JS: fetch the real file, append the class-exposure shim, return rewritten.
        if (path.endsWith(".js")) {
            return try { rewriteGameJs(url.toString()) } catch (e: Exception) { null }
        }

        // Everything else: let the WebView handle it normally.
        return null
    }

    private fun rewriteGameJs(fullUrl: String): WebResourceResponse {
        val conn = (URL(fullUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            instanceFollowRedirects = true
            CookieManager.getInstance().getCookie(fullUrl)?.let { setRequestProperty("Cookie", it) }
            setRequestProperty("Referer", "https://evilquest.net/")
        }
        val body = conn.inputStream.bufferedReader().use { it.readText() }

        // Same shim the Electron handler injects (see windows/client/index.ts).
        val sb = StringBuilder(body)
        sb.append("\nif (!document.client) document.client = new Map();\n")
        for (m in classRegex.findAll(body)) {
            val cls = m.groupValues[1]
            sb.append("try { document.client.set('$cls', $cls); } catch(e){}\n")
        }
        sb.append("if (!window.__eqSourceCode) window.__eqSourceCode = \"\";\n")
        sb.append("window.__eqSourceCode += ").append(jsString(body + "\n")).append(";\n")
        sb.append("if (!window.__eqSourceModules) window.__eqSourceModules = [];\n")
        sb.append("window.__eqSourceModules.push(").append(jsString(body + "\n")).append(");\n")
        sb.append("if (window.onEqModuleLoaded) window.onEqModuleLoaded();\n")

        // no-store: the Reflector must re-run the shim on every module load.
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Cache-Control" to "no-store, must-revalidate"
        )
        return WebResourceResponse(
            "application/javascript", "UTF-8", 200, "OK", headers,
            ByteArrayInputStream(sb.toString().toByteArray(Charsets.UTF_8))
        )
    }

    private fun WebResourceResponse.withCors(): WebResourceResponse {
        responseHeaders = (responseHeaders ?: emptyMap()).toMutableMap().apply {
            put("Access-Control-Allow-Origin", "*")
        }
        return this
    }

    private fun mimeOf(p: String): String = when {
        p.endsWith(".html") -> "text/html"
        p.endsWith(".js") -> "application/javascript"
        p.endsWith(".css") -> "text/css"
        p.endsWith(".json") -> "application/json"
        p.endsWith(".png") -> "image/png"
        p.endsWith(".ico") -> "image/x-icon"
        p.endsWith(".woff2") -> "font/woff2"
        p.endsWith(".woff") -> "font/woff"
        p.endsWith(".ttf") -> "font/ttf"
        p.endsWith(".webm") -> "video/webm"
        else -> "application/octet-stream"
    }

    /** Minimal JSON-string encode (matches JSON.stringify for embedding source as a JS literal). */
    private fun jsString(s: String): String {
        val out = StringBuilder("\"")
        for (c in s) when (c) {
            '\\' -> out.append("\\\\")
            '"' -> out.append("\\\"")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            else -> when (c.code) {
                // JS line/paragraph separators are valid in strings but break some parsers.
                0x2028 -> out.append("\\u2028")
                0x2029 -> out.append("\\u2029")
                in 0..0x1f -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        return out.append("\"").toString()
    }
}
