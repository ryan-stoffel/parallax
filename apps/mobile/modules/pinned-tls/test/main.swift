// The native half of relay.mjs: requests through RelayBridge with Pinning, as the app makes them,
// against the local relay and hosts relay.mjs runs. Arguments: the relay's URL, the host id, and
// the Clerk token the relay takes. Prints one line per check and exits 1 if any failed.
import Foundation

let arguments = CommandLine.arguments
let (relay, hostId, token) = (arguments[1], arguments[2], arguments[3])
var failed = false

func check(_ name: String, _ ok: Bool, _ detail: String = "") {
  print("\(ok ? "ok" : "FAIL") \(name)\(detail.isEmpty ? "" : ": \(detail)")")
  if !ok { failed = true }
}

/// A bridge to `path` on the relay with `token`, and its port.
func bridge(_ path: String, token: String) -> (RelayBridge, UInt16) {
  let bridge = try! RelayBridge(url: URL(string: relay + path)!, token: token)
  let done = DispatchSemaphore(value: 0)
  var port: UInt16?
  bridge.start { port = $0; done.signal() }
  done.wait()
  return (bridge, port!)
}

/// A GET to `/.well-known/parallax` on loopback `port`, pinned to `pin`.
func get(_ port: UInt16, pin: String) -> (status: Int?, body: String, refused: Bool) {
  let pinning = Pinning(pin: pin)
  let session = URLSession(
    configuration: Pinning.configuration(pin: pin), delegate: pinning, delegateQueue: nil)
  let url = URL(string: "https://127.0.0.1:\(port)/.well-known/parallax")!
  let done = DispatchSemaphore(value: 0)
  var result: (Int?, String, Bool) = (nil, "", false)
  session.dataTask(with: URLRequest(url: url, timeoutInterval: 10)) { data, response, error in
    result = (
      error == nil ? (response as? HTTPURLResponse)?.statusCode : nil,
      String(decoding: data ?? Data(), as: UTF8.self), pinning.refused
    )
    done.signal()
  }.resume()
  done.wait()
  session.invalidateAndCancel()
  return result
}

let connect = "/v1/hosts/\(hostId)/connect"

// The host's key is the host id, so TLS 1.3 inside the stream completes and the request answers,
// twice over one bridge, each on its own stream.
let (good, port) = bridge(connect, token: token)
for attempt in 1...2 {
  let answer = get(port, pin: "key:\(hostId)")
  check("pinned GET \(attempt) through the relay", answer.status == 200 && answer.body.contains(hostId), answer.body)
}

// Another key's id: the pin refuses the certificate before any request is sent.
let wrong = get(port, pin: "key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
check("another host id is refused", wrong.status == nil && wrong.refused)
good.close()

// A host that offers only TLS 1.2 is refused, whatever its key.
let (old, oldPort) = bridge("/v1/hosts/tls12/connect", token: token)
let downgraded = get(oldPort, pin: "key:\(hostId)")
check("TLS 1.2 is refused", downgraded.status == nil)
old.close()

// A token the relay refuses: no stream, and the bridge says why.
let (refused, refusedPort) = bridge(connect, token: "not-a-token")
let unauthorized = get(refusedPort, pin: "key:\(hostId)")
check(
  "the relay's refusal is reported", unauthorized.status == nil && refused.refused == 401,
  "\(String(describing: refused.refused))")
refused.close()

exit(failed ? 1 : 0)
