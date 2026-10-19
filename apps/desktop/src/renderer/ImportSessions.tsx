import { Check, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { ImportSource, ImportableSession, ProviderInfo } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { localId } from "./hosts";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { loadProviders, useProviders } from "./providers";
import { age } from "./Sidebar";

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
 * This computer's past sessions from the Claude, Codex, and Cursor desktop apps (PLX-881), by
 * app, to pick and import as threads (`thread/importable`, `thread/import`). One already
 * imported is checked off. Onboarding and Settings > Threads' Import sessions show it.
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
      <p
        className={`rounded-xl border border-border bg-surface px-4 py-3 text-[13px] ${className}`}
      >
        {connected
          ? "This computer's plxd can't import sessions yet. Update it, then try again."
          : "Parallax couldn't start on this computer, so it can't look for sessions."}
      </p>
    );
  if (!sessions)
    return (
      <p
        role="status"
        className={`flex items-center gap-2 text-[13px] text-muted-foreground ${className}`}
      >
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Looking for sessions in Claude, Codex, and Cursor…
      </p>
    );
  if (sessions.length === 0)
    return (
      <p
        className={`rounded-xl border border-border bg-surface px-4 py-3 text-[13px] ${className}`}
      >
        No sessions from the Claude, Codex, or Cursor desktop apps on this computer.
      </p>
    );

  const busy = !!progress;
  const count = open.filter((s) => picked.has(keyOf(s))).length;
  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface">
        {apps.map((app) => (
          <AppGroup
            key={app.source}
            app={app}
            sessions={sessions.filter((s) => s.source === app.source)}
            picked={picked}
            disabled={busy}
            onToggle={toggle}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="min-w-0 truncate text-[12.5px] text-muted-foreground">
          {progress
            ? `Importing ${progress.done + 1} of ${progress.total}…`
            : errors.length
              ? `${errors.length} couldn't be imported.`
              : `${sessions.length - open.length} of ${sessions.length} imported`}
        </p>
        <button
          type="button"
          disabled={busy || count === 0}
          onClick={() => void importPicked()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
        >
          {busy && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
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

/** One app's sessions, under a heading whose box picks all of them that aren't imported. */
function AppGroup({
  app,
  sessions,
  picked,
  disabled,
  onToggle,
}: {
  app: (typeof apps)[number];
  sessions: ImportableSession[];
  picked: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (keys: string[], on: boolean) => void;
}) {
  const all = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const open = sessions.filter((s) => !s.thread).map(keyOf);
  const chosen = open.filter((key) => picked.has(key)).length;
  useEffect(() => {
    if (all.current) all.current.indeterminate = chosen > 0 && chosen < open.length;
  });
  if (sessions.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="border-border not-last:border-b">
      <label className="sticky top-0 flex items-center gap-2.5 bg-surface px-4 py-2 text-[12.5px] font-medium">
        <input
          ref={all}
          type="checkbox"
          aria-label={`Select all from ${app.name}`}
          disabled={disabled || open.length === 0}
          checked={open.length > 0 && chosen === open.length}
          onChange={(e) => onToggle(open, e.target.checked)}
        />
        <app.Logo className="size-3.5" />
        <span id={headingId}>{app.name}</span>
        <span className="text-faint-foreground">{sessions.length}</span>
      </label>
      <ul>
        {sessions.map((s) => {
          const key = keyOf(s);
          const folder = s.cwd?.split(/[\\/]/).filter(Boolean).pop();
          return (
            <li key={key}>
              <label className="flex items-center gap-2.5 px-4 py-1.5 hover:bg-hover">
                {s.thread ? (
                  <Check aria-label="Imported" className="size-3.5 shrink-0 text-added" />
                ) : (
                  <input
                    type="checkbox"
                    aria-label={`Import ${s.title}`}
                    disabled={disabled}
                    checked={picked.has(key)}
                    onChange={(e) => onToggle([key], e.target.checked)}
                  />
                )}
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${s.thread ? "text-muted-foreground" : ""}`}
                >
                  {s.title}
                </span>
                <span className="shrink-0 text-[12px] text-faint-foreground">
                  {folder ? `${folder} · ` : ""}
                  {age(s.updatedAt)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
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
        className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-[12.5px] font-medium hover:bg-hover"
      >
        Import sessions…
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        className="m-auto h-[34rem] max-h-[90vh] w-[36rem] max-w-[94vw] rounded-xl border border-border bg-background text-foreground shadow-composer backdrop:bg-black/50"
      >
        <div className="flex h-full flex-col px-5 pt-4 pb-4">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-[15px] font-semibold">
                Import sessions
              </h2>
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                Pick past sessions from the Claude, Codex, and Cursor apps to continue as threads.
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="rounded-md px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Done
            </button>
          </div>
          {open && <ImportSessions className="min-h-0 flex-1" />}
        </div>
      </dialog>
    </>
  );
}
