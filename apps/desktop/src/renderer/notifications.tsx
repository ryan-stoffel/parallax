import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  Info,
  MessageCircleQuestion,
  X,
} from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

// Every notification the app shows (PLX-507): one stack of toasts in the window's top right, in
// the update toast's look. Anything can call `notify`; App draws the stack once.

/** A notice's color and icon: done, waiting on the user, gone wrong, or just news. */
export type Tone = "success" | "attention" | "error" | "info";

export type Notice = {
  /** A notice with the same key replaces this one, as a reconnect replaces a lost connection. */
  key?: string;
  tone: Tone;
  title: string;
  body?: string;
  /** The underlined link after the body: a page to open, or something to do in the app. */
  action?: { label: string; href: string } | { label: string; run: () => void };
  /** Stays until closed. Defaults to true for attention and error, which ask something of the user. */
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
const timers = new Map<number, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function set(next: readonly Shown[]) {
  for (const [id, timer] of timers)
    if (!next.some((n) => n.id === id)) {
      window.clearTimeout(timer);
      timers.delete(id);
    }
  shown = next;
  for (const listener of listeners) listener();
}

/** Shows `notice` on top of the stack, in place of any with its key. */
export function notify(notice: Notice) {
  const id = nextId++;
  const kept = shown.filter((n) => notice.key === undefined || n.key !== notice.key);
  set([{ ...notice, id }, ...kept].slice(0, MAX_SHOWN));
  const sticky = notice.sticky ?? (notice.tone === "attention" || notice.tone === "error");
  if (!sticky)
    timers.set(
      id,
      window.setTimeout(() => close(id), NOTICE_MS),
    );
  if (notice.system && !document.hasFocus()) {
    const note = new Notification(notice.title, { body: notice.body });
    note.onclick = () => {
      window.focus();
      if (notice.action && "run" in notice.action) notice.action.run();
    };
  }
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

function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const { tone, title, body, action } = notice;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="toast-in relative rounded-xl border border-border bg-surface py-3 pr-9 pl-3.5 text-foreground shadow-composer"
    >
      <div className="flex items-center gap-2 text-[13.5px] font-medium">
        {icons[tone]}
        <span className="truncate">{title}</span>
      </div>
      {(body || action) && (
        <p className="mt-1 line-clamp-3 text-[12.5px] break-words text-muted-foreground">
          {body}
          {body && action && " "}
          {action &&
            ("href" in action ? (
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
            ))}
        </p>
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
