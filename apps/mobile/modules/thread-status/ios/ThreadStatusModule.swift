// The app's side of ThreadStatus.swift and ThreadActivity.swift: the threads it sees, a push it gets
// while in front, which `xcrun simctl push` can also reach, and signing out. `group` is the shared
// keychain group, which the app must name since it has another first.
import ExpoModulesCore

public class ThreadStatusModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ThreadStatus")

    AsyncFunction("sync") { (seen: String, connected: [String], group: String) async in
      guard let entries = try? threadDecoder.decode([ThreadEntry].self, from: Data(seen.utf8)) else { return }
      // Only for a thread seen going now: what's kept from before may be long over.
      let mayStart = entries.contains { $0.state.isLive }
      await showInActivity(saveSeen(entries, connected: connected, group: group), mayStart: mayStart)
    }

    AsyncFunction("applyPush") { (body: [String: Any], group: String) async in
      let userInfo: [AnyHashable: Any] = ["body": body]
      guard let sealed = opened(userInfo, key: savedKey),
        let entries = savePush(userInfo, sealed: sealed, group: group)
      else { return }
      await showInActivity(entries, mayStart: true)
    }

    AsyncFunction("signOut") { (group: String) async in
      forgetThreads(group: group)
      await endActivities()
    }
  }
}
