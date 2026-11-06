// The threads the widget shows and the Live Activity counts (0100), kept in the keychain group the
// app shares with its extensions, and opening what plxd sealed for a push. The app and both
// extensions compile this file. The notification service extension has little memory, so anything
// heavier than this goes in ThreadActivity.swift, which it doesn't compile.
import CryptoKit
import Foundation
import Security
import WidgetKit

enum ThreadState: String, Codable {
  case needsYou, working, failed, done

  /// Whether the thread is still going, which is what keeps a Live Activity up.
  var isLive: Bool { self == .needsYou || self == .working }

  fileprivate var rank: Int {
    switch self {
    case .needsYou: return 0
    case .working: return 1
    case .failed: return 2
    case .done: return 3
    }
  }
}

/// One thread. `host` is the app's id for its computer. `link` is nil for one only a push told about.
struct ThreadEntry: Codable, Equatable {
  let run: String
  let host: String
  let title: String
  let state: ThreadState
  let at: Date
  let link: String?
}

/// The most entries kept. The medium widget shows three.
private let keep = 8
/// How long an ended thread stays.
private let ended: TimeInterval = 24 * 60 * 60
/// How long one still going stays with no news, as one on a computer since removed from the phone.
private let going: TimeInterval = 3 * 24 * 60 * 60

/// What needs the user first, then what's going, then what ended, newest first within each. Threads
/// too old to mean anything drop out.
func ordered(_ entries: [ThreadEntry], now: Date = Date()) -> [ThreadEntry] {
  let shown = entries.filter { now.timeIntervalSince($0.at) < ($0.state.isLive ? going : ended) }
  return Array(shown.sorted { ($0.state.rank, $1.at) < ($1.state.rank, $0.at) }.prefix(keep))
}

/// Every thread in `seen`, in place of what `kept` held for them or for any computer in `connected`,
/// which `seen` is complete for. Threads on other computers stay.
func merging(
  seen: [ThreadEntry], connected: [String], into kept: [ThreadEntry], now: Date = Date()
) -> [ThreadEntry] {
  let runs = Set(seen.map(\.run))
  return ordered(kept.filter { !runs.contains($0.run) && !connected.contains($0.host) } + seen, now: now)
}

/// `kept` with what a push says about `run`, on the computer with relay id `relayId`. It's named as
/// the app names an account's computer (`accountId` in src/machines.ts), so what the app sees there
/// can replace it.
func merging(
  run: String, relayId: String, title: String, state: ThreadState, into kept: [ThreadEntry],
  now: Date = Date()
) -> [ThreadEntry] {
  let entry = ThreadEntry(
    run: run, host: "account:\(relayId)", title: title, state: state, at: now,
    link: kept.first { $0.run == run }?.link)
  return ordered(kept.filter { $0.run != run } + [entry], now: now)
}

// MARK: Keychain

private let threadEncoder: JSONEncoder = {
  let coder = JSONEncoder()
  coder.dateEncodingStrategy = .millisecondsSince1970
  return coder
}()
let threadDecoder: JSONDecoder = {
  let coder = JSONDecoder()
  coder.dateDecodingStrategy = .millisecondsSince1970
  return coder
}()

/// The keychain item holding the entries. `group` is nil in an extension, which has only the one.
private func threadsItem(_ group: String?) -> [String: Any] {
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "threadStatus",
    kSecAttrAccount as String: "threads",
  ]
  if let group { query[kSecAttrAccessGroup as String] = group }
  return query
}

func readThreads(group: String? = nil) -> [ThreadEntry] {
  var query = threadsItem(group)
  query[kSecMatchLimit as String] = kSecMatchLimitOne
  query[kSecReturnData as String] = true
  var found: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
    let data = found as? Data,
    let entries = try? threadDecoder.decode([ThreadEntry].self, from: data)
  else { return [] }
  return ordered(entries)
}

/// Saves `entries` and redraws the widget. Readable once the phone has been unlocked since it
/// started, since the extensions run while it's locked.
private func writeThreads(_ entries: [ThreadEntry], group: String?) {
  guard let data = try? threadEncoder.encode(entries) else { return }
  let change: [String: Any] = [kSecValueData as String: data]
  if SecItemUpdate(threadsItem(group) as CFDictionary, change as CFDictionary) == errSecItemNotFound {
    var add = threadsItem(group)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }
  WidgetCenter.shared.reloadAllTimelines()
}

/// Saves what the app knows now (`merging(seen:)`). Returns the entries now kept.
func saveSeen(_ seen: [ThreadEntry], connected: [String], group: String?) -> [ThreadEntry] {
  let entries = merging(seen: seen, connected: connected, into: readThreads(group: group))
  writeThreads(entries, group: group)
  return entries
}

/// Saves what a push that opened says: its run's state, under the title sealed with it. Returns the
/// entries now kept, or nil for a push that names no state this knows.
func savePush(_ userInfo: [AnyHashable: Any], sealed: Sealed, group: String?) -> [ThreadEntry]? {
  guard let body = userInfo["body"] as? [String: Any],
    let host = body["hostId"] as? String,
    let run = body["run"] as? String,
    let state = (body["state"] as? String).flatMap(ThreadState.init)
  else { return nil }
  let entries = merging(
    run: run, relayId: host, title: sealed.title, state: state, into: readThreads(group: group))
  writeThreads(entries, group: group)
  return entries
}

/// Removes the threads and every push key, for signing out: later pushes then can't open, so they
/// show the fixed text and write nothing.
func forgetThreads(group: String) {
  SecItemDelete(threadsItem(group) as CFDictionary)
  let keys: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: pushKeysService,
    kSecAttrAccessGroup as String: group,
  ]
  SecItemDelete(keys as CFDictionary)
  WidgetCenter.shared.reloadAllTimelines()
}

// MARK: Opening a push

/// What plxd seals.
struct Sealed: Decodable {
  let title: String
  let text: String
}

/// Opens `userInfo`'s `body.sealed` with `key(hostId)`, bound to the push's host, run, and state.
func opened(_ userInfo: [AnyHashable: Any], key: (String) -> Data?) -> Sealed? {
  guard let body = userInfo["body"] as? [String: Any],
    let host = body["hostId"] as? String,
    let run = body["run"] as? String,
    let state = body["state"] as? String,
    let sealed = (body["sealed"] as? String).flatMap(base64url),
    let keyBytes = key(host), keyBytes.count == 32,
    let box = try? AES.GCM.SealedBox(combined: sealed),
    let plain = try? AES.GCM.open(
      box, using: SymmetricKey(data: keyBytes), authenticating: Data("\(host):\(run):\(state)".utf8))
  else { return nil }
  return try? JSONDecoder().decode(Sealed.self, from: plain)
}

func base64url(_ text: String) -> Data? {
  let base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  return Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4))
}

/// The service expo-secure-store files the push keys under (`savePushKey` in src/push.ts).
private let pushKeysService = "pushKeys:no-auth"

/// The push key the app saved for `host`. With no access group named, this looks in every group the
/// caller has, and only the shared one holds this service.
func savedKey(_ host: String) -> Data? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: pushKeysService,
    kSecAttrAccount as String: Data(host.utf8),
    kSecMatchLimit as String: kSecMatchLimitOne,
    kSecReturnData as String: true,
  ]
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
    let saved = item as? Data, let text = String(data: saved, encoding: .utf8)
  else { return nil }
  return base64url(text)
}
