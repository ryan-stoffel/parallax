// TLS inside a Parallax Relay stream (0068, 0091), with Apple's own TLS: a loopback port whose
// every TCP connection is carried to plxd by a relay stream of its own. URLSession then reaches
// the host at `https://127.0.0.1:<port>`, pinned to its key as on any route, so the relay, which
// passes only these bytes, carries only TLS records. plxd answers one request per connection, as
// `plxd dial` sends them, so a stream per connection is a stream per request.
//
// A stream opens with the Clerk token in the `Authorization` header (0091). A relay from before
// 0091 refuses that with 401, 404, or 426, before any stream opens, and takes only a ticket: then,
// as `plxd dial` does, the stream asks for one (`POST /v1/hosts/<id>/tickets`) and opens
// `/connect?ticket=<ticket>`. Nothing falls back once a stream opened, or on any other refusal.
import Foundation
import Network

final class RelayBridge {
  /// The refusals of a header token that mean the relay takes only tickets.
  static let ticketOnly: Set<Int> = [401, 404, 426]

  private let listener: NWListener
  /// The relay's `/v1/hosts/<id>/connect`.
  private let connect: URL
  /// The relay's `/v1/hosts/<id>/tickets`, for a relay from before 0091.
  private let tickets: URL
  /// The Clerk token, sent only in `Authorization` headers, never a URL.
  private let token: String
  private let queue = DispatchQueue(label: "parallax.relay")
  private let session = URLSession(configuration: .ephemeral)
  private var pipes: [Pipe] = []
  private var started = false
  private let lock = NSLock()
  private var refusal: Int?

  /// The relay's HTTP status when it last refused a stream, such as 503 while the host is offline.
  /// Set before the refused connection closes, so the request that fails can read it.
  var refused: Int? { lock.withLock { refusal } }

  init(url: URL, token: String) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    parameters.acceptLocalOnly = true
    listener = try NWListener(using: parameters)
    connect = url
    var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    parts.scheme = parts.scheme == "ws" ? "http" : "https"
    parts.path = parts.path.replacingOccurrences(of: "/connect", with: "/tickets")
    tickets = parts.url!
    self.token = token
  }

  /// Listens, then calls `ready` once with the port, or nil when it can't.
  func start(_ ready: @escaping (UInt16?) -> Void) {
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: once { ready(self.listener.port?.rawValue) }
      case .failed, .cancelled: once { ready(nil) }
      default: break
      }
    }
    listener.start(queue: queue)
  }

  /// Stops listening and ends every stream.
  func close() {
    queue.async { [self] in
      listener.cancel()
      for pipe in pipes { pipe.end() }
      pipes = []
      session.invalidateAndCancel()
    }
  }

  private func once(_ body: () -> Void) {
    guard !started else { return }
    started = true
    body()
  }

  /// Carries `connection` over a stream opened with the header token, or with a ticket when the
  /// relay takes only tickets. Until the stream opens nothing is read, so the TLS handshake waits
  /// in the socket.
  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    var request = URLRequest(url: connect)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    open(connection, request) { [weak self] status in
      guard let self else { return connection.cancel() }
      if let status, Self.ticketOnly.contains(status) { return viaTicket(connection) }
      refuse(connection, status)
    }
  }

  /// Opens a stream with `request` for `connection` and, once the relay says plxd joined it
  /// (`ready`), passes bytes both ways. A refusal before then goes to `refused`, with its status.
  private func open(
    _ connection: NWConnection, _ request: URLRequest, refused: @escaping (Int?) -> Void
  ) {
    let socket = session.webSocketTask(with: request)
    socket.resume()
    socket.receive { [weak self] result in
      guard case .success(.string(let text)) = result, text == "ready" else {
        socket.cancel(with: .normalClosure, reason: nil)
        return refused((socket.response as? HTTPURLResponse)?.statusCode)
      }
      let pipe = Pipe(tcp: connection, socket: socket, queue: self?.queue ?? .main)
      self?.queue.async {
        self?.pipes.removeAll { $0.ended }
        self?.pipes.append(pipe)
      }
      pipe.run()
    }
  }

  /// A relay from before 0091: a one-time ticket for the stream, then the stream with it.
  private func viaTicket(_ connection: NWConnection) {
    var post = URLRequest(url: tickets)
    post.httpMethod = "POST"
    post.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    session.dataTask(with: post) { [weak self] data, response, _ in
      guard let self else { return connection.cancel() }
      let status = (response as? HTTPURLResponse)?.statusCode
      let answer = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      guard status == 200, let ticket = answer?["ticket"] as? String,
        var parts = URLComponents(url: connect, resolvingAgainstBaseURL: false)
      else { return refuse(connection, status) }
      parts.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
      open(connection, URLRequest(url: parts.url!)) { [weak self] status in
        self?.refuse(connection, status)
      }
    }.resume()
  }

  /// Records why the relay refused `connection`'s stream, then closes the connection.
  private func refuse(_ connection: NWConnection, _ status: Int?) {
    lock.withLock { refusal = status }
    connection.cancel()
  }
}

/// One TCP connection and its relay stream: each read becomes a binary frame, and each binary
/// frame is written back.
private final class Pipe {
  let tcp: NWConnection
  let socket: URLSessionWebSocketTask
  let queue: DispatchQueue
  private let lock = NSLock()
  private var done = false

  init(tcp: NWConnection, socket: URLSessionWebSocketTask, queue: DispatchQueue) {
    self.tcp = tcp
    self.socket = socket
    self.queue = queue
  }

  var ended: Bool { lock.withLock { done } }

  func run() {
    upstream()
    downstream()
  }

  func end() {
    let first = lock.withLock {
      defer { done = true }
      return !done
    }
    guard first else { return }
    tcp.cancel()
    socket.cancel(with: .normalClosure, reason: nil)
  }

  private func upstream() {
    tcp.receive(minimumIncompleteLength: 1, maximumLength: 64 << 10) { [self] data, _, complete, error in
      guard let data, !data.isEmpty else {
        if complete || error != nil { end() } else { upstream() }
        return
      }
      socket.send(.data(data)) { [self] error in
        if error != nil { return end() }
        if complete { return end() }
        upstream()
      }
    }
  }

  private func downstream() {
    socket.receive { [self] result in
      switch result {
      case .success(.data(let data)):
        tcp.send(content: data, completion: .contentProcessed { [self] error in
          if error != nil { end() } else { downstream() }
        })
      case .success:
        downstream()
      case .failure:
        end()
      }
    }
  }
}
