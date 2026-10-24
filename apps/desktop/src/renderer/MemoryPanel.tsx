import { CircleAlert, Clock, FileText, Lightbulb } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { MemoryFile, MemoryKind, MemoryScope } from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";
import { dayLabel } from "./locale";
import { dismiss, notify } from "./notifications";

/**
 * A memory file with the scope it was listed from. `stale` is PLX-407's review mark, read when
 * plxd sends it.
 */
export type Memory = MemoryFile & { scope: MemoryScope; stale?: boolean };

/** The entry groups, in 0044's order. A kind a newer plxd adds isn't shown. */
export const kindGroups: { kind: MemoryKind; label: string; one: string }[] = [
  { kind: "preference", label: "Preferences", one: "Preference" },
  { kind: "convention", label: "Conventions", one: "Convention" },
  { kind: "decision", label: "Decisions", one: "Decision" },
  { kind: "gotcha", label: "Gotchas", one: "Gotcha" },
];

const scopeLabels: Record<MemoryScope["kind"], string> = {
  you: "You",
  repo: "Repo",
  project: "Project",
};

/** The scopes a view shows, You first, as plxd orders its index (0044). */
export function scopesOf(project?: string, repo?: string): MemoryScope[] {
  return [
    { kind: "you" },
    ...(repo ? [{ kind: "repo", id: repo } as const] : []),
    ...(project ? [{ kind: "project", id: project } as const] : []),
  ];
}

/**
 * Sorts listed files into the view's sections: the Project's brief, the entries to review (marked
 * stale, or unread by agents for 60 days, PLX-943), the other entries by kind (by their folder,
 * `memory/<kind>/`), knowledge, and the proposals waiting for the user. A child's proposal in a
 * Project's folder (writer `thread <run id>`) is its coordinator's to curate, so it isn't one.
 */
export function sectionsOf(files: readonly Memory[]) {
  const review = (f: Memory) => f.stale || f.unused;
  return {
    brief: files.find((f) => f.scope.kind === "project" && f.path === "brief.md"),
    review: files.filter((f) => f.path.startsWith("memory/") && review(f)),
    entries: kindGroups.map((g) => ({
      ...g,
      files: files.filter((f) => f.path.startsWith(`memory/${g.kind}/`) && !review(f)),
    })),
    knowledge: files.filter((f) => f.path.startsWith("knowledge/")),
    proposals: files.filter(
      (f) =>
        f.path.startsWith("proposals/") &&
        !(f.scope.kind === "project" && f.writer?.startsWith("thread ")),
    ),
  };
}

/** Where Promote moves a file from `scope`: Project to Repo to You, skipping a missing Repo. */
export function nextScope(scope: MemoryScope, repo?: string): MemoryScope | undefined {
  if (scope.kind === "project") return repo ? { kind: "repo", id: repo } : { kind: "you" };
  if (scope.kind === "repo") return { kind: "you" };
  return undefined;
}

/** The message the box sends the coordinator for a change in plain words. */
export const changeMessage = (text: string) =>
  `From the Memory tab, the user asks for this change to memory:\n\n> ${text.split("\n").join("\n> ")}\n\nFind the entries it affects, and propose your rewrite for the user to save or discard there, rather than writing it yourself.`;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/** "today", "yesterday", or "Oct 20": the day of `at`, in milliseconds. */
const dayWords = (at: number, now = Date.now()) => {
  const label = dayLabel(at, now, { month: "short", day: "numeric" });
  return label === "Today" || label === "Yesterday" ? label.toLowerCase() : label;
};

/** The day of `date`, `YYYY-MM-DD` as an entry's header gives it, in words (`dayWords`). */
export function dayOf(date: string, now = Date.now()): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return dayWords(new Date(y, m - 1, d).getTime(), now);
}

/**
 * Where a file came from, in words: the title of the thread whose run id its source names, or the
 * file or note it names. None for the user, or a run with no title here.
 */
export function sourceOf(
  file: Memory,
  titles: Readonly<Record<string, string>> = {},
): string | undefined {
  const source = file.source;
  if (!source || source === "user") return undefined;
  const id = source.replace(/^(?:run|thread|coordinator) /, "");
  if (titles[id]) return titles[id];
  const runId = id !== source || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id);
  return runId ? undefined : source;
}

