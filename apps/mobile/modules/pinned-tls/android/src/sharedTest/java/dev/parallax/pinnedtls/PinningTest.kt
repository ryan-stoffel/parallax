// The pin check: a wrong key is refused before any credential is sent, on the JVM and on an emulator.
package dev.parallax.pinnedtls

import java.util.concurrent.CountDownLatch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PinningTest {
  private fun assertNothingSent(host: TestHost) {
    host.awaitConnections(1)
    assertEquals("application bytes the server received", 0, host.bytes.size)
  }

  @Test
  fun thumbprintMatchesPlxdWithLeadingZeroCoordinate() {
    assertEquals(Fixtures.HOST.id, Pinning.keyId(Fixtures.certificate(Fixtures.HOST.cert)))
    assertEquals(Fixtures.OTHER.id, Pinning.keyId(Fixtures.certificate(Fixtures.OTHER.cert)))
  }

  @Test
  fun keyThatIsNotP256HasNoId() {
    assertNull(Pinning.keyId(Fixtures.certificate(Fixtures.P384_CERT)))
    assertNull(Pinning.keyId(Fixtures.certificate(Fixtures.RSA_CERT)))
  }

  @Test
  fun rightKeyConnectsAndCredentialArrivesOverTls13() {
    TestHost().use { host ->
      val answer = pinnedGet(host.port, "key:${Fixtures.HOST.id}")
      assertEquals(200, answer.status)
      assertEquals(Fixtures.HOST.id, answer.body)
      assertEquals(Fixtures.HOST.fingerprint, answer.seen)
      host.awaitConnections(1)
      assertTrue(String(host.bytes).contains(CREDENTIAL))
      assertEquals(listOf("TLSv1.3"), host.versions.toList())
    }
  }

  @Test
  fun wrongKeyIsRefusedBeforeAnyCredentialIsSent() {
    TestHost(Fixtures.OTHER).use { host ->
      val answer = pinnedGet(host.port, "key:${Fixtures.HOST.id}")
      assertNull(answer.status)
      assertTrue(answer.refused)
      assertNothingSent(host)
    }
  }

  @Test
  fun keyPinIsNotMetByCertificateFingerprint() {
    TestHost().use { host ->
      val answer = pinnedGet(host.port, "key:${Fixtures.HOST.fingerprint}")
      assertNull(answer.status)
      assertTrue(answer.refused)
      assertNothingSent(host)
    }
  }

  @Test
  fun rightKeyOverTls12IsRefusedBeforeAnyCredentialIsSent() {
    TestHost(tlsVersions = arrayOf("TLSv1.2")).use { host ->
      val answer = pinnedGet(host.port, "key:${Fixtures.HOST.id}")
      assertNull(answer.status)
      assertNothingSent(host)
    }
  }

  @Test
  fun pairedFingerprintConnectsOverTls12Too() {
    TestHost(tlsVersions = arrayOf("TLSv1.2", "TLSv1.3")).use { host ->
      assertEquals(200, pinnedGet(host.port, Fixtures.HOST.fingerprint).status)
    }
    TestHost(tlsVersions = arrayOf("TLSv1.2")).use { host ->
      assertEquals(200, pinnedGet(host.port, Fixtures.HOST.fingerprint).status)
      assertEquals(listOf("TLSv1.2"), host.versions.toList())
    }
  }

  @Test
  fun anotherFingerprintIsRefusedBeforeAnyCredentialIsSent() {
    TestHost(Fixtures.OTHER).use { host ->
      val answer = pinnedGet(host.port, Fixtures.HOST.fingerprint)
      assertNull(answer.status)
      assertTrue(answer.refused)
      assertNothingSent(host)
    }
  }

  @Test
  fun noPinAsPairingFirstRequestRecordsCertificate() {
    TestHost(Fixtures.OTHER).use { host ->
      val answer = pinnedGet(host.port, null)
      assertEquals(200, answer.status)
      assertFalse(answer.refused)
      assertEquals(Fixtures.OTHER.fingerprint, answer.seen)
    }
  }

  @Test
  fun redirectIsNotFollowed() {
    TestHost(Fixtures.OTHER).use { elsewhere ->
      val redirect = "HTTP/1.1 302 Found\r\nLocation: https://127.0.0.1:${elsewhere.port}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      TestHost(answer = redirect).use { host ->
        assertEquals(302, pinnedGet(host.port, "key:${Fixtures.HOST.id}").status)
      }
      assertEquals(0, elsewhere.bytes.size)
    }
  }

  @Test
  fun webSocketToWrongKeyFailsBeforeItsUpgradeIsSent() {
    TestHost(Fixtures.OTHER).use { host ->
      val pinning = Pinning("key:${Fixtures.HOST.id}")
      val client = pinning.client(10.0)
      val failed = CountDownLatch(1)
      val request = Request.Builder()
        .url("wss://127.0.0.1:${host.port}/ws")
        .header("Authorization", CREDENTIAL)
        .build()
      client.newWebSocket(request, object : WebSocketListener() {
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = failed.countDown()
      })
      assertTrue(failed.finished())
      assertTrue(pinning.refused)
      assertNothingSent(host)
      release(client)
    }
  }
}
