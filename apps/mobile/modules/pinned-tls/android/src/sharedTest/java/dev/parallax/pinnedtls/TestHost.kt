// What the pinned-tls tests connect to: a plxd stand-in with throwaway keys and a request helper.
package dev.parallax.pinnedtls

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import kotlin.concurrent.thread
import okhttp3.Request

/** Throwaway keys made for these tests alone. `HOST`'s x coordinate starts with a zero byte. */
object Fixtures {
  class Identity(val cert: String, val key: String, val id: String, val fingerprint: String)

  val HOST = Identity(
    "MIIBFzCBvgIJAJSKnrF2Sn6TMAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCHBhcmFsbGF4MCAXDTI2MTEwNTA2NTU1N1oYDzIxMjYxMDEyMDY1NTU3WjATMREwDwYDVQQDDAhwYXJhbGxheDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABACOqoO5mZ/m5+x44nXYy8gFPy16rCw/wUl5JaBJ/l155v0pnM7wqrcIhChS38N6j7QNjYhFOMUj8pXshPapJkMwCgYIKoZIzj0EAwIDSAAwRQIhAI+zErlN1DKeKHx8jGPNvnDxX16eDC7a1WmE8UdKwgW3AiAHr//Eryz0xXBBEsPbR0/fg+MPSznOxAS9cBh4HLJUwA==",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGQsj8kE/dP+gpb5qWeayOzm0O0uO/Ly8qxmSG7pUUdmhRANCAAQAjqqDuZmf5ufseOJ12MvIBT8teqwsP8FJeSWgSf5deeb9KZzO8Kq3CIQoUt/Deo+0DY2IRTjFI/KV7IT2qSZD",
    "gdu7_WlLk8YnYx1zA0CXDl74PUSBDGFXn6ybwHRFlCk",
    "3d34d1944802e73586f6be4fcf3bc5b18959869f7931e1751274df4a2ba3311c",
  )
  val OTHER = Identity(
    "MIIBFjCBvgIJAIbO1WhtUk4XMAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCHBhcmFsbGF4MCAXDTI2MTEwNTA2NTU1N1oYDzIxMjYxMDEyMDY1NTU3WjATMREwDwYDVQQDDAhwYXJhbGxheDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABPWF6cbvTWwPakCQCZePPjbY6uTx3PU506V44BSbnFQZCX3KoM6aTlwE71/tiku2Kdr0pGMQd+R58ieGyTfBiHUwCgYIKoZIzj0EAwIDRwAwRAIgU1sIFrqrxuaP1P1d97NvT42EjcTWoEz+rU80S2UDt8ICIDkEAql9kfHbJj5a2LH0A3cpRo6aNAQTShoUrp6SdVr2",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGKbrLIPp3/UvhOqzesLkl4ZGhZSl2jNlzXrH5rYQbTGhRANCAAT1henG701sD2pAkAmXjz422Ork8dz1OdOleOAUm5xUGQl9yqDOmk5cBO9f7YpLtina9KRjEHfkefInhsk3wYh1",
    "RKoadv0LDzSs80_KjU7v83NYsLAk2Jkm2hWYAdgfADo",
    "bf07994cb7db4cd7f2a09d22813b1ca012088eb6a0f955662cd5b2bcb3889272",
  )
  const val P384_CERT = "MIIBUzCB2wIJAJUQ6jmcGGXXMAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCHBhcmFsbGF4MCAXDTI2MTEwNTA2NTU1N1oYDzIxMjYxMDEyMDY1NTU3WjATMREwDwYDVQQDDAhwYXJhbGxheDB2MBAGByqGSM49AgEGBSuBBAAiA2IABBJZ/jqRIr2qtrPkON3dhcrNPcZtgRzC3EouEweWdpP15UF+KC3iDQ3wlDA9b9c1sgnzhTSOzWGTJibvZ77Z9rb79d/8AGfp+viszPGn3JApILdRpYUB73ZF/2kG3QXP3DAKBggqhkjOPQQDAgNnADBkAjAu2nLoiT3D837Q/dGuLqKX4IcB0kZ9eRWTDESKERcF7yKRS0xh3FaBtTUYhFHDEbACMHIl5VFpy6+Lb+CaUBQTNhv/QUDulJiejigHUSlY0hu2l8PnTHxeToRbB6LeI9b+bg=="
  const val RSA_CERT = "MIICpDCCAYwCCQCK/WsoIWqbDjANBgkqhkiG9w0BAQsFADATMREwDwYDVQQDDAhwYXJhbGxheDAgFw0yNjExMDUwNjU1NTdaGA8yMTI2MTAxMjA2NTU1N1owEzERMA8GA1UEAwwIcGFyYWxsYXgwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDNdhg2EkXZBiR1mH41/kDIbaduHUXyA7pOrW6WaTx4razTfVvjHLxrWkvcQHjkrjgzCN6UD/F8Mf+/eNeY9rtjrlJxn5idt44zxvVkLQyK3ayt2otXR/e+/LTxvTkDp9orNN6d7MgkhliGUkNX0aH5aziA2/Bq8Y28Aruk8oEuztD+jQ0rHqZmf95I2HNeXHOoCJzs8c3RTiN6TEpYduzCq1uf7HWq57M41LOiYZ2KuoXRTScvgF1mc6ZiaYWMfZWAjThgjSaeyQL9k4EWGLqlWt4ebYdGxvGfx00A/HL0EgFvewGmR2cBThyg3z9T/o4VuOQUBHavbA7PnG7dHja9AgMBAAEwDQYJKoZIhvcNAQELBQADggEBACOlgz23VGG6XL501M5AppdIcZpNwvzLM3gLt5ZzQUOXDJPUSqdhmhm4GCKu7O+zg7xJDGV/GxUYiff8WEvCaHL6KvIli3NL/qmDaQxPYfYaukixqS+fhY16T2mX438Q9OpAcxtzstcjq2hju1HLOJzHSJixeBKe4Xrf9/J7L3IzqfXsBkHYQLln9fyVKFpA02idgspzalgoMz8dNrbwZuvUV6WCL/wyV9oefyMUYQ/4EnXHb7eOwePicVQ+GPzVk6dkPHjAc+nKMZmtG9x94MYbe/ri+aevB8BL7S4xArraMch1VwoyG5qkukDpijXPWLFfCJO3C/ZWmlPuOEgAoRQ="