/** Where a file goes: Promote's next scope, or a proposal's entry. */
interface Target {
  scope: MemoryScope;
  path: string;
}

/**
 * Where a proposal saves: an entry, the one it `replaces` or else `memory/<kind>/<slug>.md`, at the
 * scope it names (`forScope`, with `repo` the Repo scope's entry) or else the folder it waits in;
 * or, for a coordinator's with no kind, the Project's brief. Undefined for anything else.
 */
export function savedAs(file: Memory, repo?: string): Target | undefined {
  if (!file.kind) {
    const brief = file.scope.kind === "project" && file.writer?.startsWith("coordinator ");
    return brief ? { scope: file.scope, path: "brief.md" } : undefined;
  }
  const scope: MemoryScope =
    file.forScope === "you"
      ? { kind: "you" }
      : file.forScope === "repo" && repo
        ? { kind: "repo", id: repo }
        : file.scope;
  return { scope, path: file.replaces ?? `memory/${file.kind}/${fileName(file.path)}.md` };
}

const sameScope = (a: MemoryScope, b: MemoryScope) =>
  a.kind === b.kind && (a.kind === "you" || (b.kind !== "you" && a.id === b.id));

type Result = Promise<string | undefined>;

/** Runs `memory/*` requests on one host, each resolving to an error message or undefined. */
function memoryCalls(hostId: string) {
  const read = async (file: Memory) => {
    const answer = await window.parallax.request(hostId, "memory/read", {
      scope: file.scope,
      path: file.path,
    });
    return "error" in answer ? describeError(answer.error) : answer.result;
  };
  const write = async (scope: MemoryScope, path: string, content: string, file: Memory): Result => {
    const answer = await window.parallax.request(hostId, "memory/write", {
      scope,
      path,
      content,
      ...(file.title !== undefined && { title: file.title }),
      ...(file.source !== undefined && { source: file.source }),
    });
    return "error" in answer ? describeError(answer.error) : undefined;
  };
  const remove = async (file: Memory): Result => {
    const answer = await window.parallax.request(hostId, "memory/delete", {
      scope: file.scope,
      path: file.path,
    });
    return "error" in answer ? describeError(answer.error) : undefined;
  };
  /**
   * Writes `content`, or else `file`'s body, at `to`, then deletes `file`, but only once the write
   * succeeds. A failed delete says the write, `done`, happened.
   */
  const move = async (file: Memory, to: Target, done: string, content?: string): Result => {
    let text = content;
    if (text === undefined) {
      const body = await read(file);
      if (typeof body === "string") return body;
      text = body.content;
    }
    const failed = await write(to.scope, to.path, text, file);
    if (failed) return failed;
    const left = await remove(file);
    return left && `${done}, but couldn't remove it from ${scopeLabels[file.scope.kind]}: ${left}`;
  };
  /** Writes an entry over itself, which dates it today, so it leaves the review list. */
  const keep = async (file: Memory): Result => {
    const body = await read(file);
    if (typeof body === "string") return body;
    return write(file.scope, file.path, body.content, file);
  };
  return { read, write, remove, move, keep };
}

/**
 * The listed memory of `scopes`, kept live: `memory/list` for each, read again on a
 * `context.changed` event in the Repo or Project folder (You's isn't watched), and on `reload`.
 */
function useMemory(hostId: string, project: string | undefined, repo: string | undefined) {
  const [files, setFiles] = useState<Memory[]>();
  const [error, setError] = useState<string>();
  // Bumped to list and subscribe again: after a change here, or a `resync`.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let stopped = false;
    const unsubscribes: (() => void)[] = [];
    const scopes = scopesOf(project, repo);
    const list = async () => {
      const lists = await Promise.all(
        scopes.map((scope) => window.parallax.request(hostId, "memory/list", { scope })),
      );
      if (stopped) return;
      const listed: Memory[] = [];
      for (const [i, answer] of lists.entries()) {
        if ("error" in answer) return setError(describeError(answer.error));
        listed.push(...answer.result.files.map((f) => ({ ...f, scope: scopes[i]! })));
      }
      setFiles(listed);
      setError(undefined);
    };
    // Subscribes after `agent/list`'s `seq`, as ContextPanel does, since `memory/list` has none.
    const watch = async (folder: string) => {
      const position = await window.parallax.request(hostId, "agent/list", { project: folder });
      if (stopped || "error" in position) return;
      // `shell` leaves out the runs' output, which only the transcript reads (PLX-453).
      const since = {
        after: position.result.seq,
        project: folder,
        shell: true,
        logId: position.logId,
      };
      unsubscribes.push(
        window.parallax.subscribe(hostId, since, (message) => {
          if (stopped) return;
          if (message.type === "resync") setGeneration((g) => g + 1);
          else if (message.type === "event" && message.event.event.kind === "context.changed")
            void list();
        }),
      );
    };
    for (const scope of scopes) if (scope.kind !== "you") void watch(scope.id);
    void list();
    return () => {
      stopped = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [hostId, project, repo, generation]);

  return { files, error, reload: () => setGeneration((g) => g + 1) };
}

