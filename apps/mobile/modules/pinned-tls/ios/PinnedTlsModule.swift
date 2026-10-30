// HTTPS requests and a WebSocket to plxd's remote listener (0065), whose certificate is its own
// self-signed one: trusted only when its SHA-256 matches the fingerprint pairing pinned, or, for an
// account's host, when its key is the host id (0091, Pinning.swift). React Native's fetch and
// WebSocket can't pin a certificate, so the app reaches plxd through this, directly or through a
// Parallax Relay stream (RelayBridge.swift). It also finds hosts over mDNS, signs in to the
// Parallax account as the desktop does (0067), reports network changes, keeps the app running
// briefly in the background, shows a file in Quick Look, and supplies secure random bytes, a
// backup-free file location, and the build's version.
import AuthenticationServices
import ExpoModulesCore
import Foundation
import Network
import QuickLook
import UIKit

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

/// Shows the sign-in sheet over the app's window.
private final class AuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
  }
}

public class PinnedTlsModule: Module {
  private var sockets: [String: (task: URLSessionWebSocketTask, session: URLSession)] = [:]
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "parallax.network")
  /// The sign-in sheet under way, and what it shows over.
  private var auth: ASWebAuthenticationSession?
  private let anchor = AuthAnchor()
  private var background: UIBackgroundTaskIdentifier = .invalid
  /// The file Quick Look shows, kept while its preview is up.
  private let look = Look()
  /// The relay bridges open, by the id the app gave each.
  private var bridges: [String: RelayBridge] = [:]
  private let paths = NWPathMonitor()

  public func definition() -> ModuleDefinition {
    Name("PinnedTls")
    Events("onSocket", "onNetwork")

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
    /// It gives up after `timeout` seconds without a byte.
    AsyncFunction("request") {
      (
        url: String, method: String, headers: [String: String], body: String?, pin: String?,
        timeout: Double, promise: Promise
      ) in
      guard let target = URL(string: url) else {
        return promise.reject("ERR_URL", "not a URL: \(url)")
      }
      let pinning = Pinning(pin: pin)
      let session = URLSession(
        configuration: Pinning.configuration(pin: pin), delegate: pinning, delegateQueue: nil)
      var request = URLRequest(url: target, timeoutInterval: timeout)
      request.httpMethod = method
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      if let body {
        request.httpBody = body.data(using: .utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      session.dataTask(with: request) { data, response, error in
        session.finishTasksAndInvalidate()
        if let error {
          return promise.reject(
            pinning.refused ? "ERR_WRONG_HOST" : "ERR_NETWORK", error.localizedDescription)
        }
        promise.resolve([
          "status": (response as? HTTPURLResponse)?.statusCode ?? 0,
          "body": String(decoding: data ?? Data(), as: UTF8.self),
          "fingerprint": pinning.seen,
        ])
      }.resume()
    }

    /// Opens WebSocket `id` with `headers` on its upgrade, which reports `open`, each `message`,
    /// and one `close` as `onSocket`, the close with the upgrade's HTTP status when it was refused.
    Function("open") { (id: String, url: String, pin: String, headers: [String: String]) in
      guard let target = URL(string: url) else { return }
      let pinning = Pinning(pin: pin)
      let session = URLSession(
        configuration: Pinning.configuration(pin: pin), delegate: pinning, delegateQueue: nil)
      var request = URLRequest(url: target)
      for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
      let task = session.webSocketTask(with: request)
      // plxd's frames carry whole snapshots, larger than URLSession's 1 MiB default.
      task.maximumMessageSize = 64 << 20
      var open = false
      pinning.opened = { [weak self] in
        open = true
        self?.sendEvent("onSocket", ["id": id, "type": "open"])
      }
      pinning.closed = { [weak self] status in self?.closed(id, status: open ? nil : status) }
      lock.withLock { sockets[id] = (task, session) }
      receive(id, task)
      task.resume()
    }

    /// Opens relay bridge `id` (RelayBridge.swift): a loopback port each of whose connections is a
    /// stream to a host through the relay's `url` (`wss://…/v1/hosts/<id>/connect`), opened with
    /// the Clerk `token`. Resolves to the port.
    AsyncFunction("relayOpen") { (id: String, url: String, token: String, promise: Promise) in
      guard let target = URL(string: url), let bridge = try? RelayBridge(url: target, token: token)
      else { return promise.reject("ERR_NETWORK", "Couldn't open a relay stream.") }
      self.lock.withLock { self.bridges[id] = bridge }
      bridge.start { port in
        if let port { promise.resolve(Int(port)) } else {
          promise.reject("ERR_NETWORK", "Couldn't open a relay stream.")
        }
      }
    }

    /// The relay's HTTP status when it last refused one of bridge `id`'s streams, such as 503
    /// while the host is offline, or nil.
    Function("relayRefused") { (id: String) -> Int? in
      lock.withLock { bridges[id] }?.refused
    }

    /// Closes relay bridge `id` and every stream through it.
    Function("relayClose") { (id: String) in
      lock.withLock { bridges.removeValue(forKey: id) }?.close()
    }

    /// Signs in as the desktop app does (0067): Clerk's authorize URL `url` opens in a sign-in
    /// sheet that shares Safari's cookies, and Clerk sends it back to `parallax://oauth/callback`,
    /// which the sheet hands here without loading anything. Resolves to that callback URL, with
    /// its code and state, or rejects with `ERR_CANCELED` when the sheet is closed.
    AsyncFunction("authorize") { (url: String, promise: Promise) in
      self.auth?.cancel()
      guard let target = URL(string: url) else {
        return promise.reject("ERR_URL", "not a URL: \(url)")
      }
      let session = ASWebAuthenticationSession(url: target, callbackURLScheme: "parallax") {
        [weak self] callback, error in
        self?.auth = nil
        if let callback { promise.resolve(callback.absoluteString) } else {
          promise.reject("ERR_CANCELED", error?.localizedDescription ?? "Sign-in was cancelled.")
        }
      }
      session.presentationContextProvider = self.anchor
      self.auth = session
      if !session.start() { promise.reject("ERR_CANCELED", "Sign-in couldn't open.") }
    }.runOnQueue(.main)

    /// Shows the file at `url` (`file://`) in Quick Look over the app: a PDF, an image, a document,
    /// with iOS's own share button to save or send it.
    AsyncFunction("preview") { (url: String) in
      guard let file = URL(string: url) else { return }
      self.look.file = file
      let preview = QLPreviewController()
      preview.dataSource = self.look
      var top = UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.keyWindow?.rootViewController }.first
      while let presented = top?.presentedViewController { top = presented }
      top?.present(preview, animated: true)
    }.runOnQueue(.main)

    /// This build's version and build number, as its Info.plist has them.
    Function("appVersion") { () -> [String: String] in
      let info = Bundle.main.infoDictionary ?? [:]
      return [
        "version": info["CFBundleShortVersionString"] as? String ?? "",
        "build": info["CFBundleVersion"] as? String ?? "",
      ]
    }

    /// Keeps the app running for the time iOS allows after it goes to the background, about 30
    /// seconds, so its connections can still hear a thread finish and notify.
    OnCreate {
      // A network that comes back or changes, for the account's computers' discovery and route
      // re-checks (0091).
      var last: NWPath?
      paths.pathUpdateHandler = { [weak self] path in
        defer { last = path }
        guard let last, path.status == .satisfied,
          last.status != .satisfied || path.availableInterfaces.map(\.name)
            != last.availableInterfaces.map(\.name)
        else { return }
        self?.sendEvent("onNetwork", [:])
      }
      paths.start(queue: queue)
      NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.holdInBackground() }
      NotificationCenter.default.addObserver(
        forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.releaseBackground() }
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

  private func holdInBackground() {
    releaseBackground()
    background = UIApplication.shared.beginBackgroundTask(withName: "Parallax connections") {
      [weak self] in self?.releaseBackground()
    }
  }

  private func releaseBackground() {
    guard background != .invalid else { return }
    UIApplication.shared.endBackgroundTask(background)
    background = .invalid
  }

  /// Reports socket `id` closed, once, with the HTTP `status` that refused its upgrade if one
  /// did, and lets its session go.
  private func closed(_ id: String, status: Int? = nil) {
    guard let socket = lock.withLock({ sockets.removeValue(forKey: id) }) else { return }
    socket.session.invalidateAndCancel()
    var event: [String: Any] = ["id": id, "type": "close"]
    if let status { event["status"] = status }
    sendEvent("onSocket", event)
  }
}

/// The one file a Quick Look preview shows.
private final class Look: NSObject, QLPreviewControllerDataSource {
  var file: URL?
  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { file == nil ? 0 : 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    file! as NSURL
  }
}
