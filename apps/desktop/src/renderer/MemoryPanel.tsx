import { useEffect, useMemo, useState } from "react";

import type { MemoryFile, MemoryKind, MemoryScope } from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";
import { uuidv7 } from "./uuidv7";

/**
 * A memory file with the scope it was listed from. `stale` is PLX-407's review mark, read when
 * plxd sends it.
 */
export type Memory = MemoryFile & { scope: MemoryScope; stale?: boolean };

/** The entry groups, in 0044's order. A kind a newer plxd adds isn't shown. */
export const kindGroups: { kind: MemoryKind; label: string }[] = [
  { kind: "preference", label: "Preferences" },
  { kind: "convention", label: "Conventions" },
  { kind: "decision", label: "Decisions" },
  { kind: "gotcha", label: "Gotchas" },
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
 * Sorts listed files into the view's sections: the Project's brief, entries by kind (by their
 * folder, `memory/<kind>/`), knowledge, and the proposals waiting for the user. A child's proposal
 * in a Project's folder (writer `thread <run id>`) is its coordinator's to curate, so it isn't one.
 */
export function sectionsOf(files: readonly Memory[]) {
  return {
    brief: files.find((f) => f.scope.kind === "project" && f.path === "brief.md"),
    entries: kindGroups.map((g) => ({
      ...g,
      files: files.filter((f) => f.path.startsWith(`memory/${g.kind}/`)),
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
  // Writes `file`'s body at `scope` and `path`, then deletes it.
  const move = async (file: Memory, scope: MemoryScope, path: string): Result => {
    const body = await read(file);
    if (typeof body === "string") return body;
    return (await write(scope, path, body.content, file)) ?? remove(file);
  };
  return {
    read,
    write,
    remove,
    promote: (file: Memory, to: MemoryScope) => move(file, to, file.path),
    // ponytail: `MemoryFile` doesn't carry a proposal's `Scope:` line, so it saves in the folder
    // it waits in; PLX-476 adds the scope.
    save: (file: Memory) =>
      file.kind
        ? move(file, file.scope, `memory/${file.kind}/${fileName(file.path)}.md`)
        : Promise.resolve("This proposal has no kind this version knows."),
  };
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
      const since = { after: position.result.seq, project: folder, logId: position.logId };
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

/**
 * The side panel's Memory view (0044) for a Project, or for a thread's repository. It shows the
 * Project's brief, then entries grouped Preferences, Conventions, Decisions, and Gotchas, then
 * knowledge, from the You, Repo, and Project scopes; then the proposals waiting for the user. Each
 * opens to its text, to edit, promote, or delete it, or for a proposal to save or discard it. A
 * Project's box sends a change in plain words to its coordinator. Show it only on a plxd with
 * `memory`, and key it by host and folder.
 */
export function MemoryPanel({
  hostId,
  project,
  repo,
  coordinator,
}: {
  hostId: string;
  /** The open Project, or absent for a thread outside one. */
  project?: string;
  /** The repo entry whose memory is the Repo scope, if there is one. */
  repo?: string;
  /** The Project's coordinator run, which the box sends to. */
  coordinator?: string;
}) {
  const { files, error, reload } = useMemory(hostId, project, repo);
  const calls = useMemo(() => memoryCalls(hostId), [hostId]);
  const sections = files && sectionsOf(files);
  const row = (file: Memory, title?: string) => (
    <MemoryRow
      key={`${file.scope.kind}/${file.path}`}
      file={file}
      title={title}
      calls={calls}
      next={file.path === "brief.md" ? undefined : nextScope(file.scope, repo)}
      onChanged={reload}
    />
  );
  const empty =
    sections &&
    !sections.brief &&
    sections.entries.every((g) => g.files.length === 0) &&
    sections.knowledge.length === 0 &&
    sections.proposals.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {project && (
          <section aria-label="Brief">
            <h3 className={sectionHeading}>Brief</h3>
            {sections?.brief ? (
              <ul>{row(sections.brief, "Goal, scope, and constraints")}</ul>
            ) : (
              <BriefStart project={project} calls={calls} onChanged={reload} />
            )}
          </section>
        )}
        {sections?.entries.map(
          (g) =>
            g.files.length > 0 && (
              <section key={g.kind} aria-label={g.label}>
                <h3 className={sectionHeading}>{g.label}</h3>
                <ul>{g.files.map((f) => row(f))}</ul>
              </section>
            ),
        )}
        {sections && sections.knowledge.length > 0 && (
          <section aria-label="Knowledge">
            <h3 className={sectionHeading}>Knowledge</h3>
            <ul>{sections.knowledge.map((f) => row(f, fileName(f.path)))}</ul>
          </section>
        )}
        {sections && sections.proposals.length > 0 && (
          <section aria-label="Proposals">
            <h3 className={sectionHeading}>Proposals</h3>
            <ul>{sections.proposals.map((f) => row(f))}</ul>
          </section>
        )}
        {empty && (
          <p className="px-2.5 py-2 text-[12.5px] text-muted-foreground">
            No memory yet. Agents propose lasting facts as they work.
          </p>
        )}
        {error && (
          <p role="alert" className="px-2.5 py-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
      {project && <ChangeBox hostId={hostId} coordinator={coordinator} />}
    </div>
  );
}

const sectionHeading = "px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-faint-foreground";
const badge = "shrink-0 rounded bg-selected px-1.5 text-[11px] text-muted-foreground";
const field =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50";

/** A Project with no brief yet: a button that opens an empty one to write. */
function BriefStart({
  project,
  calls,
  onChanged,
}: {
  project: string;
  calls: ReturnType<typeof memoryCalls>;
  onChanged: () => void;
}) {
  const [writing, setWriting] = useState(false);
  if (!writing)
    return (
      <button
        type="button"
        onClick={() => setWriting(true)}
        className="px-2.5 py-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Write the Project's goal, scope, and constraints
      </button>
    );
  const brief: Memory = {
    scope: { kind: "project", id: project },
    path: "brief.md",
    size: 0,
    modifiedAt: "",
  };
  return (
    <Editor
      label="Brief"
      initial=""
      onCancel={() => setWriting(false)}
      onSave={async (content) => {
        const failed = await calls.write(brief.scope, brief.path, content, brief);
        if (!failed) onChanged();
        return failed;
      }}
    />
  );
}

/**
 * One memory file: its title, scope, source, and stale mark, opening to its text and actions.
 * The brief opens at once and only edits. A proposal saves or discards.
 */
function MemoryRow({
  file,
  title = file.title ?? fileName(file.path),
  calls,
  next,
  onChanged,
}: {
  file: Memory;
  title?: string;
  calls: ReturnType<typeof memoryCalls>;
  /** Where Promote moves it, or absent for none. */
  next?: MemoryScope;
  onChanged: () => void;
}) {
  const brief = file.path === "brief.md";
  const proposal = file.path.startsWith("proposals/");
  const [open, setOpen] = useState(brief);
  const [content, setContent] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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

  const act = async (run: () => Result) => {
    setBusy(true);
    const failed = await run();
    setBusy(false);
    setError(failed);
    if (!failed) onChanged();
  };

  return (
    <li className="list-none rounded-lg hover:bg-hover/50">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
        {file.stale && (
          <span className={`${badge} text-warning`} title="It names a file that's gone">
            Stale
          </span>
        )}
        <span className={badge}>{scopeLabels[file.scope.kind]}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2">
          {file.source && (
            <p className="truncate pb-1 text-[11.5px] text-faint-foreground" title={file.source}>
              From {file.source}
            </p>
          )}
          {editing ? (
            <Editor
              label={title}
              initial={content ?? ""}
              onCancel={() => setEditing(false)}
              onSave={async (text) => {
                const failed = await calls.write(file.scope, file.path, text, file);
                if (!failed) {
                  setEditing(false);
                  onChanged();
                }
                return failed;
              }}
            />
          ) : (
            <>
              {content !== undefined && (
                <div className="context-doc text-[13px]">
                  <MarkdownText text={content} />
                </div>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {proposal ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(() => calls.save(file))}
                      className={outlineButton}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(() => calls.remove(file))}
                      className={quietButton}
                    >
                      Discard
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy || content === undefined}
                      onClick={() => setEditing(true)}
                      className={outlineButton}
                    >
                      Edit
                    </button>
                    {next && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => calls.promote(file, next))}
                        className={quietButton}
                      >
                        Promote to {scopeLabels[next.kind]}
                      </button>
                    )}
                    {!brief && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void act(() => calls.remove(file))}
                        className={quietButton}
                      >
                        Delete
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="mt-1 text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** A text box with Save and Cancel, showing why when the save fails. */
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
  const [error, setError] = useState<string>();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const failed = await onSave(text);
        setBusy(false);
        setError(failed);
      }}
    >
      <textarea
        aria-label={`Edit ${label}`}
        autoFocus
        rows={6}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        className={field}
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <button type="button" disabled={busy} onClick={onCancel} className={quietButton}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={outlineButton}>
          Save
        </button>
      </div>
      {error && <p className="mt-1 text-[12px] text-danger">{error}</p>}
    </form>
  );
}

/**
 * The box that takes a change to memory in plain words ("we moved off Jest, use Vitest") and sends
 * it to the coordinator, whose rewrite comes back as a proposal (0044). Off until the Project has
 * a coordinator.
 */
function ChangeBox({ hostId, coordinator }: { hostId: string; coordinator?: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string }>();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!coordinator || !text.trim() || busy) return;
        setBusy(true);
        const answer = await window.parallax.request(hostId, "agent/send", {
          runId: coordinator,
          turnId: uuidv7(),
          text: changeMessage(text.trim()),
        });
        setBusy(false);
        if ("error" in answer) return setNote({ error: true, text: describeError(answer.error) });
        setText("");
        setNote({ error: false, text: "Sent. The coordinator's rewrite shows up in Proposals." });
      }}
      className="shrink-0 border-t border-border px-4 py-3"
    >
      <textarea
        aria-label="Change memory"
        placeholder={
          coordinator
            ? "Change memory in plain words, such as “we moved off Jest, use Vitest”"
            : "Start the coordinator to change memory in plain words"
        }
        rows={2}
        value={text}
        disabled={!coordinator || busy}
        onChange={(e) => setText(e.target.value)}
        className={`${field} resize-none`}
      />
      <div className="mt-1.5 flex items-center gap-2">
        {note && (
          <p
            role={note.error ? "alert" : "status"}
            className={`min-w-0 flex-1 text-[12px] ${note.error ? "text-danger" : "text-muted-foreground"}`}
          >
            {note.text}
          </p>
        )}
        <button
          type="submit"
          disabled={!coordinator || busy || !text.trim()}
          className={`${outlineButton} ml-auto`}
        >
          Send to coordinator
        </button>
      </div>
    </form>
  );
}
