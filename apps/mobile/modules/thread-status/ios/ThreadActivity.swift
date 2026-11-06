// The Live Activity (0100), for the app and the widget extension. It shows counts and states only, so
// no thread's name reaches a locked phone, and it has no push token, so the relay learns nothing.
import ActivityKit
import Foundation

/// How long a Live Activity with a thread going is trusted. Only the app updates it, so while the app
/// is closed this is what makes it say it may be out of date.
private let staleAfter: TimeInterval = 30 * 60

/// One Live Activity for all threads.
struct ThreadsAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The state that matters most.
    let state: ThreadState
    let needsYou: Int
    let working: Int
  }
}

/// Shows `entries` in the Live Activity. While a thread is live it updates the activity, or starts
/// one if `mayStart`. With none live it ends the activity, which stays up a while showing how the
/// last one ended. Call only from the app.
func showInActivity(_ entries: [ThreadEntry], mayStart: Bool) async {
  let activities = Activity<ThreadsAttributes>.activities
  let current = activities.filter { $0.activityState == .active || $0.activityState == .stale }
  let live = entries.filter(\.state.isLive)
  let content = entries.first.map { top in
    ActivityContent(
      state: ThreadsAttributes.ContentState(
        state: top.state,
        needsYou: live.filter { $0.state == .needsYou }.count,
        working: live.filter { $0.state == .working }.count),
      staleDate: live.isEmpty ? nil : Date().addingTimeInterval(staleAfter))
  }
  guard let content, !live.isEmpty else {
    for activity in current {
      await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(15 * 60)))
    }
    return
  }
  if let activity = current.first {
    await activity.update(content)
  } else if mayStart, #available(iOS 17.0, *), ActivityAuthorizationInfo().areActivitiesEnabled {
    // iOS 17 is the widget extension's minimum: below it nothing could draw the activity.
    _ = try? Activity.request(attributes: ThreadsAttributes(), content: content, pushType: nil)
  }
}

/// Takes the Live Activity away at once, for signing out.
func endActivities() async {
  for activity in Activity<ThreadsAttributes>.activities {
    await activity.end(nil, dismissalPolicy: .immediate)
  }
}
