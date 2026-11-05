// TLS inside a Parallax Relay stream (0068, 0091), as ios/RelayBridge.swift does: a loopback port
// whose every TCP connection is carried to plxd by a relay stream of its own. The module's client
// then reaches the host at `https://127.0.0.1:<port>`, pinned to its key as on any route, so the
// relay, which passes only these bytes, carries only TLS records. plxd answers one request per
// connection, as `plxd dial` sends them, so a stream per connection is a stream per request.
//
// Any app on an Android phone can connect to a loopback port, so each connection must open with
// this bridge's random `secret`, which only this app's client sends (Pinning.client). A connection
// without it opens no stream, so another app can't spend the user's sign-in on one.
//
// A stream opens with the Clerk token in the `Authorization` header (0091). A relay from before
// 0091 refuses that with 401, 404, or 426, before any stream opens, and takes only a ticket: then,
// as `plxd dial` does, the stream asks for one (`POST /v1/hosts/<id>/tickets`) and opens
// `/connect?ticket=<ticket>`. Nothing falls back once a stream opened, or on any other refusal.
//
// The stream's own connection to the relay uses the system's trust, as the Swift does: it reaches
// Parallax Relay, not the host, and the host's pinned TLS runs inside it.
package dev.parallax.pinnedtls

import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject

