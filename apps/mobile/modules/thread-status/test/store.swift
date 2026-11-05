// Checks which threads ThreadStatus.swift keeps, on a Mac: `node modules/thread-status/test/store.mjs`.
import Foundation

let now = Date(timeIntervalSince1970: 1_000_000)
let hour: TimeInterval = 3600

func entry(_ run: String, _ state: ThreadState, host: String = "account:one", hoursAgo: Double = 0)
  -> ThreadEntry
{
  ThreadEntry(
    run: run, host: host, title: run, state: state, at: now.addingTimeInterval(-hoursAgo * hour),
    link: nil)
}

func check(_ what: String, _ got: [String], _ want: [String]) {
  guard got == want else {
    print("FAIL \(what): got \(got), want \(want)")
    exit(1)
  }
  print("ok \(what)")
}

let order = ordered(
  [entry("done", .done), entry("old-live", .working, hoursAgo: 2), entry("new-live", .working),
   entry("failed", .failed), entry("asks", .needsYou)], now: now)
check("what needs you first, then what's going, then what ended", order.map(\.run),
  ["asks", "new-live", "old-live", "failed", "done"])

check("an ended thread lasts a day, and one going three",
  ordered(
    [entry("ended", .done, hoursAgo: 25), entry("going", .working, hoursAgo: 71),
     entry("gone", .working, hoursAgo: 73)], now: now
  ).map(\.run), ["going"])

// A thread needing approval while the app is closed, then cancelled or archived on the Mac: the app
// no longer lists it, and connecting to its computer must drop what the push wrote.
let fromPush = merging(run: "run", relayId: "one", title: "t", state: .needsYou, into: [], now: now)
check("a push names the computer as the app does", fromPush.map(\.host), ["account:one"])
check("what the app sees on a computer replaces what a push said about it",
  merging(seen: [], connected: ["account:one"], into: fromPush, now: now).map(\.run), [])
check("a computer that isn't connected keeps its threads",
  merging(seen: [], connected: ["account:two"], into: fromPush, now: now).map(\.run), ["run"])

let known = ThreadEntry(
  run: "run", host: "account:one", title: "old", state: .working, at: now, link: "parallax://thread")
let updated = merging(run: "run", relayId: "one", title: "new", state: .done, into: [known], now: now)
check("a push updates a known thread and keeps its link",
  updated.flatMap { [$0.title, $0.state.rawValue, $0.link ?? "none"] }, ["new", "done", "parallax://thread"])
