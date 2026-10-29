// Claude Remote Control threads (PLX-1140): a thread that follows a Claude Code session
// `claude remote-control` serves on another computer. Its messages go to that session, so they
// take text only: images can't go, and a text file goes inside the message under its name.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type {
  AgentRun,
  RemoteControlSession,
  RemoteControlState,
} from "../protocol/generated/protocol";

/** Whether `run` follows a Claude Remote Control session: its session is `claude.ai`'s. */
export const isRemoteControl = (run?: Pick<AgentRun, "sessionId"> | null) =>
  !!run?.sessionId?.startsWith("session_");

/** How each state reads: a short label, what it means for a message, and its dot's color. */
export const remoteControlLook: Record<
  RemoteControlState,
  { label: string; detail?: string; dot: string; pulse?: boolean }
> = {
  running: { label: "Working", dot: "bg-working", pulse: true },
  idle: { label: "Idle", dot: "bg-faint-foreground/45" },
  waiting: { label: "Waiting for your answer in Claude", dot: "bg-warning" },
  offline: {
    label: "Offline",
    detail: "Your message is queued until the computer is back",
    dot: "bg-faint-foreground/45",
  },
  archived: { label: "Archived", dot: "bg-faint-foreground/45" },
};

/** Whether `state` asks something of the user, so its tab leads the composer's line. */
export const needsAttention = (state?: RemoteControlState) =>
  state === "waiting" || state === "offline" || state === "archived";

/** Why a Remote Control thread can't send now, which turns Send off: only once it's archived. */
export const remoteControlDisabled = (session?: RemoteControlSession) =>
  session?.state === "archived"
    ? "This Claude Remote Control session is archived, so it can't take new messages"
    : undefined;

/** Why the composer refuses an image for a Remote Control thread. */
export const IMAGES_REFUSED =
  "A Claude Remote Control session takes text only, so images can't be sent to it.";

/** The most bytes of text files one message to a Remote Control session carries. */
export const MAX_INLINE_BYTES = 100 * 1024;

/**
 * `file`'s text, or why it can't go inside a message: it isn't UTF-8 text, or it's larger than
 * `room` bytes, what's left of `MAX_INLINE_BYTES`.
 */
export async function readTextFile(
  file: File,
  room = MAX_INLINE_BYTES,
): Promise<{ text: string } | { error: string }> {
  if (file.size > room)
    return {
      error: `${file.name} is too large: a message to a Claude Remote Control session carries at most 100 KB of files.`,
    };
  const notText = {
    error: `${file.name} isn't a text file. A Claude Remote Control session takes text files only.`,
  };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    return text.includes("\0") ? notText : { text };
  } catch {
    return notText;
  }
}

/**
 * `text` with each of `files` after it: its name, then its contents in a fence longer than any
 * run of backticks inside it, so the contents can't close it.
 */
export function withInlineFiles(text: string, files: { name: string; text: string }[]): string {
  if (files.length === 0) return text;
  const blocks = files.map(({ name, text: contents }) => {
    const longest = Math.max(0, ...(contents.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    const body = contents.endsWith("\n") ? contents : `${contents}\n`;
    return `${name}:\n${fence}\n${body}${fence}`;
  });
  return [text.trim(), ...blocks].filter(Boolean).join("\n\n");
}

/** How often a shown Remote Control thread's session is read again. */
export const REMOTE_CONTROL_POLL_MS = 15_000;

// One read per session however many places show it, such as the composer and Thread details:
// each session's last answer, and who shows it.
const sessions = new Map<string, RemoteControlSession | undefined>();
const watchers = new Map<
  string,
  { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> }
>();

const read = (hostId: string, runId: string) => {
  const key = `${hostId}/${runId}`;
  void window.parallax.request(hostId, "thread/remoteControl", { runId }).then((answer) => {
    if (!("result" in answer)) return;
    sessions.set(key, answer.result.session);
    for (const listener of watchers.get(key)?.listeners ?? []) listener();
  });
};

/**
 * Remote Control thread `runId`'s session on `hostId`, while `enabled` (the host's plxd has
 * `claudeRemoteControl`): read as it shows, again each time `status`, its run's, changes, and
 * every `REMOTE_CONTROL_POLL_MS` while shown.
 */
export function useRemoteControl(
  hostId: string,
  runId: string | undefined,
  enabled: boolean,
  status?: string,
): RemoteControlSession | undefined {
  const key = enabled && runId ? `${hostId}/${runId}` : undefined;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key || !runId) return () => {};
      let watcher = watchers.get(key);
      if (!watcher) {
        read(hostId, runId);
        watcher = {
          listeners: new Set(),
          timer: setInterval(() => read(hostId, runId), REMOTE_CONTROL_POLL_MS),
        };
        watchers.set(key, watcher);
      }
      const watching = watcher;
      watching.listeners.add(listener);
      return () => {
        watching.listeners.delete(listener);
        if (watching.listeners.size > 0) return;
        clearInterval(watching.timer);
        watchers.delete(key);
      };
    },
    [key, hostId, runId],
  );
  const session = useSyncExternalStore(subscribe, () => (key ? sessions.get(key) : undefined));
  // Its run starting or settling changes what the session is doing.
  const last = useRef(status);
  useEffect(() => {
    if (last.current === status) return;
    last.current = status;
    if (key && runId) read(hostId, runId);
  }, [key, hostId, runId, status]);
  return session;
}
