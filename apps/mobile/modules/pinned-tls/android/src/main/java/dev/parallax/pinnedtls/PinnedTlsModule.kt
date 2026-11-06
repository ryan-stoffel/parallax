// The Android side of index.ts, as ios/PinnedTlsModule.swift is the iOS side: HTTPS requests and a
// WebSocket to plxd's remote listener (0065), whose certificate is its own self-signed one, trusted
// only when its SHA-256 matches the fingerprint pairing pinned, or, for an account's host, when its
// key is the host id (0091, Pinning.kt). React Native's fetch and WebSocket can't pin a certificate,
// so the app reaches plxd through this, directly or through a Parallax Relay stream (RelayBridge.kt).
// It also finds hosts over mDNS, signs in to the Parallax account in a Custom Tab, reports network
// changes, opens a file in another app, and supplies secure random bytes, a backup-free file
// location, and the build's version. Android has no equal of iOS's background grace period to ask
// for, so an app in the background keeps its connections until the system stops it.
package dev.parallax.pinnedtls

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.MimeTypeMap
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.URI
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/** How long a pinned WebSocket waits to connect and to upgrade, seconds, as URLSession does. */
private const val SOCKET_TIMEOUT_S = 60.0

/** How long after the app comes back a sign-in with no callback counts as cancelled. */
private const val AUTH_CANCEL_MS = 1_000L

private const val CALLBACK_SCHEME = "parallax"
private const val BACKUP_FREE_FOLDER = "Parallax"
private const val SERVICE_TYPE = "_parallax._tcp."

class PinnedTlsModule : Module() {
  private class OpenSocket(val socket: WebSocket, val client: OkHttpClient)

  private val sockets = ConcurrentHashMap<String, OpenSocket>()

  /** The relay bridges open, by the id the app gave each. */
  private val bridges = ConcurrentHashMap<String, RelayBridge>()
  private val main = Handler(Looper.getMainLooper())

  /** The sign-in under way. Only the main thread touches it. */
  private var auth: Promise? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("PinnedTls")
    Events("onSocket", "onNetwork")

    /** `count` bytes from the system's secure random generator, for `crypto.getRandomValues`. */
    Function("randomBytes") { count: Int ->
      ByteArray(count).also { SecureRandom().nextBytes(it) }
    }

    /**
     * The URL of file `name` in a folder of the app's files: the outbox's, whose messages belong to
     * this phone's pairing. `android:allowBackup` is off in app.json, so no cloud backup holds it.
     * expo-file-system can create a file here, as it can't in `noBackupFilesDir`.
     */
    Function("privateFile") { name: String ->
      val folder = File(context.filesDir, BACKUP_FREE_FOLDER)
      folder.mkdirs()
      Uri.fromFile(File(folder, name)).toString()
    }

    /**
     * The computers advertising `_parallax._tcp` while they show a pairing code (0065), found in
     * `seconds`: each one's name and its IPv4 address with port.
     */
    AsyncFunction("discover") { seconds: Double, promise: Promise -> discover(seconds, promise) }

    /**
     * One request: its status, its body as text, and the fingerprint of the certificate reached. It
     * gives up after `timeout` seconds without a byte.
     */
    AsyncFunction("request") {
      url: String, method: String, headers: Map<String, String>, body: String?, pin: String?,
      timeout: Double, promise: Promise ->
      val pinning = Pinning(pin)
      val client = pinning.client(timeout, preambleFor(url))
      val call = try {
        client.newCall(requestOf(url, method, headers, body))
      } catch (e: IllegalArgumentException) {
        release(client)
        return@AsyncFunction promise.reject("ERR_URL", "not a URL: $url", e)
      }
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          release(client)
          promise.reject(if (pinning.refused) "ERR_WRONG_HOST" else "ERR_NETWORK", e.message, e)
        }

