import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  FileArchive,
  Folder,
  LoaderCircle,
  Lock,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import type { RemoteComputer, RemoteImportState } from "../preload/bridge";
import type { ImportSource, ImportableSession } from "../protocol/generated/protocol";
import { readExports, type ExportPart, type ExportedChat } from "./chatExports";
import { useConnection, useConnections } from "./ConnectionStatus";
import { DeviceIcon } from "./DeviceIcon";
import { describeError } from "./errors";
import { localId, useHosts } from "./hosts";
import { notify } from "./notifications";
import { ClaudeLogo, CursorLogo, OpenAILogo } from "./logos";
import { loadProviders, useProviders } from "./providers";
import { importAccount } from "./settings/shared";
import { age } from "./Sidebar";
import { IconButton, Picker, segment } from "./ui";

type App = { source: ImportSource; name: string; Logo: typeof ClaudeLogo };

/** The desktop apps sessions import from (PLX-881), in the order they're listed. */
const sessionApps: App[] = [
  { source: "claude", name: "Claude", Logo: ClaudeLogo },
  { source: "codex", name: "Codex", Logo: OpenAILogo },
  { source: "cursor", name: "Cursor", Logo: CursorLogo },
];

/** The exports chats import from (PLX-883). */
const chatApps: App[] = [
  { source: "chatgpt", name: "ChatGPT", Logo: OpenAILogo },
  { source: "claudeChat", name: "Claude", Logo: ClaudeLogo },
];

/** One row of `SessionList`: a session or a chat. */
type Item = {
  key: string;
  source: ImportSource;
  title: string;
  folder?: string | undefined;
  /** When it was last active, ISO. */
  at: string;
  /** Its thread, once imported. */
  thread?: string | undefined;
};

/**
 * Whether host `hostId`'s plxd can import, in words when it can't, naming it `name`; `undefined`
 * while connecting.
 */
function useImport(capability: "threadImport" | "chatImport", hostId = localId, name = "") {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && capability in connection.capabilities;
  const local = hostId === localId;
  const why =
    connection?.status === "failed"
      ? local
        ? "Parallax couldn't start on this computer, so it can't import."
        : `Parallax couldn't connect to ${name}, so it can't import.`
      : connected && !supported
        ? `${local ? "This computer" : name}'s plxd can't import these yet. Update it, then try again.`
        : undefined;
  useEffect(() => {
    // The agents imports run on: listed here, as Settings > Threads may be the first to need them.
    if (supported) void loadProviders(hostId);
  }, [supported, hostId]);
  return { supported, why, providers: useProviders(hostId)?.providers };
}

/**
 * A computer's past sessions from the Claude, Codex, and Cursor desktop apps, and its Claude Code
 * and Codex Remote Control sessions (PLX-881), the most recent first and filtered by app, to pick
 * and import as archived threads on it (`thread/importable`, `thread/import`). One already
 * imported says so. It starts on this computer, with a menu for any other connected one, and
 * Refresh lists them again. A computer that disconnects leaves the menu, and the dialog goes back
 * to this one. Onboarding and Settings > Threads' Import sessions show it.
 */
