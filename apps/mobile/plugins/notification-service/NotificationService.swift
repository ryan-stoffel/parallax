// Opens what plxd sealed for a push (0100, daemon/src/relay/seal.rs) into the notification's title
// and text. Any failure leaves the relay's fixed text, and `userInfo` stays as it came, so tapping
// opens the thread.
import CryptoKit
import Foundation
import Security
import UserNotifications

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

/// The push key the app saved for `host` (`savePushKey` in src/push.ts), as expo-secure-store files
/// it. With no access group named, this looks in the one group this extension has, which holds
/// nothing else of the app's.
func savedKey(_ host: String) -> Data? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "pushKeys:no-auth",
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

final class NotificationService: UNNotificationServiceExtension {
  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    guard let sealed = opened(request.content.userInfo, key: savedKey),
      let content = request.content.mutableCopy() as? UNMutableNotificationContent
    else { return contentHandler(request.content) }
    content.title = sealed.title
    content.body = sealed.text
    contentHandler(content)
  }
}
