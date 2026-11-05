// The JS side of ThreadStatusModule.swift: what the widget and the Live Activity show (0100).
import { requireNativeModule } from "expo";

export const ThreadStatus = requireNativeModule<{
  /** `seen` is JSON of `StatusEntry[]` (src/threadStatus.ts). */
  sync(seen: string, connected: string[], group: string): Promise<void>;
  /** Opens a push's body with the same code as the notification service extension. */
  applyPush(body: Record<string, unknown>, group: string): Promise<void>;
  /** Removes the kept threads and push keys, and ends the Live Activity. */
  signOut(group: string): Promise<void>;
}>("ThreadStatus");
