// TLS inside a Parallax Relay stream (0068, 0091), with Apple's own TLS: a loopback port whose
// every TCP connection is carried to plxd by a relay stream of its own. URLSession then reaches
// the host at `https://127.0.0.1:<port>`, pinned to its key as on any route, so the relay, which
// passes only these bytes, carries only TLS records. plxd answers one request per connection, as
// `plxd dial` sends them, so a stream per connection is a stream per request.
import Foundation
import Network

final class RelayBridge {
  private let listener: NWListener
  /// The stream's opening request: the relay's `/v1/hosts/<id>/connect`, with the Clerk token in
  /// its `Authorization` header, never the URL.
  private let stream: URLRequest
  private let queue = DispatchQueue(label: "parallax.relay")
  private let session = URLSession(configuration: .ephemeral)
  private var pipes: [Pipe] = []
  private var started = false
  /// The relay's HTTP status when it last refused a stream, such as 503 while the host is offline.
  private(set) var refused: Int?

  init(url: URL, token: String) throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    parameters.acceptLocalOnly = true
    listener = try NWListener(using: parameters)
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    stream = request
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

  /// Opens a stream for `connection`, and once the relay says plxd joined it (`ready`), passes
  /// bytes both ways. Until then nothing is read, so the TLS handshake waits in the socket.
  private func accept(_ connection: NWConnection) {
    pipes.removeAll { $0.ended }
    let socket = session.webSocketTask(with: stream)
    let pipe = Pipe(tcp: connection, socket: socket, queue: queue)
    pipes.append(pipe)
    connection.start(queue: queue)
    socket.resume()
    socket.receive { [weak self] result in
      if case .success(.string(let text)) = result, text == "ready" { return pipe.run() }
      self?.queue.async { self?.refused = (socket.response as? HTTPURLResponse)?.statusCode }
      pipe.end()
    }
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
