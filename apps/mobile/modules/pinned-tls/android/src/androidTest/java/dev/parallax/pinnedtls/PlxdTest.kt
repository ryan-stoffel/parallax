// pinned-tls against a real plxd from the emulator, over the LAN and through a real relay under
// `wrangler dev`. apps/mobile/e2e/android.mjs starts them and passes where they are as
// instrumentation arguments. Without them, as in a bare `connectedDebugAndroidTest`, these skip.
package dev.parallax.pinnedtls

import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/** The emulator's name for the machine running it. */
private const val RUNNER = "10.0.2.2"

class PlxdTest {
  private val arguments = InstrumentationRegistry.getArguments()
  private val hostId = arguments.getString("hostId").orEmpty()
  private val lanPort = arguments.getString("lanPort").orEmpty().toIntOrNull() ?: 0
  private var bridge: RelayBridge? = null

  @Before
  fun needsPlxd() = assumeTrue(hostId.isNotEmpty())

  @After
  fun closeBridge() {
    bridge?.close()
  }

  /** A bridge through the relay to the host. */
  private fun bridged(): RelayBridge {
    val relay = arguments.getString("relayUrl")!!
    val token = arguments.getString("relayToken")!!
    return RelayBridge("$relay/v1/hosts/$hostId/connect", token).also {
      it.start()
      bridge = it
    }
  }

  @Test
  fun lanRouteAnswersWithTheHostsKey() {
    val answer = pinnedGet(lanPort, "key:$hostId", host = RUNNER)
    assertEquals(200, answer.status)
    assertTrue(answer.body, answer.body.contains("routes"))
  }

  @Test
  fun lanRouteRefusesAnotherHostId() {
    val answer = pinnedGet(lanPort, "key:${Fixtures.OTHER.id}", host = RUNNER)
    assertNull(answer.status)
    assertTrue(answer.refused)
  }

  @Test
  fun relayRouteAnswersWithTheHostsKey() {
    val through = bridged()
    val answer = pinnedGet(through.port, "key:$hostId", through.secret)
    assertEquals(answer.body, 200, answer.status)
    assertTrue(answer.body, answer.body.contains("relay:$hostId"))
  }

  @Test
  fun relayRouteRefusesAnotherHostId() {
    val through = bridged()
    val answer = pinnedGet(through.port, "key:${Fixtures.OTHER.id}", through.secret)
    assertNull(answer.status)
    assertTrue(answer.refused)
  }

  @Test
  fun webSocketThroughTheRelayReachesPlxdWhichWantsASession() {
    val through = bridged()
    val pinning = Pinning("key:$hostId")
    val client = pinning.client(30.0, through.secret)
    val ended = CountDownLatch(1)
    var status: Int? = null
    val request = Request.Builder().url("wss://127.0.0.1:${through.port}/ws").build()
    client.newWebSocket(request, object : WebSocketListener() {
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        status = response?.code
        ended.countDown()
      }
    })
    assertTrue(ended.finished())
    assertEquals(401, status)
    release(client)
  }
}
