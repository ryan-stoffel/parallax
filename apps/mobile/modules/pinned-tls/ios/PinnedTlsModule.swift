// HTTPS requests and a WebSocket to plxd's remote listener (0065), whose certificate is its own
// self-signed one: trusted only when its SHA-256 matches the fingerprint pairing pinned. React
// Native's fetch and WebSocket can't pin a certificate, so the app reaches plxd through this. It
// also finds hosts over mDNS, and supplies secure random bytes and a backup-free file location.
import CryptoKit
import ExpoModulesCore
import Foundation
import Network

/// Accepts the server's certificate only when its SHA-256 is `pin`. With no pin, as pairing's first
/// request has, it accepts any and records the fingerprint, which SPAKE2 then vouches for.
private final class Pinning: NSObject, URLSessionWebSocketDelegate {
  let pin: String?
  var seen = ""
  var opened: (() -> Void)?
  var closed: (() -> Void)?

  init(pin: String?) { self.pin = pin }

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
    if pin == nil || pin == seen {
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
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
    closed?()
  }
}

/// A Bonjour service's IPv4 address and port, once resolved, loopback last as plxd's own discovery
/// sorts them. Network's NWConnection would resolve it too, but only by connecting.
private final class Resolver: NSObject, NetServiceDelegate {
  var route: String?

  func netServiceDidResolveAddress(_ sender: NetService) {
    let ips = (sender.addresses ?? []).compactMap { data in
      data.withUnsafeBytes { raw -> String? in
        guard raw.load(as: sockaddr.self).sa_family == sa_family_t(AF_INET) else { return nil }
        var address = raw.load(as: sockaddr_in.self).sin_addr
        var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        inet_ntop(AF_INET, &address, &text, socklen_t(INET_ADDRSTRLEN))
        return String(cString: text)
      }
    }
    if let ip = ips.first(where: { !$0.hasPrefix("127.") }) ?? ips.first {
      route = "\(ip):\(sender.port)"
    }
  }
}

private struct RandomFailed: Error {}

public class PinnedTlsModule: Module {
  private var sockets: [String: (task: URLSessionWebSocketTask, session: URLSession)] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("PinnedTls")
    Events("onSocket")

    /// `count` bytes from the system's secure random generator, for `crypto.getRandomValues`.
    Function("randomBytes") { (count: Int) throws -> Data in
      var bytes = Data(count: count)
      let status = bytes.withUnsafeMutableBytes {
        SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
      }
      // Zeros would make a guessable SPAKE2 scalar and DPoP key.
      guard status == errSecSuccess else { throw RandomFailed() }
      return bytes
    }

    /// The URL of file `name` in Application Support/Parallax, a folder kept out of backups: the
    /// outbox's, whose messages belong to this phone's pairing.
    Function("privateFile") { (name: String) throws -> String in
      var folder = try FileManager.default.url(
        for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
      ).appendingPathComponent("Parallax", isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
      return folder.appendingPathComponent(name).absoluteString
    }

    /// The computers advertising `_parallax._tcp` while they show a pairing code (0065), found in
    /// `seconds`: each one's name and its IPv4 address with port.
    AsyncFunction("discover") { (seconds: Double, promise: Promise) in
      let browser = NWBrowser(for: .bonjour(type: "_parallax._tcp", domain: nil), using: .tcp)
      var resolving: [String: (NetService, Resolver)] = [:]
      browser.browseResultsChangedHandler = { results, _ in
        for result in results {
          guard case .service(let name, let type, let domain, _) = result.endpoint,
            resolving[name] == nil
          else { continue }
          let service = NetService(domain: domain, type: type, name: name)
          let resolver = Resolver()
          service.delegate = resolver
          service.resolve(withTimeout: seconds)
          resolving[name] = (service, resolver)
        }
      }
      browser.start(queue: .main)
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        browser.cancel()
        let found = resolving.compactMap { name, pair -> [String: String]? in
          pair.0.stop()
          return pair.1.route.map { ["name": name, "route": $0] }
        }
        promise.resolve(found)
      }
    }

    /// One request: its status, its body as text, and the fingerprint of the certificate reached.
    AsyncFunction("request") {
      (
        url: String, method: String, headers: [String: String], body: String?, pin: String?,
        promise: Promise
      ) in
      guard let target = URL(string: url) else {
        return promise.reject("ERR_URL", "not a URL: \(url)")
      }
      let pinning = Pinning(pin: pin)
      let session = URLSession(configuration: .ephemeral, delegate: pinning, delegateQueue: nil)
      var request = URLRequest(url: target, timeoutInterval: 10)
      request.httpMethod = method
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      if let body {
        request.httpBody = body.data(using: .utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      session.dataTask(with: request) { data, response, error in
        session.finishTasksAndInvalidate()
        if let error {
          let code = pinning.pin != nil && !pinning.seen.isEmpty && pinning.seen != pinning.pin
            ? "ERR_WRONG_HOST" : "ERR_NETWORK"
          return promise.reject(code, error.localizedDescription)
        }
        promise.resolve([
          "status": (response as? HTTPURLResponse)?.statusCode ?? 0,
          "body": String(decoding: data ?? Data(), as: UTF8.self),
          "fingerprint": pinning.seen,
        ])
      }.resume()
    }

    /// Opens WebSocket `id`, which reports `open`, each `message`, and one `close` as `onSocket`.
    Function("open") { (id: String, url: String, pin: String) in
      guard let target = URL(string: url) else { return }
      let pinning = Pinning(pin: pin)
      let session = URLSession(configuration: .ephemeral, delegate: pinning, delegateQueue: nil)
      let task = session.webSocketTask(with: target)
      // plxd's frames carry whole snapshots, larger than URLSession's 1 MiB default.
      task.maximumMessageSize = 64 << 20
      pinning.opened = { [weak self] in self?.sendEvent("onSocket", ["id": id, "type": "open"]) }
      pinning.closed = { [weak self] in self?.closed(id) }
      lock.withLock { sockets[id] = (task, session) }
      receive(id, task)
      task.resume()
    }

    Function("send") { (id: String, text: String) in
      guard let socket = lock.withLock({ sockets[id] }) else { return }
      socket.task.send(.string(text)) { [weak self] error in
        if error != nil { self?.closed(id) }
      }
    }

    Function("close") { (id: String) in
      guard let socket = lock.withLock({ sockets.removeValue(forKey: id) }) else { return }
      socket.task.cancel(with: .normalClosure, reason: nil)
      socket.session.invalidateAndCancel()
    }
  }

  private func receive(_ id: String, _ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        sendEvent("onSocket", ["id": id, "type": "message", "data": text])
        receive(id, task)
      case .success(.data(let data)):
        let text = String(decoding: data, as: UTF8.self)
        sendEvent("onSocket", ["id": id, "type": "message", "data": text])
        receive(id, task)
      case .success:
        receive(id, task)
      case .failure:
        closed(id)
      }
    }
  }

  /// Reports socket `id` closed, once, and lets its session go.
  private func closed(_ id: String) {
    guard let socket = lock.withLock({ sockets.removeValue(forKey: id) }) else { return }
    socket.session.invalidateAndCancel()
    sendEvent("onSocket", ["id": id, "type": "close"])
  }
}
