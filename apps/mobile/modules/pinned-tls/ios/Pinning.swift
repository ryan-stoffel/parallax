// How the app trusts plxd's self-signed certificate (0065, 0091), apart from Expo so the native
// test (modules/pinned-tls/test) compiles it with the relay bridge alone.
import CryptoKit
import Foundation
import Security

/// Accepts the server's certificate only when `pin` allows it: `key:<hostId>` when the RFC 7638
/// JWK thumbprint of its P-256 key is that host id (an `account:` host, 0091), or else when its
/// SHA-256 is `pin` (a paired host, 0065). With no pin, as pairing's first request has, it
/// accepts any. Either way it records the certificate's SHA-256, which SPAKE2 vouches for.
final class Pinning: NSObject, URLSessionWebSocketDelegate {
  let pin: String?
  var seen = ""
  /// The pin refused the certificate the server presented.
  var refused = false
  var opened: (() -> Void)?
  /// With the HTTP status the server answered, when it answered.
  var closed: ((Int?) -> Void)?

  init(pin: String?) { self.pin = pin }

  /// A configuration for `pin`: an `account:` host's connection takes TLS 1.3 only.
  static func configuration(pin: String?) -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    if pin?.hasPrefix("key:") == true { configuration.tlsMinimumSupportedProtocolVersion = .TLSv13 }
    return configuration
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
    else { return completionHandler(.cancelAuthenticationChallenge, nil) }
    let der = SecCertificateCopyData(leaf) as Data
    seen = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    let allowed: Bool
    if let pin, pin.hasPrefix("key:") {
      allowed = Pinning.keyId(leaf) == String(pin.dropFirst(4))
    } else {
      allowed = pin == nil || pin == seen
    }
    if allowed {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      refused = true
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  /// plxd never redirects, and a redirect could carry the `DPoP` header elsewhere.
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }

  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol: String?
  ) { opened?() }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    closed?((task.response as? HTTPURLResponse)?.statusCode)
  }

  /// The JWK thumbprint (RFC 7638) of `certificate`'s P-256 key, which is a host's relay id, as
  /// plxd's `remote::key_id` computes it. Nil for any other key. TLS checks the handshake's
  /// signature with this same key, so it's the key the host proved it holds.
  static func keyId(_ certificate: SecCertificate) -> String? {
    guard let key = SecCertificateCopyKey(certificate),
      let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
      attributes[kSecAttrKeyType] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
      (attributes[kSecAttrKeySizeInBits] as? NSNumber)?.intValue == 256,
      let point = SecKeyCopyExternalRepresentation(key, nil) as Data?,
      point.count == 65, point.first == 4
    else { return nil }
    let x = base64url(point.subdata(in: 1..<33))
    let y = base64url(point.subdata(in: 33..<65))
    let jwk = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(x)\",\"y\":\"\(y)\"}"
    return base64url(Data(SHA256.hash(data: Data(jwk.utf8))))
  }
}

func base64url(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}
