import { Check, Download, Folder, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { ImportSource, ImportableSession, ProviderInfo } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { localId } from "./hosts";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { loadProviders, useProviders } from "./providers";
import { age } from "./Sidebar";
import { IconButton, segment } from "./ui";

/** The apps sessions import from, in the order they're listed. */
const apps: { source: ImportSource; name: string; Logo: typeof ClaudeLogo }[] = [
  { source: "claude", name: "Claude", Logo: ClaudeLogo },
  { source: "codex", name: "Codex", Logo: OpenAILogo },
  { source: "cursor", name: "Cursor", Logo: CursorLogo },
];

const keyOf = (s: ImportableSession) => `${s.source}:${s.id}`;

/**
 * The account an import from `source` runs its follow-ups on: that app's own agent when it's on,
 * else the first agent that is. With none, plxd picks the app's own.
 */
function accountFor(source: ImportSource, providers: ProviderInfo[] | undefined) {
  const on = providers?.filter((p) => p.instance.enabled);
  const info =
    on?.find((p) => p.instance.id === source) ??
    on?.find((p) => p.instance.kind === source) ??
    on?.[0];
  return info && ({ kind: "subscription", backend: info.instance.id } as const);
}

/**
 * This computer's past sessions from the Claude, Codex, and Cursor desktop apps (PLX-881), the
 * most recent first and filtered by app, to pick and import as archived threads
 * (`thread/importable`, `thread/import`). One already imported says so. Onboarding and Settings >
 * Threads' Import sessions show it.
 */
export function ImportSessions({ className = "" }: { className?: string }) {
  const connection = useConnection(localId);
  const providers = useProviders(localId)?.providers;
  const connected = connection?.status === "connected";
  const supported = connected && "threadImport" in connection.capabilities;
  const [sessions, setSessions] = useState<ImportableSession[]>();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [errors, setErrors] = useState<string[]>([]);
  const [filter, setFilter] = useState<ImportSource | "all">("all");
  const id = useId();

  const load = useCallback(async () => {
    const answer = await window.parallax.request(localId, "thread/importable", {});
    if ("error" in answer) setErrors([describeError(answer.error)]);
    else setSessions(answer.result.sessions);
  }, []);
  useEffect(() => {
    if (!supported) return;
    void load();
    // The agents imports run on: listed here, as Settings > Threads may be the first to need them.
    void loadProviders(localId);
  }, [supported, load]);

  const open = sessions?.filter((s) => !s.thread) ?? [];
  const toggle = (keys: string[], on: boolean) =>
    setPicked((now) => {
      const next = new Set(now);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const importPicked = async () => {
    const chosen = open.filter((s) => picked.has(keyOf(s)));
    const failed: string[] = [];
    setErrors([]);
    for (const [i, session] of chosen.entries()) {
      setProgress({ done: i, total: chosen.length });
      const account = accountFor(session.source, providers);
      const answer = await window.parallax.request(localId, "thread/import", {
        source: session.source,
        id: session.id,
        ...(account && { account }),
      });
      if ("error" in answer) failed.push(`${session.title}: ${describeError(answer.error)}`);
    }
    setProgress(undefined);
    setPicked(new Set());
    setErrors(failed);
    await load();
  };

  if (connection?.status === "failed" || (connected && !supported))
    return (
      <Notice className={className}>
        {connected
          ? "This computer's plxd can't import sessions yet. Update it, then try again."
          : "Parallax couldn't start on this computer, so it can't look for sessions."}
      </Notice>
    );
  if (!sessions && errors.length)
    return (
      <Notice className={className} alert>
        {errors[0]}
      </Notice>
    );
  if (!sessions)
    return (
      <Notice className={className}>
        <LoaderCircle aria-hidden className="mb-2 size-5 animate-spin text-faint-foreground" />
        Looking for sessions in Claude, Codex, and Cursor…
      </Notice>
    );
  if (sessions.length === 0)
    return (
      <Notice className={className}>
        <AppLogos className="mb-3" />
        No sessions from the Claude, Codex, or Cursor desktop apps on this computer.
      </Notice>
    );

  const busy = !!progress;
  const count = open.filter((s) => picked.has(keyOf(s))).length;
  const shown = sessions.filter((s) => filter === "all" || s.source === filter);
  const shownOpen = shown.filter((s) => !s.thread).map(keyOf);
  const allShown = shownOpen.length > 0 && shownOpen.every((key) => picked.has(key));
  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <fieldset
          aria-label="App"
          disabled={busy}
          className="flex gap-0.5 rounded-lg border border-border p-0.5"
        >
          {[{ source: "all" as const, name: "All" }, ...apps].map((app) => {
            const n =
              app.source === "all"
                ? sessions.length
                : sessions.filter((s) => s.source === app.source).length;
            if (n === 0) return null;
            return (
              <label key={app.source} className={segment}>
                <input
                  type="radio"
                  aria-label={app.name}
                  name={`${id}-app`}
                  checked={filter === app.source}
                  onChange={() => setFilter(app.source)}
                  className="sr-only"
                />
                {"Logo" in app && <app.Logo />}
                {app.name}
                <span className="text-faint-foreground tabular-nums">{n}</span>
              </label>
            );
          })}
        </fieldset>
        <button
          type="button"
          disabled={busy || shownOpen.length === 0}
          onClick={() => toggle(shownOpen, !allShown)}
          className="shrink-0 rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-50"
        >
          {allShown ? "Clear" : "Select all"}
        </button>
      </div>
      <ul
        aria-label="Sessions"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-xl border border-border bg-surface p-1"
      >
        {shown.map((s) => (
          <SessionRow
            key={keyOf(s)}
            session={s}
            picked={picked.has(keyOf(s))}
            disabled={busy}
            onToggle={(on) => toggle([keyOf(s)], on)}
          />
        ))}
      </ul>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p role="status" className="truncate text-[12.5px] text-muted-foreground">
            {progress
              ? `Importing ${progress.done + 1} of ${progress.total}…`
              : errors.length
                ? `${errors.length} couldn't be imported.`
                : count
                  ? `${count} selected`
                  : `${sessions.length - open.length} of ${sessions.length} imported`}
          </p>
          {progress && (
            <span className="mt-1.5 block h-1 max-w-48 overflow-hidden rounded-full bg-selected">
              <span
                style={{ width: `${((progress.done + 1) / progress.total) * 100}%` }}
                className="block h-full rounded-full bg-accent transition-[width] duration-300"
              />
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={busy || count === 0}
          onClick={() => void importPicked()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50 [&_svg]:size-3.5"
        >
          {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : <Download aria-hidden />}
          {count ? `Import ${count}` : "Import"}
        </button>
      </div>
      {errors.length > 0 && (
        <ul role="alert" className="text-[12.5px] text-danger">
          {errors.map((e) => (
            <li key={e} className="truncate">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A state with no list: loading, empty, or unavailable, centered in the list's place. */
function Notice({
  className,
  alert,
  children,
}: {
  className: string;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className={`flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-8 text-center text-[13px] ${alert ? "text-danger" : "text-muted-foreground"} ${className}`}
    >
      {children}
    </div>
  );
}

/** The three apps' logos, overlapping. */
function AppLogos({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`flex shrink-0 -space-x-1.5 ${className}`}>
      {apps.map(({ source, Logo }) => (
        <span
          key={source}
          className="grid size-8 place-items-center rounded-full border border-border bg-surface ring-2 ring-background"
        >
          <Logo className="size-4" />
        </span>
      ))}
    </span>
  );
}

/** One session: a box to pick it, its app, title, folder, and age, or Imported once it is. */
function SessionRow({
  session: s,
  picked,
  disabled,
  onToggle,
}: {
  session: ImportableSession;
  picked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const app = apps.find((a) => a.source === s.source)!;
  const folder = s.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return (
    <li>
      <label
        className={`flex items-center gap-3 rounded-lg px-2.5 py-2 ${s.thread ? "" : "cursor-pointer hover:bg-hover"} ${picked ? "bg-accent/8" : ""}`}
      >
        {s.thread ? (
          <span className="size-4 shrink-0" />
        ) : (
          <>
            <input
              type="checkbox"
              aria-label={`Import ${s.title}`}
              disabled={disabled}
              checked={picked}
              onChange={(e) => onToggle(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="grid size-4 shrink-0 place-items-center rounded-[5px] border border-faint-foreground/50 bg-background text-accent-foreground peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-ring [&_svg]:invisible peer-checked:[&_svg]:visible"
            >
              <Check className="size-3" strokeWidth={3} />
            </span>
          </>
        )}
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
          <app.Logo className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[13px] font-medium ${s.thread ? "text-muted-foreground" : ""}`}
          >
            {s.title}
          </span>
          <span className="flex items-center gap-1 truncate text-[12px] text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
            {folder && (
              <>
                <Folder aria-hidden />
                <span className="truncate">{folder}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="shrink-0">{age(s.updatedAt)}</span>
          </span>
        </span>
        {s.thread && (
          <span className="shrink-0 rounded-full bg-added/15 px-2 py-0.5 text-[11.5px] font-medium text-added">
            Imported
          </span>
        )}
      </label>
    </li>
  );
}

/** Settings > Threads' Import sessions: opens `ImportSessions` in a modal <dialog>. */
export function ImportButton() {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] font-medium hover:bg-hover [&_svg]:size-3.5"
      >
        <Download aria-hidden />
        Import sessions…
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        className="m-auto h-[38rem] max-h-[90vh] w-[38rem] max-w-[94vw] rounded-2xl border border-border bg-background text-foreground shadow-composer backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      >
        <div className="flex h-full flex-col px-6 pt-5 pb-5">
          <div className="mb-4 flex items-start gap-3">
            <AppLogos className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="font-brand text-[17px] font-semibold tracking-tight">
                Import sessions
              </h2>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                Bring past sessions from the Claude, Codex, and Cursor apps into Archived as
                threads.
              </p>
            </div>
            <IconButton label="Close" onClick={() => dialog.current?.close()}>
              <X aria-hidden />
            </IconButton>
          </div>
          {open && <ImportSessions className="min-h-0 flex-1" />}
        </div>
      </dialog>
    </>
  );
}