class RelayBridge(url: String, private val token: String) {
  private val listener = ServerSocket(0, 50, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))

  /** The relay's `/v1/hosts/<id>/connect`, over HTTP(S) as OkHttp's URLs are. */
  private val connect = url.replaceFirst("ws", "http").toHttpUrl()

  /** The relay's `/v1/hosts/<id>/tickets`, for a relay from before 0091. */
  private val tickets = connect.newBuilder()
    .encodedPath(connect.encodedPath.replace("/connect", "/tickets"))
    .build()
  private val client = OkHttpClient.Builder().readTimeout(STREAM_TIMEOUT_S, TimeUnit.SECONDS).build()
  private val pipes = ConcurrentHashMap.newKeySet<Pipe>()

  val port: Int get() = listener.localPort

  /** What each connection to `port` opens with. */
  val secret = ByteArray(SECRET_BYTES).also { SecureRandom().nextBytes(it) }

  /** The relay's HTTP status when it last refused a stream, such as 503 while the host is offline. */
  @Volatile var refused: Int? = null
    private set

  /** Starts taking connections on `port`, until `close`. */
  fun start() {
    thread(isDaemon = true, name = "parallax-relay-accept") {
      try {
        while (true) {
          val connection = listener.accept()
          thread(isDaemon = true, name = "parallax-relay-open") { admit(connection) }
        }
      } catch (_: IOException) {
        // `close` closed the listener.
      }
    }
  }

  /** Stops listening and ends every stream. */
  fun close() {
    listener.close()
    pipes.forEach { it.end() }
    pipes.clear()
    client.dispatcher.cancelAll()
    release(client)
  }

  /** Carries `connection` over a stream once it proved it's this app. */
  private fun admit(connection: Socket) {
    val proved = try {
      connection.soTimeout = SECRET_TIMEOUT_MS
      MessageDigest.isEqual(readExactly(connection.getInputStream(), SECRET_BYTES), secret)
    } catch (_: IOException) {
      false
    }
    if (!proved) return closeQuietly(connection)
    connection.soTimeout = 0
    accept(connection)
  }

  /**
   * Carries `connection` over a stream opened with the header token, or with a ticket when the
   * relay takes only tickets. Until the stream opens nothing more is read, so the TLS handshake
   * waits in the socket.
   */
  private fun accept(connection: Socket) {
    val request = Request.Builder().url(connect).header("Authorization", "Bearer $token").build()
    open(connection, request) { status ->
      if (status in TICKET_ONLY) viaTicket(connection) else refuse(connection, status)
    }
  }

  /**
   * Opens a stream with `request` for `connection` and, once the relay says plxd joined it
   * (`ready`), passes bytes both ways. A refusal before then goes to `refused`, with its status.
   */
  private fun open(connection: Socket, request: Request, refused: (Int?) -> Unit) {
    client.newWebSocket(request, Pipe(connection, refused))
  }

  /** A relay from before 0091: a one-time ticket for the stream, then the stream with it. */
  private fun viaTicket(connection: Socket) {
    val post = Request.Builder()
      .url(tickets)
      .header("Authorization", "Bearer $token")
      .post(ByteArray(0).toRequestBody())
      .build()
    client.newCall(post).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) = refuse(connection, null)

      override fun onResponse(call: Call, response: Response) {
        val ticket = response.use {
          if (it.code != 200) return refuse(connection, it.code)
          try {
            JSONObject(it.body?.string().orEmpty()).optString("ticket")
          } catch (_: Exception) {
            ""
          }
        }
        if (ticket.isEmpty()) return refuse(connection, 200)
        val url = connect.newBuilder().addQueryParameter("ticket", ticket).build()
        open(connection, Request.Builder().url(url).build()) { status -> refuse(connection, status) }
      }
    })
  }

  /** Records why the relay refused `connection`'s stream, then closes the connection. */
  private fun refuse(connection: Socket, status: Int?) {
    refused = status
    closeQuietly(connection)
  }

  /**
   * One TCP connection and its relay stream: each read becomes a binary frame, and each binary
   * frame is written back. Before `ready`, whatever ends the stream is a refusal.
   */
  private inner class Pipe(
    private val tcp: Socket,
    private val onRefused: (Int?) -> Unit,
  ) : WebSocketListener() {
    @Volatile private var socket: WebSocket? = null
    @Volatile private var joined = false
    private val over = AtomicBoolean(false)

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (joined) return
      if (text != "ready") return stopBeforeReady(webSocket, null)
      joined = true
      socket = webSocket
      pipes.add(this)
      thread(isDaemon = true, name = "parallax-relay-up") { upstream(webSocket) }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (!joined) return stopBeforeReady(webSocket, null)
      try {
        tcp.getOutputStream().write(bytes.toByteArray())
        tcp.getOutputStream().flush()
      } catch (_: IOException) {
        end()
      }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      if (joined) end() else stopBeforeReady(webSocket, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (joined) end() else stopBeforeReady(webSocket, null)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (joined) end() else stopBeforeReady(webSocket, response?.code)
    }

    /** Ends a stream that never joined, and reports its refusal, once. */
    private fun stopBeforeReady(webSocket: WebSocket, status: Int?) {
      if (!over.compareAndSet(false, true)) return
      webSocket.cancel()
      onRefused(status)
    }

    /** Sends each read as a frame, holding back while the socket's queue is long. */
    private fun upstream(webSocket: WebSocket) {
      val buffer = ByteArray(READ_BYTES)
      try {
        val input = tcp.getInputStream()
        while (true) {
          val read = input.read(buffer)
          if (read < 0 || !webSocket.send(buffer.toByteString(0, read))) break
          while (webSocket.queueSize() > QUEUE_BYTES && !over.get()) Thread.sleep(QUEUE_WAIT_MS)
        }
      } catch (_: IOException) {
      } catch (_: InterruptedException) {
      }
      end()
    }

    fun end() {
      if (!over.compareAndSet(false, true)) return
      pipes.remove(this)
      closeQuietly(tcp)
      socket?.close(NORMAL_CLOSURE, null)
    }
  }

  private companion object {
    /** The refusals of a header token that mean the relay takes only tickets. */
    val TICKET_ONLY = setOf(401, 404, 426)
    const val SECRET_BYTES = 32
    const val SECRET_TIMEOUT_MS = 5_000
    const val STREAM_TIMEOUT_S = 30L
    const val READ_BYTES = 64 shl 10
    /** OkHttp fails a send past 16 MiB queued, so reads wait well before that. */
    const val QUEUE_BYTES = 1L shl 20
    const val QUEUE_WAIT_MS = 5L
    const val NORMAL_CLOSURE = 1000

    fun readExactly(input: InputStream, count: Int): ByteArray {
      val bytes = ByteArray(count)
      var filled = 0
      while (filled < count) {
        val read = input.read(bytes, filled, count - filled)
        if (read < 0) throw IOException("The connection ended.")
        filled += read
      }
      return bytes
    }

    fun closeQuietly(socket: Socket) {
      try {
        socket.close()
      } catch (_: IOException) {
      }
    }
  }
}
