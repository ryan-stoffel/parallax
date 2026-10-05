import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { MemoryFile, MemoryKind, MemoryScope } from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";

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
   * Writes `file`'s body at `to`, then deletes it, but only once the write succeeds. A failed
   * delete says the write, `done`, happened.
   */
  const move = async (file: Memory, to: Target, done: string): Result => {
    const body = await read(file);
    if (typeof body === "string") return body;
    const failed = await write(to.scope, to.path, body.content, file);
    if (failed) return failed;
    const left = await remove(file);
    return left && `${done}, but couldn't remove it from ${scopeLabels[file.scope.kind]}: ${left}`;
  };
  return { read, write, remove, move };
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

/**
 * The side panel's Memory view (0044) for a Project, or for a thread's repository. It shows the
 * Project's brief, then entries grouped Preferences, Conventions, Decisions, and Gotchas, then
 * knowledge, from the You, Repo, and Project scopes; then the proposals waiting for the user. Each
 * opens to its text, to edit, promote, or delete it, or for a proposal to save or discard it.
 * Show it only on a plxd with `memory`, and key it by host and folder. `start` and `footer` are
 * the Knowledge view's: what it shows before the list, and the box under it.
 */
export function MemoryPanel({
  hostId,
  project,
  repo,
  start,
  footer,
  onFiles,
}: {
  hostId: string;
  /** The open Project, or absent for a thread outside one. */
  project?: string;
  /** The repo entry whose memory is the Repo scope, if there is one. */
  repo?: string;
  /** Before everything, scrolling with it. */
  start?: ReactNode;
  /** Under the list, such as a box that sends a change to the coordinator. */
  footer?: ReactNode;
  /** Told the listed files each time they load. */
  onFiles?: (files: readonly Memory[]) => void;
}) {
  const { files, error, reload } = useMemory(hostId, project, repo);
  useEffect(() => {
    if (files) onFiles?.(files);
  }, [files, onFiles]);
  const calls = useMemo(() => memoryCalls(hostId), [hostId]);
  const sections = files && sectionsOf(files);
  const taken = ({ scope, path }: Target) =>
    !!files?.some((f) => f.path === path && sameScope(f.scope, scope));
  const row = (file: Memory, title?: string) => (
    <MemoryRow
      key={`${file.scope.kind}/${file.path}`}
      file={file}
      title={title}
      calls={calls}
      next={file.path === "brief.md" ? undefined : nextScope(file.scope, repo)}
      repo={repo}
      taken={taken}
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
        {start}
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
      {footer}
    </div>
  );
}

const sectionHeading = "px-2.5 pt-3 pb-1 text-[12.5px] text-muted-foreground";
const badge = "shrink-0 text-[11.5px] text-faint-foreground";
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
 * The brief only edits. A proposal saves or discards. Promote and Save ask
 * before replacing a file already at their target. Entries and proposals show as plain text, so an
 * agent's link can't hide where it goes.
 */
function MemoryRow({
  file,
  title = file.title ?? fileName(file.path),
  calls,
  next,
  repo,
  taken,
  onChanged,
}: {
  file: Memory;
  title?: string;
  calls: ReturnType<typeof memoryCalls>;
  /** Where Promote moves it, or absent for none. */
  next?: MemoryScope;
  /** The repo entry whose memory is the Repo scope, where a proposal for it saves. */
  repo?: string;
  /** Whether a listed file is already at a target. */
  taken: (target: Target) => boolean;
  onChanged: () => void;
}) {
  const brief = file.path === "brief.md";
  const proposal = file.path.startsWith("proposals/");
  const plain = proposal || file.path.startsWith("memory/");
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A Promote or Save waiting on Replace, since its target is taken.
  const [replacing, setReplacing] = useState<{ to: Target; done: string }>();

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
    setError(failed);
    onChanged();
  };
  const move = (to: Target | undefined, done: string) => {
    if (!to) return setError("This proposal has no kind.");
    if (taken(to)) return setReplacing({ to, done });
    void act(() => calls.move(file, to, done));
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
              {content !== undefined &&
                (plain ? (
                  <p className="text-[13px] whitespace-pre-wrap">{content}</p>
                ) : (
                  <div className="context-doc text-[13px]">
                    <MarkdownText text={content} />
                  </div>
                ))}
              {replacing ? (
                <div role="group" aria-label="Replace" className="mt-1.5">
                  <p className="text-[12.5px] text-muted-foreground">
                    {scopeLabels[replacing.to.scope.kind]} already has {replacing.to.path}. Replace
                    it with this one?
                  </p>
                  <div className="mt-1 flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setReplacing(undefined);
                        void act(() => calls.move(file, replacing.to, replacing.done));
                      }}
                      className={outlineButton}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => setReplacing(undefined)}
                      className={quietButton}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {proposal ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => move(savedAs(file, repo), "Saved")}
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
                          onClick={() =>
                            move(
                              { scope: next, path: file.path },
                              `Copied to ${scopeLabels[next.kind]}`,
                            )
                          }
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
              )}
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
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