        override fun onResponse(call: Call, response: Response) {
          try {
            val text = response.use { it.body?.string().orEmpty() }
            promise.resolve(
              mapOf("status" to response.code, "body" to text, "fingerprint" to pinning.seen),
            )
          } catch (e: IOException) {
            promise.reject("ERR_NETWORK", e.message, e)
          } finally {
            release(client)
          }
        }
      })
    }

    /**
     * Opens WebSocket `id` with `headers` on its upgrade, which reports `open`, each `message`, and
     * one `close` as `onSocket`, the close with the upgrade's HTTP status when it was refused.
     */
    Function("open") { id: String, url: String, pin: String, headers: Map<String, String> ->
      val client = Pinning(pin).client(SOCKET_TIMEOUT_S, preambleFor(url))
      val request = try {
        requestOf(url, "GET", headers, null)
      } catch (_: IllegalArgumentException) {
        release(client)
        return@Function
      }
      // plxd's frames carry whole snapshots. OkHttp has no limit on a message it receives. The
      // lock keeps `closed` from running before the socket is in `sockets`.
      synchronized(sockets) {
        sockets[id] = OpenSocket(client.newWebSocket(request, SocketEvents(id)), client)
      }
      Unit
    }

    /**
     * Opens relay bridge `id` (RelayBridge.kt): a loopback port each of whose connections is a
     * stream to a host through the relay's `url` (`wss://…/v1/hosts/<id>/connect`), opened with the
     * Clerk `token`. Resolves to the port.
     */
    AsyncFunction("relayOpen") { id: String, url: String, token: String, promise: Promise ->
      try {
        val bridge = RelayBridge(url, token)
        bridges[id] = bridge
        bridge.start()
        promise.resolve(bridge.port)
      } catch (e: Exception) {
        promise.reject("ERR_NETWORK", "Couldn't open a relay stream.", e)
      }
    }

    /**
     * The relay's HTTP status when it last refused one of bridge `id`'s streams, such as 503 while
     * the host is offline, or null.
     */
    Function("relayRefused") { id: String -> bridges[id]?.refused }

    /**
     * How the relay last closed one of bridge `id`'s streams, in the connection log's names, or null
     * if it sent no close frame.
     */
    Function("relayClosedWith") { id: String -> bridges[id]?.closedWith }

    /** Closes relay bridge `id` and every stream through it. */
    Function("relayClose") { id: String ->
      bridges.remove(id)?.close()
      Unit
    }

    /**
     * Signs in as the desktop app does (0067): Clerk's authorize URL `url` opens in a Custom Tab,
     * which shares the browser's cookies, and Clerk sends it back to `parallax://oauth/callback`,
     * which reaches `OnNewIntent`. Resolves to that callback URL, with its code and state, or
     * rejects with `ERR_CANCELED` when the tab is closed.
     */
    AsyncFunction("authorize") { url: String, promise: Promise ->
      auth?.reject("ERR_CANCELED", "Another sign-in started.", null)
      auth = null
      val activity = appContext.currentActivity
        ?: return@AsyncFunction promise.reject("ERR_CANCELED", "Sign-in couldn't open.", null)
      try {
        CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(url))
        auth = promise
      } catch (e: ActivityNotFoundException) {
        promise.reject("ERR_NO_BROWSER", "This phone has no browser to sign in with.", e)
      }
    }.runOnQueue(Queues.MAIN)

    OnNewIntent { intent ->
      val callback = intent.data
      if (callback?.scheme == CALLBACK_SCHEME && callback.host == "oauth") {
        main.post {
          auth?.resolve(callback.toString())
          auth = null
        }
      }
    }

    // Back in the app with no callback: the tab was closed. The callback, when there is one, comes
    // first or just after, so this waits a moment for it.
    OnActivityEntersForeground {
      val pending = auth ?: return@OnActivityEntersForeground
      main.postDelayed({
        if (auth === pending) {
          pending.reject("ERR_CANCELED", "Sign-in was cancelled.", null)
          auth = null
        }
      }, AUTH_CANCEL_MS)
    }

    /** Opens the file at `url` (`file://`) in an app that shows it, or else offers to send it. */
    AsyncFunction("preview") { url: String ->
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      val file = File(URI(url))
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.pinnedtls.files", file)
      val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
        ?: "application/octet-stream"
      val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, type)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try {
        activity.startActivity(view)
      } catch (_: ActivityNotFoundException) {
        val send = Intent(Intent.ACTION_SEND)
          .setType(type)
          .putExtra(Intent.EXTRA_STREAM, uri)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.startActivity(Intent.createChooser(send, file.name))
      }
    }.runOnQueue(Queues.MAIN)

    /** This build's version and build number. */
    Function("appVersion") {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      mapOf("version" to info.versionName.orEmpty(), "build" to info.longVersionCode.toString())
    }

    Function("send") { id: String, text: String ->
      val open = sockets[id] ?: return@Function
      if (!open.socket.send(text)) closed(id)
      Unit
    }

    Function("close") { id: String ->
      val open = sockets.remove(id) ?: return@Function
      open.socket.close(NORMAL_CLOSURE, null)
      release(open.client)
      Unit
    }

    // A network that comes back or changes, for the account's computers' discovery and route
    // re-checks (0091).
    OnCreate {
      val connectivity = context.getSystemService(ConnectivityManager::class.java)
      val callback = object : ConnectivityManager.NetworkCallback() {
        @Volatile private var last: Network? = connectivity.activeNetwork

        override fun onAvailable(network: Network) {
          val changed = network != last
          last = network
          if (changed) sendEvent("onNetwork", emptyMap<String, Any?>())
        }

        override fun onLost(network: Network) {
          if (network == last) last = null
        }
      }
      connectivity.registerDefaultNetworkCallback(callback)
      networkCallback = callback
    }

    OnDestroy {
      networkCallback?.let {
        context.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
      }
      networkCallback = null
      bridges.values.forEach { it.close() }
      bridges.clear()
    }
  }

  /** What a request to `url` must send first: a relay bridge's secret, when it's a bridge's port. */
  private fun preambleFor(url: String): ByteArray? {
    val port = try {
      URI(url).takeIf { it.host == "127.0.0.1" }?.port
    } catch (_: IllegalArgumentException) {
      null
    } catch (_: java.net.URISyntaxException) {
      null
    }
    return bridges.values.firstOrNull { it.port == port }?.secret
  }

  /** A request as `request` takes it. Throws `IllegalArgumentException` for a URL that isn't one. */
  private fun requestOf(
    url: String,
    method: String,
    headers: Map<String, String>,
    body: String?,
  ): Request {
    val builder = Request.Builder().url(url)
    headers.forEach { (name, value) -> builder.header(name, value) }
    val content = when {
      body != null -> body.toByteArray().toRequestBody("application/json".toMediaType())
      method in METHODS_WITH_BODY -> ByteArray(0).toRequestBody()
      else -> null
    }
    return builder.method(method, content).build()
  }

  /** Reports socket `id`'s `open`, `message`s, and `close` as `onSocket`. */
  private inner class SocketEvents(private val id: String) : WebSocketListener() {
    @Volatile private var open = false

    override fun onOpen(webSocket: WebSocket, response: Response) {
      open = true
      sendEvent("onSocket", mapOf("id" to id, "type" to "open"))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      sendEvent("onSocket", mapOf("id" to id, "type" to "message", "data" to text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      sendEvent("onSocket", mapOf("id" to id, "type" to "message", "data" to bytes.utf8()))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(NORMAL_CLOSURE, null)
      closed(id)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(id)

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      closed(id, if (open) null else response?.code)
    }
  }

  /**
   * Reports socket `id` closed, once, with the HTTP `status` that refused its upgrade if one did,
   * and lets its client go.
   */
  private fun closed(id: String, status: Int? = null) {
    val open = synchronized(sockets) { sockets.remove(id) } ?: return
    open.socket.cancel()
    release(open.client)
    val event = mutableMapOf<String, Any?>("id" to id, "type" to "close")
    if (status != null) event["status"] = status
    sendEvent("onSocket", event)
  }

  /**
   * Browses for `seconds`, resolving what it finds one at a time, as `NsdManager` allowed only one
   * resolve at a time before Android 14, then resolves `promise` with the routes found.
   */
  private fun discover(seconds: Double, promise: Promise) {
    val nsd = context.getSystemService(NsdManager::class.java)
    val found = ConcurrentHashMap<String, String>()
    val waiting = ArrayDeque<NsdServiceInfo>()
    var resolving = false

    fun next() {
      val service = synchronized(waiting) {
        if (resolving) return
        waiting.removeFirstOrNull()?.also { resolving = true }
      } ?: return
      @Suppress("DEPRECATION")
      nsd.resolveService(service, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
          synchronized(waiting) { resolving = false }
          next()
        }

        override fun onServiceResolved(info: NsdServiceInfo) {
          ipv4Route(info)?.let { found[info.serviceName] = it }
          synchronized(waiting) { resolving = false }
          next()
        }
      })
    }

    val browser = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}

      override fun onDiscoveryStopped(serviceType: String) {}

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}

      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

      override fun onServiceFound(service: NsdServiceInfo) {
        synchronized(waiting) { waiting.addLast(service) }
        next()
      }

      override fun onServiceLost(service: NsdServiceInfo) {}
    }
    nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, browser)
    main.postDelayed({
      // Throws when discovery never started, as with no network.
      runCatching { nsd.stopServiceDiscovery(browser) }
      promise.resolve(found.map { (name, route) -> mapOf("name" to name, "route" to route) })
    }, (seconds * 1000).toLong())
  }

  /** A resolved service's IPv4 address and port, loopback last, as plxd's own discovery sorts. */
  private fun ipv4Route(info: NsdServiceInfo): String? {
    val addresses: List<InetAddress> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      info.hostAddresses
    } else {
      @Suppress("DEPRECATION")
      listOfNotNull(info.host)
    }
    val ips = addresses.filterIsInstance<Inet4Address>()
    val ip = ips.firstOrNull { !it.isLoopbackAddress } ?: ips.firstOrNull() ?: return null
    return "${ip.hostAddress}:${info.port}"
  }

  private companion object {
    const val NORMAL_CLOSURE = 1000
    val METHODS_WITH_BODY = setOf("POST", "PUT", "PATCH")
  }
}
