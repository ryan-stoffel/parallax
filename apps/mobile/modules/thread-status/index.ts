// The JS side of ThreadStatusModule.swift and, on Android, ThreadWidgetModule.kt: what the widget and
// the Live Activity show (0100).
import { requireOptionalNativeModule } from "expo";

/** Null on Android, which has no Live Activity and keeps its widget's threads in JS (ThreadWidget). */
export const ThreadStatus = requireOptionalNativeModule<{
  /** `seen` is JSON of `StatusEntry[]` (src/threadStatus.ts). */
  sync(seen: string, connected: string[], group: string): Promise<void>;
  /** Opens a push's body with the same code as the notification service extension. */
  applyPush(body: Record<string, unknown>, group: string): Promise<void>;
  /** Removes the kept threads and push keys, and ends the Live Activity. */
  signOut(group: string): Promise<void>;
}>("ThreadStatus");

/** The Android home screen widget's threads (src/androidThreads.ts). Null on iOS. */
export const ThreadWidget = requireOptionalNativeModule<{
  /** JSON of the `StatusEntry[]` kept. */
  read(): string;
  /** Keeps `threads`, JSON of `StatusEntry[]`, and `labels`, JSON of each state's word and `empty`'s, and redraws. */
  show(threads: string, labels: string): void;
  /** Removes every thread, for signing out. */
  clear(): void;
}>("ThreadWidget");