// A section's heading, and its rows grouped in one rounded list with hairlines between them, as
// the Project tab's are.
const group = "divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface";

/**
 * A section's heading: its label and how many rows it has, then at its end a fact and `children`,
 * such as a control for the section.
 */
function Heading({
  label,
  count,
  end,
  children,
}: {
  label: string;
  count?: number;
  end?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 px-1 pt-6 pb-2">
      <h3 className="text-[11px] font-medium tracking-[0.08em] text-faint-foreground uppercase">
        {label}
        {count !== undefined && (
          <span className="ml-1.5 tracking-normal tabular-nums">{count}</span>
        )}
      </h3>
      {(end || children) && (
        <span className="ml-auto flex items-baseline gap-2 text-[11.5px] text-faint-foreground">
          {end}
          {children}
        </span>
      )}
    </div>
  );
}

/**
 * Editing state for an editor that returns focus to the control that opened it, the `opener`,
 * once it closes.
 */
function useEditing() {
  const [editing, setEditing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    opener.current?.focus();
  }, [editing]);
  const close = () => {
    refocus.current = true;
    setEditing(false);
  };
  return { editing, open: () => setEditing(true), close, opener };
}

/**
 * The side panel's Memory view (0044, 0083) for a Project, or for a thread's repository, from the
 * You, Repo, and Project scopes: the proposals waiting for the user first, then the Project's
 * brief in place, the entries by kind, the ones to review (unused for 60 days, or stale), and
 * knowledge documents. Every row is a mark, a title, one muted line, and one thing at its end, and
 * opens to its text and actions. Show it only on a plxd with `memory`, and key it by host and
 * folder. `titles` names the threads a source's run id points at. `start` and `footer` are the
 * Knowledge view's: what it shows before the list, given the listed files, and the box under it.
 */