export function ImportSessions({ className = "" }: { className?: string }) {
  const all = useHosts();
  const states = useConnections(all.map((h) => h.id));
  const hosts = all.filter((h, i) => h.id === localId || states[i]?.status === "connected");
  const [hostId, setHostId] = useState(localId);
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0]!;
  const { supported, why, providers } = useImport("threadImport", host.id, host.name);
  const [sessions, setSessions] = useState<ImportableSession[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // The host shown, so an answer from one picked before it, or an import's reload there, is
  // dropped.
  const shown = useRef(host.id);

  const load = useCallback(async () => {
    const id = host.id;
    if (shown.current !== id) return;
    setLoading(true);
    const answer = await window.parallax.request(id, "thread/importable", {});
    if (shown.current !== id) return;
    setLoading(false);
    if ("error" in answer) {
      setSessions(undefined);
      setError(describeError(answer.error));
    } else {
      setError(undefined);
      setSessions(answer.result.sessions);
    }
  }, [host.id]);
  useEffect(() => {
    shown.current = host.id;
    setSessions(undefined);
    setError(undefined);
    setLoading(false);
    if (supported) void load();
  }, [host.id, supported, load]);

  const where = host.id === localId ? "this computer" : host.name;
  const bar = (
    <div className="flex items-center justify-between gap-3">
      {hosts.length > 1 ? (
        <span className="flex min-w-0 items-center gap-1.5 text-body text-muted-foreground">
          Sessions on
          <Picker
            label="Computer"
            value={host.id}
            onChange={setHostId}
            options={hosts.map((h) => ({ value: h.id, label: h.name }))}
            className="font-medium text-foreground"
          />
        </span>
      ) : (
        <span className="text-body font-medium">Sessions on this computer</span>
      )}
      <IconButton label="Refresh" disabled={!supported || loading} onClick={() => void load()}>
        <RefreshCw aria-hidden className={loading ? "animate-spin" : ""} />
      </IconButton>
    </div>
  );
  let body: ReactNode;
  if (why) body = <Notice className="min-h-0 flex-1">{why}</Notice>;
  else if (!sessions && error)
    body = (
      <Notice className="min-h-0 flex-1" alert>
        {error}
      </Notice>
    );
  else if (!sessions)
    body = (
      <Notice className="min-h-0 flex-1">
        <LoaderCircle aria-hidden className="mb-2 size-5 animate-spin text-faint-foreground" />
        Looking for sessions in Claude, Codex, and Cursor…
      </Notice>
    );
  else if (sessions.length === 0)
    body = (
      <Notice className="min-h-0 flex-1">
        <AppLogos apps={sessionApps} className="mb-3" />
        No sessions from Claude, Codex, or Cursor on {where}.
      </Notice>
    );
  else
    body = (
      <SessionList
        key={host.id}
        className="min-h-0 flex-1"
        apps={sessionApps}
        items={sessions.map((s) => ({
          key: `${s.source}:${s.id}`,
          source: s.source,
          title: s.title,
          folder: s.cwd?.split(/[\\/]/).filter(Boolean).pop(),
          at: s.updatedAt,
          thread: s.thread,
        }))}
        importItem={async (item) => {
          const session = sessions.find((s) => `${s.source}:${s.id}` === item.key)!;
          const account = importAccount(session.source, providers);
          const answer = await window.parallax.request(host.id, "thread/import", {
            source: session.source,
            id: session.id,
            ...(account && { account }),
          });
          return "error" in answer ? describeError(answer.error) : undefined;
        }}
        onImported={load}
      />
    );
  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      {bar}
      {body}
    </div>
  );
}

/**
 * Chats from a ChatGPT or Claude data export (PLX-883): first asks for the export's .zip, then
 * lists its chats as `ImportSessions` lists sessions, to import as archived threads with no repo
 * (`thread/importChat`, `thread/importedChats`).
 */
