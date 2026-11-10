// TLS inside a relay stream, as test/relay.mjs checks the Swift: requests through RelayBridge with
// Pinning, against a local relay that speaks the real relay's client protocol, joining each stream
// to a plxd stand-in. It also checks that the relay saw only TLS records.
package dev.parallax.pinnedtls

import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

private const val TOKEN = "clerk-test-token"

class RelayBridgeTest {
  private lateinit var relay: MockWebServer
  private lateinit var host: TestHost
  private lateinit var old: TestHost
  private val streams = AtomicInteger()
  private val ticketsIssued = AtomicInteger()
  private val offlineTicketAsks = AtomicInteger()
  private val issued = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
  private val firstBytes = CopyOnWriteArrayList<Byte>()
  private val bridges = mutableListOf<RelayBridge>()

  /** Host `idle`'s streams, which reach no host and stay open until a test closes them. */
  private val idleStreams = CopyOnWriteArrayList<WebSocket>()
  private val idleBytes = AtomicInteger()

  /**
   * A stream that says `ready`, counts what it's sent, and closes only when a test or the bridge
   * closes it. It answers the bridge's close as the relay does: until it does, MockWebServer's task
   * for the stream waits, and `shutdown` gives up on it.
   */
  private val idle = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      idleStreams.add(webSocket)
      webSocket.send("ready")
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      idleBytes.addAndGet(bytes.size)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }
  }

  /** Joins the stream to the host on `port` and passes bytes both ways, after saying `ready`. */
  private fun join(port: Int) = object : WebSocketListener() {
    private lateinit var plxd: Socket
    private var first = true

    override fun onOpen(webSocket: WebSocket, response: Response) {
      streams.incrementAndGet()
      plxd = Socket("127.0.0.1", port)
      kotlin.concurrent.thread(isDaemon = true) {
        val buffer = ByteArray(4096)
        try {
          while (true) {
            val read = plxd.getInputStream().read(buffer)
            if (read < 0) break
            webSocket.send(buffer.toByteString(0, read))
          }
        } catch (_: java.io.IOException) {
        }
        webSocket.close(1000, null)
      }
      webSocket.send("ready")
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      if (first) firstBytes.add(bytes[0])
      first = false
      plxd.getOutputStream().write(bytes.toByteArray())
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      plxd.close()
      webSocket.close(1000, null)
    }
  }

  private fun refuse(status: Int) = MockResponse().setResponseCode(status)

  /**
   * The relay: checks the path and the token in the header, then joins the stream to the host.
   * Under `/old` it is a relay from before 0091, which refuses the header with 401 and opens a
   * stream only with a one-time ticket from `POST …/tickets`. Host `offline` answers 503.
   */
  private val dispatcher = object : Dispatcher() {
    override fun dispatch(request: RecordedRequest): MockResponse {
      val url = request.requestUrl!!
      val isOld = url.encodedPath.startsWith("/old/")
      val parts = url.encodedPath.removePrefix("/old").split("/")
      val hostKey = parts.getOrNull(3)
      val action = parts.getOrNull(4)
      val auth = request.getHeader("Authorization")
      if (hostKey == "offline") {
        if (action == "tickets") offlineTicketAsks.incrementAndGet()
        return refuse(503)
      }
      if (hostKey == "idle") return MockResponse().withWebSocketUpgrade(idle)
      val port = when (hostKey) {
        Fixtures.HOST.id -> host.port
        "tls12" -> old.port
        else -> return refuse(404)
      }
      if (request.method == "POST" && action == "tickets") {
        if (!isOld || auth != "Bearer $TOKEN") return refuse(401)
        val fresh = "ticket-${ticketsIssued.incrementAndGet()}"
        issued.add(fresh)
        return MockResponse().setResponseCode(200).setBody("""{"ticket":"$fresh"}""")
      }
      if (isOld) {
        if (!issued.remove(url.queryParameter("ticket") ?: "")) return refuse(401)
      } else if (auth != "Bearer $TOKEN") {
        return refuse(401)
      }
      return MockResponse().withWebSocketUpgrade(join(port))
    }
  }

  @Before
  fun start() {
    host = TestHost()
    old = TestHost(tlsVersions = arrayOf("TLSv1.2"))
    relay = MockWebServer()
    relay.dispatcher = dispatcher
    relay.start()
  }

  @After
  fun stop() {
    bridges.forEach { it.close() }
    relay.shutdown()
    host.close()
    old.close()
  }

  private fun bridge(path: String, token: String = TOKEN): RelayBridge {
    val base = relay.url("/").toString().removeSuffix("/").replaceFirst("http", "ws")
    return RelayBridge("$base$path", token).also {
      it.start()
      bridges.add(it)
    }
  }

  private val connect = "/v1/hosts/${Fixtures.HOST.id}/connect"
  private val pin = "key:${Fixtures.HOST.id}"

  private fun get(through: RelayBridge, pin: String = this.pin) = pinnedGet(through.port, pin, through.secret)

  @Test
  fun eachRequestReachesHostPinnedOnItsOwnStreamAndRelaySeesOnlyTls() {
    val good = bridge(connect)
    for (attempt in 1..2) {
      val answer = get(good)
      assertEquals(200, answer.status)
      assertEquals(Fixtures.HOST.id, answer.body)
    }
    assertEquals(2, streams.get())
    host.awaitConnections(2)
    assertEquals(listOf("TLSv1.3", "TLSv1.3"), host.versions.toList())
    assertEquals(listOf<Byte>(0x16, 0x16), firstBytes.toList())
  }

  @Test
  fun anotherHostIdIsRefusedBeforeAnyCredentialCrossesTheStream() {
    val answer = get(bridge(connect), "key:${Fixtures.OTHER.id}")
    assertNull(answer.status)
    assertTrue(answer.refused)
    host.awaitConnections(1)
    assertEquals(0, host.bytes.size)
  }

  @Test
  fun hostOfferingOnlyTls12IsRefusedWhateverItsKey() {
    val answer = get(bridge("/v1/hosts/tls12/connect"))
    assertNull(answer.status)
    old.awaitConnections(1)
    assertEquals(0, old.bytes.size)
  }

  @Test
  fun connectionWithoutBridgeSecretOpensNoStream() {
    val good = bridge(connect)
    assertNull(pinnedGet(good.port, pin).status)
    assertNull(pinnedGet(good.port, pin, ByteArray(32)).status)
    assertEquals(0, streams.get())
    assertEquals(0, relay.requestCount)
    assertEquals(200, get(good).status)
  }

  @Test
  fun relayRefusalIsReported() {
    val refused = bridge(connect, token = "not-a-token")
    assertNull(get(refused).status)
    assertEquals(401, refused.refused)
  }

  @Test
  fun relayTakingOnlyTicketsGetsOnePerStream() {
    val ticketed = bridge("/old$connect")
    for (attempt in 1..2) assertEquals(200, get(ticketed).status)
    assertEquals(2, ticketsIssued.get())
    assertEquals(2, streams.get())
    assertTrue(issued.isEmpty())
  }

  @Test
  fun offlineHostIsReportedNotRetriedWithTicket() {
    val offline = bridge("/v1/hosts/offline/connect")
    assertNull(get(offline).status)
    assertEquals(503, offline.refused)
    assertEquals(0, offlineTicketAsks.get())
  }

  /** A connection through `through` whose stream has joined: the relay has had its first byte. */
  private fun joined(through: RelayBridge): Socket {
    val before = idleBytes.get()
    val tcp = Socket("127.0.0.1", through.port)
    tcp.soTimeout = 15_000
    tcp.getOutputStream().write(through.secret + byteArrayOf(1))
    val deadline = System.currentTimeMillis() + 15_000
    while (idleBytes.get() == before) {
      check(System.currentTimeMillis() < deadline) { "the stream never joined" }
      Thread.sleep(10)
    }
    return tcp
  }

  @Test
  fun relayCloseIsKeptForTheNewestStreamOnly() {
    val through = bridge("/v1/hosts/idle/connect")
    val older = joined(through)
    val newer = joined(through)

    // An older stream's close says nothing about the connection on the newer one.
    idleStreams[0].close(4409, "older")
    assertEquals(-1, older.getInputStream().read())
    assertNull(through.closedWith)

    // The newest stream's close is kept before its connection ends, for the connection log.
    idleStreams[1].close(4409, "replaced")
    assertEquals(-1, newer.getInputStream().read())
    assertEquals(mapOf("relay_code" to 4409, "relay_reason" to "replaced"), through.closedWith)

    // A newer stream starts clean.
    joined(through).close()
    assertNull(through.closedWith)
  }
}