export function MemoryPanel({
  hostId,
  project,
  repo,
  titles,
  start,
  footer,
}: {
  hostId: string;
  /** The open Project, or absent for a thread outside one. */
  project?: string;
  /** The repo entry whose memory is the Repo scope, if there is one. */
  repo?: string;
  /** Threads' titles by run id. */
  titles?: Readonly<Record<string, string>>;
  /** Before everything, scrolling with it, given the listed files (none until they load). */
  start?: (files: readonly Memory[]) => ReactNode;
  /** Under the list, such as a box that sends a change to the coordinator. */
  footer?: ReactNode;
}) {
  const { files, error, reload } = useMemory(hostId, project, repo);
  const calls = useMemo(() => memoryCalls(hostId), [hostId]);
  const sections = files && sectionsOf(files);
  const taken = ({ scope, path }: Target) =>
    !!files?.some((f) => f.path === path && sameScope(f.scope, scope));
  const row = (file: Memory, kind: RowKind) => (
    <MemoryRow
      key={`${file.scope.kind}/${file.path}`}
      file={file}
      kind={kind}
      titles={titles}
      calls={calls}
      next={nextScope(file.scope, repo)}
      repo={repo}
      taken={taken}
      onChanged={reload}
    />
  );
  const entries = sections?.entries.filter((g) => g.files.length > 0) ?? [];
  const empty =
    sections &&
    !sections.brief &&
    sections.review.length === 0 &&
    entries.length === 0 &&
    sections.knowledge.length === 0 &&
    sections.proposals.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {start?.(files ?? [])}
        {sections && sections.proposals.length > 0 && (
          <section aria-label="To review">
            <Heading label="To review" count={sections.proposals.length} />
            <ul className={group}>{sections.proposals.map((f) => row(f, "proposal"))}</ul>
          </section>
        )}
        {project && sections && (
          <Brief project={project} file={sections.brief} calls={calls} onChanged={reload} />
        )}
        {entries.length > 0 && (
          <section aria-label="Memory">
            <Heading label="Memory" />
            {entries.map((g, i) => (
              <section key={g.kind} aria-label={g.label} className={i > 0 ? "pt-4" : undefined}>
                <h4 className="flex items-baseline px-1 pb-2 text-[12px] text-muted-foreground">
                  {g.label}
                  <span className="ml-1.5 text-faint-foreground tabular-nums">
                    {g.files.length}
                  </span>
                </h4>
                <ul className={group}>{g.files.map((f) => row(f, "entry"))}</ul>
              </section>
            ))}
          </section>
        )}
        {sections && sections.review.length > 0 && (
          <section aria-label="Unused or stale">
            <Heading label="Unused or stale" count={sections.review.length} />
            <ul className={group}>{sections.review.map((f) => row(f, "review"))}</ul>
          </section>
        )}
        {sections && sections.knowledge.length > 0 && (
          <section aria-label="Documents">
            <Heading label="Documents" count={sections.knowledge.length} />
            <ul className={group}>{sections.knowledge.map((f) => row(f, "document"))}</ul>
          </section>
        )}
        {empty && (
          <p className="px-1 pt-6 text-[12.5px] text-muted-foreground">
            No memory yet. Agents propose lasting facts as they work.
          </p>
        )}
        {error && (
          <p role="alert" className="px-1 pt-6 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
      {footer}
    </div>
  );
}

const field =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50";

/**
 * The Project's brief, in place: its text, under a heading with the day it was edited and an Edit
 * button. With none yet, a button opens an empty one to write.
 */
function Brief({
  project,
  file,
  calls,
  onChanged,
}: {
  project: string;
  file?: Memory;
  calls: ReturnType<typeof memoryCalls>;
  onChanged: () => void;
}) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const { editing, open, close, opener } = useEditing();
  // Read again whenever the listed file changes, since it's a new object for each list.
  useEffect(() => {
    if (!file) return;
    let stopped = false;
    void calls.read(file).then((read) => {
      if (stopped) return;
      if (typeof read === "string") return setError(read);
      setContent(read.content);
      setError(undefined);
    });
    return () => {
      stopped = true;
    };
  }, [file, calls]);
  const scope: MemoryScope = { kind: "project", id: project };
  const brief: Memory = file ?? { scope, path: "brief.md", size: 0, modifiedAt: "" };
  const edited = file && `Edited ${dayWords(Date.parse(file.modifiedAt))}`;

  return (
    <section aria-label="Brief">
      <Heading label="Brief" end={edited}>
        {file && !editing && (
          <button
            ref={opener}
            type="button"
            aria-label="Edit the brief"
            disabled={content === undefined}
            onClick={open}
            className="rounded px-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Edit
          </button>
        )}
      </Heading>
      {editing ? (
        <Editor
          label="Brief"
          initial={content ?? ""}
          onCancel={close}
          onSave={async (text) => {
            const failed = await calls.write(scope, "brief.md", text, brief);
            if (!failed) {
              close();
              onChanged();
            }
            return failed;
          }}
        />
      ) : file ? (
        <div className="context-doc px-1 text-[13px]">
          {content !== undefined && <MarkdownText text={content} />}
        </div>
      ) : (
        <button
          ref={opener}
          type="button"
          onClick={() => {
            setContent("");
            open();
          }}
          className="px-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Write the Project's goal, scope, and constraints
        </button>
      )}
      {error && (
        <p role="alert" className="px-1 pt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
    </section>
  );
}

/** What a row is: a proposal, an entry, one to review, or a knowledge document. */
type RowKind = "proposal" | "entry" | "review" | "document";

/**
 * One memory file as a row: a mark, its title, one muted line (its kind, scope, and source, or
 * why it's up for review), and its end (when an agent last read an entry, or when a document
 * changed). A decision waits under the line: a proposal's Accept, Edit, and Dismiss, or Keep and
 * Retire for one to review, where Keep writes it over itself. A click opens its text and Edit, and
 * for an entry or document Promote and Delete. Promote and Accept ask before replacing a file
 * already at their target. An edited proposal saves its new text there, its editor staying open
 * until that succeeds. Entries and proposals show as plain text, so an agent's link can't hide
 * where it goes.
 */
function MemoryRow({
  file,
  kind,
  titles,
  calls,
  next,
  repo,
  taken,
  onChanged,
}: {
  file: Memory;
  kind: RowKind;
  titles?: Readonly<Record<string, string>>;
  calls: ReturnType<typeof memoryCalls>;
  /** Where Promote moves it, or absent for none. */
  next?: MemoryScope;
  /** The repo entry whose memory is the Repo scope, where a proposal for it saves. */
  repo?: string;
  /** Whether a listed file is already at a target. */
  taken: (target: Target) => boolean;
  onChanged: () => void;
}) {
  const proposal = kind === "proposal";
  const title = kind === "document" ? fileName(file.path) : (file.title ?? fileName(file.path));
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string>();
  const { editing, open: startEditing, close: stopEditing, opener } = useEditing();
  const [busy, setBusy] = useState(false);
  // Why the file couldn't be read, shown in its place.
  const [error, setError] = useState<string>();
  // A move waiting on Replace, since its target is taken, with the text an edit gave it.
  const [replacing, setReplacing] = useState<{ to: Target; done: string; content?: string }>();

  // Read again whenever the listed file changes, since it's a new object for each list.
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    void calls.read(file).then((read) => {
      if (stopped) return;
      if (typeof read === "string") return setError(read);
      setContent(read.content);
    });
    return () => {
      stopped = true;
    };
  }, [open, file, calls]);

  // A failed move may still have written, so the list reloads either way.
  const act = async (run: () => Result) => {
    setBusy(true);
    const failed = await run();
    setBusy(false);
    if (failed) changeFailed(failed);
    else dismiss("memory");
    onChanged();
    return failed;
  };
  const move = (to: Target | undefined, done: string, text?: string) => {
    if (!to) return changeFailed("This proposal has no kind.");
    if (taken(to)) return setReplacing({ to, done, content: text });
    void act(() => calls.move(file, to, done, text));
  };

  const kindName = kindGroups.find((g) => g.kind === file.kind)?.one;
  const scope = proposal ? (savedAs(file, repo)?.scope ?? file.scope) : file.scope;
  const from = sourceOf(file, titles);
  const why = file.stale
    ? "names a file that's gone"
    : file.lastUsed
      ? `last used ${dayOf(file.lastUsed)}`
      : file.date
        ? `not used since ${dayOf(file.date)}`
        : "not used yet";
  const line = [
    proposal ? (kindName ?? "Brief") : kind === "review" ? kindName : undefined,
    scopeLabels[scope.kind],
    kind === "review" ? why : from && `from ${from}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const mark = {
    proposal: <Lightbulb className="text-warning" />,
    review: file.stale ? (
      <CircleAlert className="text-warning" />
    ) : (
      <Clock className="text-faint-foreground" />
    ),
    document: <FileText className="text-faint-foreground" />,
    entry: undefined,
  }[kind];
  const end =
    kind === "entry"
      ? file.lastUsed
        ? `Last used ${dayOf(file.lastUsed)}`
        : "Not used yet"
      : kind === "document"
        ? dayLabel(Date.parse(file.modifiedAt), Date.now(), { month: "short", day: "numeric" })
        : undefined;

  // An edit stays open under it until the move succeeds, so a failure keeps the edited text.
  const replace = replacing && (
    <div role="group" aria-label="Replace" className="mt-2">
      <p className="text-[12.5px] text-muted-foreground">
        {scopeLabels[replacing.to.scope.kind]} already has {replacing.to.path}. Replace it with this
        one?
      </p>
      <div className="mt-1 flex gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const { to, done, content: text } = replacing;
            setReplacing(undefined);
            const failed = await act(() => calls.move(file, to, done, text));
            if (!failed && editing) stopEditing();
          }}
          className={outlineButton}
        >
          Replace
        </button>
        <button type="button" onClick={() => setReplacing(undefined)} className={quietButton}>
          Cancel
        </button>
      </div>
    </div>
  );
  const actions = replacing ? (
    replace
  ) : proposal ? (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => move(savedAs(file, repo), "Saved")}
        className={outlineButton}
      >
        Accept
      </button>
      <button
        ref={opener}
        type="button"
        disabled={busy}
        onClick={() => {
          setOpen(true);
          startEditing();
        }}
        className={quietButton}
      >
        Edit
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => calls.remove(file))}
        className={quietButton}
      >
        Dismiss
      </button>
    </div>
  ) : kind === "review" ? (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => calls.keep(file))}
        className={outlineButton}
      >
        Keep
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void act(() => calls.remove(file))}
        className={quietButton}
      >
        Retire
      </button>
      {open && (
        <button
          ref={opener}
          type="button"
          disabled={busy || content === undefined}
          onClick={startEditing}
          className={quietButton}
        >
          Edit
        </button>
      )}
    </div>
  ) : (
    open && (
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          ref={opener}
          type="button"
          disabled={busy || content === undefined}
          onClick={startEditing}
          className={outlineButton}
        >
          Edit
        </button>
        {next && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              move({ scope: next, path: file.path }, `Copied to ${scopeLabels[next.kind]}`)
            }
            className={quietButton}
          >
            Promote to {scopeLabels[next.kind]}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => calls.remove(file))}
          className={quietButton}
        >
          Delete
        </button>
      </div>
    )
  );

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      {mark && (
        <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-4">
          {mark}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group flex w-full min-w-0 items-start gap-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span
              className={`block truncate text-[13.5px] leading-5 font-medium group-hover:text-foreground ${kind === "review" ? "text-muted-foreground" : "text-foreground"}`}
            >
              {title}
            </span>
            {line && (
              <span className="block truncate text-[12px] leading-5 text-muted-foreground">
                {line}
              </span>
            )}
          </span>
          {end && (
            <span className="shrink-0 text-[11.5px] leading-5 text-faint-foreground">{end}</span>
          )}
        </button>
        {editing && content !== undefined ? (
          <div className="mt-2">
            <Editor
              label={title}
              initial={content}
              onCancel={() => {
                setReplacing(undefined);
                stopEditing();
              }}
              onSave={async (text) => {
                if (proposal) {
                  // The editor stays open with the text until the move succeeds.
                  const to = savedAs(file, repo);
                  if (!to) return "This proposal has no kind.";
                  if (taken(to)) {
                    setReplacing({ to, done: "Saved", content: text });
                    return undefined;
                  }
                  const failed = await calls.move(file, to, "Saved", text);
                  // A failed delete still wrote, so the list reloads either way.
                  onChanged();
                  if (!failed) stopEditing();
                  return failed;
                }
                const failed = await calls.write(file.scope, file.path, text, file);
                if (!failed) {
                  stopEditing();
                  onChanged();
                }
                return failed;
              }}
            />
            {replace}
          </div>
        ) : (
          <>
            {open &&
              content !== undefined &&
              (kind === "document" ? (
                <div className="context-doc mt-1.5 text-[13px]">
                  <MarkdownText text={content} />
                </div>
              ) : (
                <p className="mt-1.5 font-mono text-[12px] whitespace-pre-wrap select-text">
                  {content}
                </p>
              ))}
            {actions}
          </>
        )}
        {error && (
          <p role="alert" className="mt-1 text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}

/** Says why a change to a memory file failed. */
const changeFailed = (body: string) =>
  notify({ key: "memory", tone: "error", title: "Couldn't change the memory", body });

/**
 * A text box with Save and Cancel, saying why in a notification when the save fails, which keeps
 * the text. Escape cancels.
 */
function Editor({
  label,
  initial,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  onSave: (text: string) => Result;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const failed = await onSave(text);
        setBusy(false);
        if (failed)
          notify({ key: "memory", tone: "error", title: `Couldn't save ${label}`, body: failed });
        else dismiss("memory");
      }}
    >
      <textarea
        aria-label={`Edit ${label}`}
        autoFocus
        rows={6}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Escape cancels, unless an input method is composing; it stops here, so it doesn't
          // also close the panel.
          if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }}
        className={`${field} font-mono text-[12px]`}
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <button type="button" disabled={busy} onClick={onCancel} className={quietButton}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={outlineButton}>
          Save
        </button>
      </div>
    </form>
  );
}