function ImportChats({ className = "" }: { className?: string }) {
  const { supported, why, providers } = useImport("chatImport");
  const [chats, setChats] = useState<ExportedChat[]>();
  const [file, setFile] = useState<string>();
  const [threads, setThreads] = useState<(string | null)[]>([]);
  const [reading, setReading] = useState(false);
  // A Claude export manifest's conversations parts, still to download (PLX-890).
  const [parts, setParts] = useState<ExportPart[]>([]);

  // Which of `list` are imported. Throws, in words, when plxd can't say, so no chat is marked by
  // another export's answer.
  const refresh = async (list: ExportedChat[]) => {
    const answer = await window.parallax.request(localId, "thread/importedChats", {
      chats: list.map(({ source, id, createdAt }) => ({ source, id, createdAt })),
    });
    if ("error" in answer) throw new Error(describeError(answer.error));
    setThreads(answer.result.threads);
  };
  const open = async (picked: File[]) => {
    if (!picked.length) return;
    setReading(true);
    try {
      const read = await readExports(picked);
      setParts(read.parts);
      if (read.chats.length) {
        await refresh(read.chats);
        setChats(read.chats);
        setFile(picked.map((f) => f.name).join(", "));
      }
    } catch (e) {
      chatsFailed("Couldn't read the export", e);
    }
    setReading(false);
  };

  if (why) return <Notice className={className}>{why}</Notice>;
  if (!supported)
    return (
      <Notice className={className}>
        <LoaderCircle aria-hidden className="size-5 animate-spin text-faint-foreground" />
      </Notice>
    );
  if (!chats)
    return (
      <ExportDrop
        className={className}
        reading={reading}
        parts={parts}
        onFiles={(files) => void open(files)}
      />
    );
  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      <p className="flex items-center gap-2 text-body text-muted-foreground [&_svg]:size-3.5">
        <FileArchive aria-hidden className="shrink-0" />
        <span className="min-w-0 truncate">{file}</span>
        <button
          type="button"
          onClick={() => {
            setChats(undefined);
            setThreads([]);
          }}
          className="shrink-0 rounded-md px-1.5 py-0.5 font-medium hover:bg-hover hover:text-foreground"
        >
          Choose another
        </button>
      </p>
      <SessionList
        className="min-h-0 flex-1"
        apps={chatApps}
        items={chats.map((c, i) => ({
          key: `${c.source}:${c.id}`,
          source: c.source,
          title: c.title,
          at: c.updatedAt,
          thread: threads[i] ?? undefined,
        }))}
        importItem={async (item) => {
          const chat = chats.find((c) => `${c.source}:${c.id}` === item.key)!;
          const account = importAccount(chat.source, providers);
          const answer = await window.parallax.request(localId, "thread/importChat", {
            ...chat,
            ...(account && { account }),
          });
          return "error" in answer ? describeError(answer.error) : undefined;
        }}
        onImported={() =>
          refresh(chats).catch((e: unknown) => chatsFailed("Couldn't check the imported chats", e))
        }
      />
    </div>
  );
}

/** Says why reading an export or checking its chats failed. */
function chatsFailed(title: string, e: unknown) {
  notify({
    key: "import-chats",
    tone: "error",
    title,
    body: e instanceof Error ? e.message : String(e),
  });
}

/**
 * Asks for an export's files, by drop or by Choose, and says how to get them. With `parts`, from
 * a Claude export manifest, it links each to download first.
 */