  fun certificate(der: String): X509Certificate =
    CertificateFactory.getInstance("X.509")
      .generateCertificate(ByteArrayInputStream(Base64.getDecoder().decode(der))) as X509Certificate
}

/**
 * plxd's stand-in: TLS on a loopback port with `identity`, one request per connection, answered
 * with `body`. It keeps every application byte any client sent, so a test can say none arrived.
 */
class TestHost(
  identity: Fixtures.Identity = Fixtures.HOST,
  tlsVersions: Array<String> = arrayOf("TLSv1.3"),
  private val answer: String = ok(identity.id),
) : AutoCloseable {
  private val server: SSLServerSocket
  private val handled = AtomicInteger()
  private val received = ByteArrayOutputStream()
  val versions = CopyOnWriteArrayList<String>()
  val port: Int get() = server.localPort

  /** Every application byte received, from every connection. */
  val bytes: ByteArray get() = synchronized(received) { received.toByteArray() }

  init {
    val key = KeyFactory.getInstance("EC")
      .generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(identity.key)))
    val store = KeyStore.getInstance(KeyStore.getDefaultType())
    store.load(null, null)
    store.setKeyEntry("host", key, PASSWORD, arrayOf(Fixtures.certificate(identity.cert)))
    val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
    keys.init(store, PASSWORD)
    val context = SSLContext.getInstance("TLS")
    context.init(keys.keyManagers, null, null)
    server = context.serverSocketFactory
      .createServerSocket(0, 50, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) as SSLServerSocket
    server.enabledProtocols = tlsVersions
    thread(isDaemon = true, name = "test-host") {
      try {
        while (true) {
          val socket = server.accept() as SSLSocket
          thread(isDaemon = true, name = "test-host-connection") { serve(socket) }
        }
      } catch (_: IOException) {
        // `close` closed the server.
      }
    }
  }

  private fun serve(socket: SSLSocket) {
    socket.use {
      try {
        it.soTimeout = 10_000
        it.startHandshake()
        versions.add(it.session.protocol)
        val input = it.getInputStream()
        val seen = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (!seen.toString("ISO-8859-1").contains("\r\n\r\n")) {
          val read = input.read(buffer)
          if (read < 0) break
          seen.write(buffer, 0, read)
          synchronized(received) { received.write(buffer, 0, read) }
        }
        if (seen.size() > 0) {
          it.getOutputStream().write(answer.toByteArray())
          it.getOutputStream().flush()
        }
      } catch (_: IOException) {
        // A client that refused this host ends here, having sent nothing.
      }
    }
    handled.incrementAndGet()
  }

  /** Waits until `count` connections have ended, so a count of bytes is final. */
  fun awaitConnections(count: Int) {
    val deadline = System.currentTimeMillis() + 15_000
    while (handled.get() < count) {
      check(System.currentTimeMillis() < deadline) { "only ${handled.get()} of $count connections ended" }
      Thread.sleep(10)
    }
  }

  override fun close() = server.close()

  companion object {
    private val PASSWORD = "test".toCharArray()

    fun ok(body: String) =
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body"
  }
}

/** What one pinned request ended in: its status and body when it had an answer. */
class Answer(val status: Int?, val body: String, val refused: Boolean, val seen: String)

/** Stands for a phone's session credential: the tests look for it on the wire. */
const val CREDENTIAL = "DPoP credential-that-must-not-leak"

/** A pinned GET with the credential, as the app's `request` makes it. */
fun pinnedGet(port: Int, pin: String?, preamble: ByteArray? = null): Answer {
  val pinning = Pinning(pin)
  val client = pinning.client(10.0, preamble)
  val request = Request.Builder()
    .url("https://127.0.0.1:$port/.well-known/parallax")
    .header("Authorization", CREDENTIAL)
    .build()
  return try {
    client.newCall(request).execute().use {
      Answer(it.code, it.body?.string().orEmpty(), pinning.refused, pinning.seen)
    }
  } catch (_: IOException) {
    Answer(null, "", pinning.refused, pinning.seen)
  } finally {
    release(client)
  }
}

/** How long a test waits for something asynchronous. */
fun CountDownLatch.finished() = await(15, TimeUnit.SECONDS)
