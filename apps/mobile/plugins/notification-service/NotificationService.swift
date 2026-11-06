// Opens what plxd sealed for a push (0100, daemon/src/relay/seal.rs) into the notification's title
// and text, and saves it for the widget (ThreadStatus.swift). Any failure leaves the relay's fixed
// text, and `userInfo` stays as it came, so tapping opens the thread. It leaves the Live Activity to
// the app: Apple documents no way to update one from here, and a failure in ActivityKit could cost
// the push its title.
import Foundation
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let userInfo = request.content.userInfo
    guard let sealed = opened(userInfo, key: savedKey),
      let content = request.content.mutableCopy() as? UNMutableNotificationContent
    else { return contentHandler(request.content) }
    content.title = sealed.title
    content.body = sealed.text
    _ = savePush(userInfo, sealed: sealed, group: nil)
    contentHandler(content)
  }
}
