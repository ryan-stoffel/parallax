import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  MessageCircleQuestion,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { behaviorPrefs } from "./prefs";

// Every notification the app shows (PLX-507): one stack of toasts in the window's top right, in
// the update toast's look. Anything can call `notify`; App draws the stack once. A message about
// what an action did goes here, not in a line under the control that ran it (PLX-930).

/** A notice's color and icon: done, waiting on the user, gone wrong, or just news. */
type Tone = "success" | "attention" | "error" | "info";

export type Notice = {
  /**
   * A notice with the same key replaces this one, as a reconnect replaces a lost connection, in
   * the same toast, so a notice can update as work goes on.
   */
  key?: string;
  tone: Tone;
  title: string;
  body?: string;
  /** The underlined link after the body: a page to open, or something to do in the app. */
  action?: { label: string; href: string } | { label: string; run: () => void };
  /**
   * Work under way: a spinner, and a bar at `percent`, or pulsing without one. `update` it by its
   * key as it goes, and replace it with another or `dismiss` it once it's done.
   */
  progress?: { percent?: number };
  /**
   * Stays until closed. Defaults to true for attention, error, and work under way, which ask
   * something of the user or aren't done.
   */
  sticky?: boolean;
  /** Also an OS notification while the window isn't focused. Clicking it runs `action`. */
  system?: boolean;
};

type Shown = Notice & { id: number };

/** How long a notice that isn't sticky stays. */
export const NOTICE_MS = 8000;
/** The most notices on screen; a newer one pushes out the oldest. */
const MAX_SHOWN = 4;

let shown: readonly Shown[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function set(next: readonly Shown[]) {
  shown = next;
  for (const listener of listeners) listener();
}

/** Shows `notice` on top of the stack, in place of any with its key. */
export function notify(notice: Notice) {
  // Settings > General turns off the OS alerts and the toasts of notices that have an OS alert.
  const { systemNotifications, inAppNotifications } = behaviorPrefs.get();
  if (notice.system && !document.hasFocus() && systemNotifications) {
    const note = new Notification(notice.title, { body: notice.body });
    note.onclick = () => {
      window.focus();
      if (notice.action && "run" in notice.action) notice.action.run();
    };
  }
  if (notice.system && !inAppNotifications) return;
  // The notice it replaces keeps its toast, which only moves to the top.
  const replaced = notice.key === undefined ? undefined : shown.find((n) => n.key === notice.key);
  const kept = shown.filter((n) => n !== replaced);
  set([{ ...notice, id: replaced?.id ?? nextId++ }, ...kept].slice(0, MAX_SHOWN));
}

/**
 * Replaces the notice with `notice`'s key in place, while it's shown: work that goes on updates its
 * notice without bringing back one the user closed.
 */
export function update(notice: Notice & { key: string }) {
  const replaced = shown.find((n) => n.key === notice.key);
  if (replaced) set(shown.map((n) => (n === replaced ? { ...notice, id: replaced.id } : n)));
}

/** Closes the notice with `key`, if one is shown, as when the work it followed is done. */
export function dismiss(key: string) {
  set(shown.filter((n) => n.key !== key));
}

const close = (id: number) => set(shown.filter((n) => n.id !== id));

const icons: Record<Tone, ReactNode> = {
  success: <CircleCheck className="size-4 shrink-0 text-added" />,
  attention: <MessageCircleQuestion className="size-4 shrink-0 text-warning" />,
  error: <CircleAlert className="size-4 shrink-0 text-danger" />,
  info: <Info className="size-4 shrink-0 text-accent" />,
};

const link =
  "inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-4 hover:text-foreground";

// A manual popover sits in the top layer, above dialogs opened before it. The stack mounts only
// while it has notices, so it shows once per mount.
const show = (stack: HTMLDivElement | null) => stack?.showPopover();

/** The stack of notices, newest on top. App renders it once. */
export function Notifications() {
  const list = useSyncExternalStore(subscribe, () => shown);
  if (list.length === 0) return null;
  return (
    <div
      ref={show}
      popover="manual"
      role="region"
      aria-label="Notifications"
      className="inset-auto top-16 right-4 m-0 flex w-80 flex-col gap-2 overflow-visible border-0 bg-transparent p-0"
    >
      {list.map((n) => (
        <Toast key={n.id} notice={n} onClose={() => close(n.id)} />
      ))}
    </div>
  );
}

/**
 * One notice. One that isn't sticky closes `NOTICE_MS` after it shows, or after the pointer or
 * focus last left it.
 */
function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const { tone, title, body, action, progress } = notice;
  const sticky = notice.sticky ?? (tone === "attention" || tone === "error" || !!progress);
  const [held, setHeld] = useState(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (sticky || held) return;
    const timer = window.setTimeout(() => close.current(), NOTICE_MS);
    return () => window.clearTimeout(timer);
    // A notice that replaces this one gets its own time.
  }, [sticky, held, notice]);
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
      className="toast-in relative rounded-xl border border-border bg-surface py-3 pr-9 pl-3.5 text-foreground shadow-composer"
    >
      <div className="flex items-center gap-2 text-body font-medium">
        {progress ? (
          <LoaderCircle
            aria-hidden
            className="size-4 shrink-0 animate-spin text-muted-foreground"
          />
        ) : (
          icons[tone]
        )}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {progress?.percent !== undefined && (
          <span className="text-body font-normal text-muted-foreground tabular-nums">
            {progress.percent}%
          </span>
        )}
      </div>
      {body && (
        <p className="mt-1 line-clamp-3 text-body break-words text-muted-foreground">{body}</p>
      )}
      {progress && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-hover">
          <div
            className={`h-full rounded-full bg-accent transition-[width] duration-500 ${progress.percent === undefined ? "w-1/4 animate-pulse" : ""}`}
            style={progress.percent === undefined ? undefined : { width: `${progress.percent}%` }}
          />
        </div>
      )}
      {action && (
        <div className="mt-1 text-body text-muted-foreground">
          {"href" in action ? (
            <a href={action.href} className={link}>
              {action.label}
              <ArrowUpRight className="size-3" />
            </a>
          ) : (
            <button
              type="button"
              className={link}
              onClick={() => {
                onClose();
                action.run();
              }}
            >
              {action.label}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-2 right-2 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
