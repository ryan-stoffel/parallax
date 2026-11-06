// How the app trusts plxd's self-signed certificate (0065, 0091), as ios/Pinning.swift does, apart
// from Expo so the tests in src/sharedTest run it on the JVM and on an emulator alike.
package dev.parallax.pinnedtls

import java.math.BigInteger
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECParameterSpec
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.TlsVersion

/**
 * Accepts the server's certificate only when `pin` allows it: `key:<hostId>` when the RFC 7638 JWK
 * thumbprint of its P-256 key is that host id (an `account:` host, 0091), or else when its SHA-256
 * is `pin` (a paired host, 0065). With no pin, as pairing's first request has, it accepts any.
 * Either way it records the certificate's SHA-256, which SPAKE2 vouches for.
 *
 * This check is the only trust there is: no system trust store is consulted. TLS checks the
 * handshake's signature with the same certificate's key, so it's the key the host proved it holds,
 * and no request byte is written until the handshake has finished.
 */
class Pinning(val pin: String?) : X509TrustManager {
  @Volatile var seen = ""
    private set

  /** The pin refused the certificate the server presented. */
  @Volatile var refused = false
    private set

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("The server sent no certificate.")
    seen = hex(sha256(leaf.encoded))
    val allowed = when {
      pin == null -> true
      pin.startsWith(KEY_PREFIX) -> keyId(leaf) == pin.removePrefix(KEY_PREFIX)
      else -> pin == seen
    }
    if (!allowed) {
      refused = true
      throw CertificateException("Another computer answered.")
    }
  }

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("This client takes no client certificates.")
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

  /**
   * A client for one connection, trusting only this pin. An `account:` host's connection takes TLS
   * 1.3 only, and a pinned client never speaks plain HTTP or follows a redirect, which could carry
   * the `DPoP` header elsewhere. Its own `SSLContext` keeps its own TLS sessions, so a resumed
   * session can't skip the check. `preamble` is sent first, as a relay bridge's port asks.
   */
  fun client(timeoutSeconds: Double, preamble: ByteArray? = null): OkHttpClient {
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(this), null)
    val tls = ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
    if (pin?.startsWith(KEY_PREFIX) == true) tls.tlsVersions(TlsVersion.TLS_1_3)
    val timeout = (timeoutSeconds * 1000).toLong()
    val builder = OkHttpClient.Builder()
      .sslSocketFactory(context.socketFactory, this)
      // The pin stands in for the name: plxd's certificate names no address it's reached at.
      .hostnameVerifier { _, _ -> true }
      .connectionSpecs(listOf(tls.build()))
      .protocols(listOf(Protocol.HTTP_1_1))
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .connectTimeout(timeout, TimeUnit.MILLISECONDS)
      .readTimeout(timeout, TimeUnit.MILLISECONDS)
      .writeTimeout(timeout, TimeUnit.MILLISECONDS)
    if (preamble != null) builder.socketFactory(PreambleSockets(preamble))
    return builder.build()
  }

  companion object {
    private const val KEY_PREFIX = "key:"

    /**
     * The JWK thumbprint (RFC 7638) of `certificate`'s P-256 key, which is a host's relay id, as
     * plxd's `remote::key_id` computes it. Null for any other key.
     */
    fun keyId(certificate: X509Certificate): String? {
      val key = certificate.publicKey as? ECPublicKey ?: return null
      if (!isP256(key.params)) return null
      val x = base64url(coordinate(key.w.affineX) ?: return null)
      val y = base64url(coordinate(key.w.affineY) ?: return null)
      return base64url(sha256("""{"crv":"P-256","kty":"EC","x":"$x","y":"$y"}""".toByteArray()))
    }

    /** `value` as exactly 32 big-endian bytes, as a point's coordinate is encoded. */
    private fun coordinate(value: BigInteger): ByteArray? {
      val bytes = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
      return if (bytes.size > 32) null else ByteArray(32 - bytes.size) + bytes
    }

    private fun isP256(params: ECParameterSpec): Boolean {
      val field = params.curve.field as? ECFieldFp ?: return false
      return field.p == P256_P && params.curve.a == P256_A && params.curve.b == P256_B &&
        params.order == P256_N && params.generator.affineX == P256_GX &&
        params.generator.affineY == P256_GY && params.cofactor == 1
    }

    private val P256_P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val P256_A = BigInteger("ffffffff00000001000000000000000000000000fffffffffffffffffffffffc", 16)
    private val P256_B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    private val P256_N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    private val P256_GX = BigInteger("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", 16)
    private val P256_GY = BigInteger("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", 16)
  }
}

/** Lets go of `client`'s threads and connections. */
fun release(client: OkHttpClient) {
  client.dispatcher.executorService.shutdown()
  client.connectionPool.evictAll()
}

/** Sockets that send `preamble` as soon as they connect, before the TLS handshake starts. */
private class PreambleSockets(private val preamble: ByteArray) : SocketFactory() {
  override fun createSocket(): Socket = object : Socket() {
    override fun connect(endpoint: SocketAddress?, timeout: Int) {
      super.connect(endpoint, timeout)
      getOutputStream().write(preamble)
      getOutputStream().flush()
    }
  }

  private fun refuse(): Nothing = throw UnsupportedOperationException("OkHttp connects these itself.")

  override fun createSocket(host: String?, port: Int): Socket = refuse()
  override fun createSocket(host: String?, port: Int, local: InetAddress?, localPort: Int): Socket = refuse()
  override fun createSocket(host: InetAddress?, port: Int): Socket = refuse()
  override fun createSocket(host: InetAddress?, port: Int, local: InetAddress?, localPort: Int): Socket = refuse()
}

fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
