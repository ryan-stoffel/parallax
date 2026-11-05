// The home screen widget and the Live Activity (0100). The widget draws what ThreadStatus.swift keeps,
// with names hidden while the phone is locked. The Live Activity draws only counts and states.
import ActivityKit
import SwiftUI
import WidgetKit

extension ThreadState {
  var label: String {
    switch self {
    case .needsYou: return "Needs you"
    case .working: return "Working"
    case .failed: return "Failed"
    case .done: return "Finished"
    }
  }

  var symbol: String {
    switch self {
    case .needsYou: return "hand.raised.fill"
    case .working: return "circle.dotted"
    case .failed: return "xmark.circle.fill"
    case .done: return "checkmark.circle.fill"
    }
  }

  /// The app's dark palette (src/theme.ts).
  var color: Color {
    switch self {
    case .needsYou: return Color(red: 0.961, green: 0.620, blue: 0.043)
    case .working: return Color(red: 0.357, green: 0.502, blue: 1)
    case .failed: return Color(red: 1, green: 0.420, blue: 0.290)
    case .done: return .secondary
    }
  }
}

private let threadsLink = URL(string: "parallax://threads")!

private func link(_ text: String?) -> URL { text.flatMap(URL.init(string:)) ?? threadsLink }

private struct Mark: View {
  let state: ThreadState
  var body: some View {
    Image(systemName: state.symbol).foregroundStyle(state.color)
  }
}

// MARK: Widget

struct ThreadsEntry: TimelineEntry {
  let date: Date
  let threads: [ThreadEntry]
}

struct ThreadsProvider: TimelineProvider {
  private static let sample = ThreadEntry(
    run: "", host: "", title: "A thread", state: .working, at: Date(), link: nil)

  func placeholder(in context: Context) -> ThreadsEntry {
    ThreadsEntry(date: Date(), threads: [Self.sample])
  }

  func getSnapshot(in context: Context, completion: @escaping (ThreadsEntry) -> Void) {
    let threads = readThreads()
    completion(ThreadsEntry(date: Date(), threads: threads.isEmpty ? [Self.sample] : threads))
  }

  /// One entry: the app and the notification service extension reload it when anything changes.
  func getTimeline(in context: Context, completion: @escaping (Timeline<ThreadsEntry>) -> Void) {
    completion(Timeline(entries: [ThreadsEntry(date: Date(), threads: readThreads())], policy: .never))
  }
}

private struct ThreadRow: View {
  let thread: ThreadEntry
  var body: some View {
    HStack(spacing: 8) {
      Mark(state: thread.state).font(.subheadline)
      Text(thread.title).font(.subheadline.weight(.medium)).lineLimit(1).privacySensitive()
      Spacer(minLength: 4)
      Text(thread.state.label).font(.caption).foregroundStyle(.secondary).fixedSize()
    }
  }
}

struct ThreadsWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: ThreadsEntry

  var body: some View {
    Group {
      if entry.threads.isEmpty {
        Text("No recent threads").font(.subheadline).foregroundStyle(.secondary)
      } else if family == .systemSmall, let thread = entry.threads.first {
        small(thread).widgetURL(link(thread.link))
      } else {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(entry.threads.prefix(3), id: \.run) { thread in
            Link(destination: link(thread.link)) { ThreadRow(thread: thread) }
          }
          Spacer(minLength: 0)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .containerBackground(for: .widget) { Color(.systemBackground) }
  }

  private func small(_ thread: ThreadEntry) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Mark(state: thread.state).font(.title3)
      Text(thread.title).font(.subheadline.weight(.medium)).lineLimit(3).privacySensitive()
      Spacer(minLength: 0)
      Text(thread.state.label).font(.caption).foregroundStyle(.secondary)
      Text(thread.at, style: .relative).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
    }
  }
}

struct ThreadsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "threads", provider: ThreadsProvider()) { entry in
      ThreadsWidgetView(entry: entry)
    }
    .configurationDisplayName("Threads")
    .description("What your threads are doing.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

// MARK: Live Activity

extension ThreadsAttributes.ContentState {
  /// "1 needs you, 2 working", or how the last thread ended.
  fileprivate var summary: String {
    let parts = [
      needsYou > 0 ? "\(needsYou) \(needsYou == 1 ? "needs" : "need") you" : nil,
      working > 0 ? "\(working) working" : nil,
    ].compactMap { $0 }
    return parts.isEmpty ? state.label : parts.joined(separator: ", ")
  }
}

/// The state's mark, or a clock once the activity may be out of date.
private struct ActivityMark: View {
  let state: ThreadState
  let isStale: Bool
  var body: some View {
    if isStale {
      Image(systemName: "clock").foregroundStyle(.secondary)
    } else {
      Mark(state: state)
    }
  }
}

/// What the activity says, and that it may be out of date once its stale date passes.
private struct ActivityText: View {
  let state: ThreadsAttributes.ContentState
  let isStale: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(state.summary).font(.headline).lineLimit(1)
      Text(isStale ? "May be out of date. Open Parallax." : "Parallax")
        .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
    }
  }
}

struct ThreadsLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: ThreadsAttributes.self) { context in
      HStack(spacing: 12) {
        ActivityMark(state: context.state.state, isStale: context.isStale).font(.title2)
        ActivityText(state: context.state, isStale: context.isStale)
        Spacer(minLength: 0)
      }
      .padding(16)
      .widgetURL(threadsLink)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          ActivityMark(state: context.state.state, isStale: context.isStale).font(.title2)
        }
        DynamicIslandExpandedRegion(.bottom) {
          ActivityText(state: context.state, isStale: context.isStale)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      } compactLeading: {
        ActivityMark(state: context.state.state, isStale: context.isStale)
      } compactTrailing: {
        Text(verbatim: "\(context.state.needsYou + context.state.working)").font(.caption2)
      } minimal: {
        ActivityMark(state: context.state.state, isStale: context.isStale)
      }
      .widgetURL(threadsLink)
    }
  }
}

@main
struct ThreadWidgets: WidgetBundle {
  var body: some Widget {
    ThreadsWidget()
    ThreadsLiveActivity()
  }
}