function ExportDrop({
  className,
  reading,
  parts,
  onFiles,
}: {
  className: string;
  reading: boolean;
  parts: ExportPart[];
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFiles([...e.dataTransfer.files]);
  };
  return (
    <div className={`flex min-h-0 flex-col gap-4 overflow-y-auto ${className}`}>
      {parts.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-4 text-body">
          <p className="flex items-center gap-1.5 text-body font-medium [&_svg]:size-3.5">
            <ClaudeLogo />
            That&apos;s Claude&apos;s export manifest
          </p>
          <p className="mt-1 text-muted-foreground">
            Your chats are in {parts.length === 1 ? "this part" : "these parts"}. Download{" "}
            {parts.length === 1 ? "it" : "each"} in your browser, then drop the .zip below.
            Claude&apos;s links expire a day after the export, and may work only once.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {parts.map((part) => (
              <li key={part.url}>
                <button
                  type="button"
                  onClick={() => window.open(part.url, "_blank")}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 font-medium hover:bg-hover [&_svg]:size-3.5"
                >
                  <Download aria-hidden />
                  {part.filename}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={`flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors ${over ? "border-accent bg-accent/8" : "border-border"}`}
      >
        <AppLogos apps={chatApps} className="mb-3" />
        <p className="text-body font-medium">
          {parts.length ? "Now drop the downloaded .zip here" : "Drop your export's .zip here"}
        </p>
        <p className="mt-1 text-body text-muted-foreground">
          From ChatGPT or Claude. Each emails you a link to it once it's ready.
        </p>
        <input
          ref={input}
          type="file"
          accept=".zip,.json,.jsonl,application/zip"
          multiple
          aria-label="Export .zip"
          className="sr-only"
          onChange={(e) => {
            onFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={reading}
          onClick={() => input.current?.click()}
          className="mt-4 flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50 [&_svg]:size-3.5"
        >
          {reading ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <FileArchive aria-hidden />
          )}
          {reading ? "Reading…" : "Choose .zip…"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 text-body">
        {[
          {
            app: chatApps[0]!,
            steps: "Settings › Data controls › Export data. ChatGPT emails you a link to the .zip.",
          },
          {
            app: chatApps[1]!,
            steps:
              "Settings › Privacy › Export data. Claude emails you a manifest: drop it here to get your chats' download.",
          },
        ].map(({ app, steps }) => (
          <div key={app.source} className="rounded-xl border border-border bg-surface p-3">
            <p className="mb-1 flex items-center gap-1.5 font-medium [&_svg]:size-3.5">
              <app.Logo />
              From {app.name}
            </p>
            <p className="text-muted-foreground">{steps}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * `items` to pick and import, the newest first, filtered by `apps`, with Select all, a count, and
 * progress while `importItem` imports each picked one in turn, answering an error in words or
 * nothing. `onImported` then lists them again.
 */
function SessionList({
  className,
  apps,
  items,
  importItem,
  onImported,
}: {
  className: string;
  apps: App[];
  items: Item[];
  importItem: (item: Item) => Promise<string | undefined>;
  onImported: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [filter, setFilter] = useState<ImportSource | "all">("all");
  const id = useId();

  const open = items.filter((s) => !s.thread);
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
    const chosen = open.filter((s) => picked.has(s.key));
    const failed: string[] = [];
    for (const [i, item] of chosen.entries()) {
      setProgress({ done: i, total: chosen.length });
      const error = await importItem(item);
      if (error) failed.push(`${item.title}: ${error}`);
    }
    setProgress(undefined);
    setPicked(new Set());
    if (failed.length)
      notify({
        key: "import",
        tone: "error",
        title: `${failed.length} couldn't be imported`,
        body: failed.join("\n"),
      });
    await onImported();
  };

  const busy = !!progress;
  const count = open.filter((s) => picked.has(s.key)).length;
  const shown = items.filter((s) => filter === "all" || s.source === filter);
  const shownOpen = shown.filter((s) => !s.thread).map((s) => s.key);
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
                ? items.length
                : items.filter((s) => s.source === app.source).length;
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
          className="shrink-0 rounded-md px-2 py-1 text-body font-medium text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-50"
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
            key={s.key}
            item={s}
            app={apps.find((a) => a.source === s.source)!}
            picked={picked.has(s.key)}
            disabled={busy}
            onToggle={(on) => toggle([s.key], on)}
          />
        ))}
      </ul>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p role="status" className="truncate text-body text-muted-foreground">
            {progress
              ? `Importing ${progress.done + 1} of ${progress.total}…`
              : count
                ? `${count} selected`
                : `${items.length - open.length} of ${items.length} imported`}
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
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50 [&_svg]:size-3.5"
        >
          {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : <Download aria-hidden />}
          {count ? `Import ${count}` : "Import"}
        </button>
      </div>
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
      className={`flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-8 text-center text-body ${alert ? "text-danger" : "text-muted-foreground"} ${className}`}
    >
      {children}
    </div>
  );
}

/** The three apps' logos, overlapping. */
function AppLogos({ apps, className = "" }: { apps: App[]; className?: string }) {
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

/** One session or chat: a box to pick it, its app, title, folder, and age, or Imported. */
function SessionRow({
  item: s,
  app,
  picked,
  disabled,
  onToggle,
}: {
  item: Item;
  app: App;
  picked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <li>
      <label
        className={`flex items-center gap-3 rounded-lg px-2.5 py-2 ${s.thread ? "" : "cursor-pointer hover:bg-hover"} ${picked ? "bg-accent/8" : ""}`}
      >
        {s.thread ? (
          <span className="size-4 shrink-0" />
        ) : (
          <PickBox
            label={`Import ${s.title}`}
            disabled={disabled}
            picked={picked}
            onToggle={onToggle}
          />
        )}
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
          <app.Logo className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-body font-medium ${s.thread ? "text-muted-foreground" : ""}`}
          >
            {s.title}
          </span>
          <span className="flex items-center gap-1 truncate text-meta text-faint-foreground [&_svg]:size-3 [&_svg]:shrink-0">
            {s.folder && (
              <>
                <Folder aria-hidden />
                <span className="truncate">{s.folder}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="shrink-0">{age(s.at)}</span>
          </span>
        </span>
        {s.thread && (
          <span className="shrink-0 rounded-full bg-added/15 px-2 py-0.5 text-meta font-medium text-added">
            Imported
          </span>
        )}
      </label>
    </li>
  );
}

/** A row's checkbox, inside its `<label>`. */
function PickBox({
  label,
  disabled,
  picked,
  onToggle,
}: {
  label: string;
  disabled: boolean;
  picked: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <>
      <input
        type="checkbox"
        aria-label={label}
        disabled={disabled}
        checked={picked}
        onChange={(e) => onToggle(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center rounded-sm border border-faint-foreground/50 bg-background text-accent-foreground peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-disabled:opacity-40 [&_svg]:invisible peer-checked:[&_svg]:visible"
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    </>
  );
}

/** The helper model each import through Claude runs on (PLX-1136). */
const helperModel = "Haiku 5.5";

/**
 * Prototype (PLX-1136): the user's other computers that ran Claude Code with Remote Control, to
 * pick and import by asking Claude there for a copy. Claude asks the user to confirm, showing a
 * code Parallax shows too. Hidden unless the bridge has `remoteImport`, which only the renderer
 * preview fakes.
 */
function RemoteComputers() {
  const source = window.parallax.remoteImport;
  const [computers, setComputers] = useState<RemoteComputer[]>();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [states, setStates] = useState<Record<string, RemoteImportState>>({});
  const dialog = useRef<HTMLDialogElement>(null);
  const cancels = useRef(new Map<string, () => void>());
  const titleId = useId();
  useEffect(() => {
    void source?.computers().then(setComputers);
    const running = cancels.current;
    return () => {
      for (const cancel of running.values()) cancel();
    };
  }, [source]);
  if (!source || !computers?.length) return null;

  const start = (names: string[]) => {
    dialog.current?.close();
    setPicked(new Set());
    for (const name of names) {
      cancels.current.get(name)?.();
      cancels.current.set(
        name,
        source.start(name, (state) => setStates((old) => ({ ...old, [name]: state }))),
      );
    }
  };
  const idle = (c: RemoteComputer) => {
    const s = states[c.name]?.state;
    return c.online && (s === undefined || s === "failed");
  };
  const chosen = computers.filter((c) => picked.has(c.name) && idle(c));
  const names = (list: RemoteComputer[]) =>
    list.length === 1 ? list[0]!.name : `${list.length} computers`;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={titleId} className="text-body font-medium">
          Sessions on your other computers
        </h3>
        <span className="flex items-center gap-1 text-meta text-faint-foreground [&_svg]:size-3">
          <ClaudeLogo aria-hidden />
          Remote Control sessions, through Claude
        </span>
      </div>
      <ul
        aria-label="Other computers"
        className="flex flex-col gap-0.5 rounded-xl border border-border bg-surface p-1"
      >
        {computers.map((c) => (
          <RemoteComputerRow
            key={c.name}
            computer={c}
            state={states[c.name]}
            picked={picked.has(c.name)}
            pickable={idle(c)}
            onToggle={(on) =>
              setPicked((old) => {
                const next = new Set(old);
                if (on) next.add(c.name);
                else next.delete(c.name);
                return next;
              })
            }
            onRetry={() => start([c.name])}
          />
        ))}
      </ul>
      <div className="flex items-center justify-between gap-4">
        <p className="min-w-0 flex-1 truncate text-body text-muted-foreground">
          Parallax asks Claude on each computer for a copy.
        </p>
        <button
          type="button"
          disabled={chosen.length === 0}
          onClick={() => dialog.current?.showModal()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50 [&_svg]:size-3.5"
        >
          <Download aria-hidden />
          {chosen.length ? `Import from ${names(chosen)}` : "Import"}
        </button>
      </div>
      {/* Onboarding is a <dialog> too, and React passes this one's close up to its onClose. */}
      <dialog
        ref={dialog}
        onClose={(e) => e.stopPropagation()}
        aria-labelledby={`${titleId}-dialog`}
        className="m-auto w-[28rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <form method="dialog" className="px-5 pt-4 pb-4">
          <h2 id={`${titleId}-dialog`} className="text-reading font-semibold">
            Import from {names(chosen)} through Claude?
          </h2>
          <ul className="mt-3 flex flex-col gap-2.5 text-body text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-faint-foreground">
            <li className="flex gap-2.5">
              <ClaudeLogo aria-hidden />
              <span>
                A Parallax helper session on {helperModel} asks a Claude session on{" "}
                {chosen.length === 1 ? "that computer" : "each computer"} for a copy. It uses your
                Claude plan.
              </span>
            </li>
            <li className="flex gap-2.5">
              <ShieldCheck aria-hidden />
              <span>
                Claude there asks you to confirm, with a code that Parallax shows here. Say yes only
                if the codes match.
              </span>
            </li>
            <li className="flex gap-2.5">
              <Lock aria-hidden />
              <span>
                The sessions are encrypted so only Parallax on this computer can read them. Nothing
                on {chosen.length === 1 ? "that computer" : "those computers"} changes.
              </span>
            </li>
          </ul>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="submit"
              value="cancel"
              className="rounded-md px-3 py-1.5 text-body hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => start(chosen.map((c) => c.name))}
              className="rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground hover:opacity-90"
            >
              Import
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

/** One of `RemoteComputers`' computers, with its import's progress. */
function RemoteComputerRow({
  computer: c,
  state,
  picked,
  pickable,
  onToggle,
  onRetry,
}: {
  computer: RemoteComputer;
  state: RemoteImportState | undefined;
  picked: boolean;
  pickable: boolean;
  onToggle: (on: boolean) => void;
  onRetry: () => void;
}) {
  const sessions = `${c.sessions} ${c.sessions === 1 ? "session" : "sessions"}`;
  let line: ReactNode = (
    <>
      <span>{sessions}</span>
      <span aria-hidden>·</span>
      <span>{c.online ? age(c.lastActive) : `offline, last seen ${age(c.lastActive)}`}</span>
    </>
  );
  let end: ReactNode = null;
  switch (state?.state) {
    case "asking":
      line = <span>Asking Claude on {c.name}…</span>;
      end = <LoaderCircle aria-hidden className="size-4 animate-spin text-faint-foreground" />;
      break;
    case "confirm":
      line = (
        <span className="text-foreground">
          Claude on {c.name} is asking you to confirm. Say yes if it shows this code.
        </span>
      );
      end = (
        <span className="flex items-center gap-2">
          <span
            aria-label={`Code ${state.code.split("").join(" ")}`}
            className="rounded-md border border-border bg-background px-2 py-0.5 font-mono text-body font-semibold tracking-[0.2em]"
          >
            {state.code}
          </span>
          <a
            href={state.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-md bg-selected px-2.5 py-1 text-body font-medium hover:bg-hover [&_svg]:size-3.5"
          >
            Open in Claude
            <ExternalLink aria-hidden />
          </a>
        </span>
      );
      break;
    case "receiving":
      line = <span>Receiving {sessions}…</span>;
      end = <LoaderCircle aria-hidden className="size-4 animate-spin text-faint-foreground" />;
      break;
    case "done":
      line = (
        <span>
          {state.imported} {state.imported === 1 ? "session" : "sessions"} in Archived
        </span>
      );
      end = (
        <span className="shrink-0 rounded-full bg-added/15 px-2 py-0.5 text-meta font-medium text-added">
          Imported
        </span>
      );
      break;
    case "failed":
      line = <span className="text-danger">{state.message}</span>;
      end = (
        <IconButton label="Try again" onClick={onRetry}>
          <RotateCw aria-hidden />
        </IconButton>
      );
      break;
  }
  return (
    <li>
      <label
        className={`flex items-center gap-3 rounded-lg px-2.5 py-2 ${pickable ? "cursor-pointer hover:bg-hover" : ""} ${picked && pickable ? "bg-accent/8" : ""}`}
      >
        {state?.state === "done" ? (
          <span className="size-4 shrink-0" />
        ) : (
          <PickBox
            label={`Import from ${c.name}`}
            disabled={!pickable}
            picked={picked && pickable}
            onToggle={onToggle}
          />
        )}
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
          <DeviceIcon icon={c.icon} className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-body font-medium ${c.online ? "" : "text-muted-foreground"}`}
          >
            {c.name}
          </span>
          <span className="flex items-center gap-1 text-meta text-faint-foreground">{line}</span>
        </span>
        {end}
      </label>
    </li>
  );
}

/** What `ImportButton` opens: this computer's app sessions, or an export's chats. */
const imports = {
  sessions: {
    label: "Import sessions…",
    title: "Import sessions",
    line: "Bring past sessions from the Claude, Codex, and Cursor apps and Remote Control into Archived as threads.",
    apps: sessionApps,
    List: ImportSessions,
  },
  chats: {
    label: "Import chats…",
    title: "Import chats",
    line: "Bring chats from a ChatGPT or Claude data export into Archived as threads.",
    apps: chatApps,
    List: ImportChats,
  },
};

/** Settings > Threads' Import sessions and Import chats: opens `what` in a modal <dialog>. */
export function ImportButton({ what }: { what: keyof typeof imports }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const { label, title, line, apps, List } = imports[what];
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-body font-medium hover:bg-hover [&_svg]:size-3.5"
      >
        <Download aria-hidden />
        {label}
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        className="m-auto h-[38rem] max-h-[90vh] w-[38rem] max-w-[94vw] rounded-xl border border-border bg-background text-foreground shadow-composer backdrop:bg-black/50 backdrop:backdrop-blur-sm"
      >
        <div className="flex h-full flex-col px-6 pt-5 pb-5">
          <div className="mb-4 flex items-start gap-3">
            <AppLogos apps={apps} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-heading font-semibold tracking-tight">
                {title}
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">{line}</p>
            </div>
            <IconButton label="Close" onClick={() => dialog.current?.close()}>
              <X aria-hidden />
            </IconButton>
          </div>
          {open && <List className="min-h-0 flex-1" />}
        </div>
      </dialog>
    </>
  );
}

/**
 * Onboarding's import step (PLX-881): the app sessions, with a way over to an export's chats
 * (PLX-883) and back.
 */
export function ImportStepBody({ className = "" }: { className?: string }) {
  const [chats, setChats] = useState(false);
  const link =
    "flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-body font-medium text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5";
  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      {chats ? (
        <>
          <button type="button" onClick={() => setChats(false)} className={link}>
            <ArrowLeft aria-hidden />
            Back to app sessions
          </button>
          <ImportChats className="min-h-0 flex-1" />
        </>
      ) : (
        <>
          <ImportSessions className="min-h-64 flex-1" />
          <RemoteComputers />
          <button type="button" onClick={() => setChats(true)} className={link}>
            <FileArchive aria-hidden />
            Import ChatGPT or Claude chats from an export…
          </button>
        </>
      )}
    </div>
  );
}
