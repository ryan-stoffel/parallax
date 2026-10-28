// A Space's page in New thread (0090): its header over the composer, then its threads beside its
// instructions and files, which plxd gives every thread in it.
import { Pin, PinOff, PencilLine, Plus, X } from "lucide-react";
import { useId, useRef, useState, type CSSProperties, type DragEvent } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { activeAt, attentionOf } from "./attention";
import { AttentionBadge } from "./AttentionMark";
import { useConnection } from "./ConnectionStatus";
import type { FavoriteAction } from "./Favorites";
import { fileIcon } from "./Mention";
import { notify } from "./notifications";
import type { ProjectEntry } from "./projectList";
import { ProjectMenu, ProjectTile, tint, useImageTint } from "./ProjectsPage";
import { age } from "./Sidebar";
import { asksOf, waitingOf, type ThreadsView } from "./threads";
import { IconButton } from "./ui";
import { uploadBytes, uploadFiles } from "./uploads";

const card = "flex min-h-0 flex-col rounded-xl border border-border/70 bg-surface p-4";

/** A Space header's light: its color, from behind its tile, fading out. */
const headerGlow =
  "radial-gradient(closest-side at 30% 50%, color-mix(in srgb, var(--tint) 16%, transparent), transparent)";

/**
 * A Space's header, in place of New thread's question: its tile, name, and size, with Pin and its
 * menu, over a soft light in its color when it has one.
 */
export function SpaceHeader({
  entry,
  pinned,
  onTogglePin,
  actionsFor,
}: {
  entry: ProjectEntry;
  pinned: boolean;
  onTogglePin: () => void;
  actionsFor: () => FavoriteAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const color = tint(entry, useImageTint(entry.icon));
  const n = entry.threads;
  const files = entry.files;
  return (
    <header style={{ "--tint": color } as CSSProperties} className="relative mb-8">
      {/* A Space with no color of its own has no light to cast. */}
      {(entry.icon?.color || entry.icon?.image) && (
        <span
          aria-hidden
          style={{ background: headerGlow }}
          className="pointer-events-none absolute -top-28 -left-24 h-72 w-[40rem]"
        />
      )}
      <div className="relative flex items-center gap-4">
        <ProjectTile entry={entry} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-display font-semibold tracking-tight">{entry.name}</h1>
          <p className="mt-0.5 text-body text-muted-foreground">
            Space · {n} {n === 1 ? "thread" : "threads"}
            {files > 0 && ` · ${files} ${files === 1 ? "file" : "files"}`}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label={pinned ? "Unpin" : "Pin"} onClick={onTogglePin}>
            {pinned ? <PinOff /> : <Pin />}
          </IconButton>
          <ProjectMenu
            entry={entry}
            pinned={pinned}
            onTogglePin={onTogglePin}
            actionsFor={actionsFor}
            trigger={trigger}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          />
        </div>
      </div>
    </header>
  );
}

/** A Space's threads, newest first, beside its instructions and files. */
export function SpaceHome({
  hostId,
  space,
  view,
  onOpenThread,
}: {
  hostId: string;
  space: Repo;
  view: ThreadsView;
  onOpenThread: (threadId: string) => void;
}) {
  const { state } = view;
  const threads = state.threads
    .filter((t) => t.repo === space.id && !t.parent && !t.archived)
    .map((t) => {
      const run = state.runs[t.id];
      return {
        thread: t,
        at: activeAt(t, run, state.stoppedAt[t.id]),
        attention: attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)),
      };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const editable = "spaceContext" in view.capabilities;
  return (
    <div className={`mt-10 grid gap-6 ${editable ? "md:grid-cols-[minmax(0,1fr)_16rem]" : ""}`}>
      <section aria-label="Threads" className="min-w-0">
        <h2 className="mb-2 text-reading font-medium">Threads</h2>
        {threads.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-body text-faint-foreground">
            No threads yet. Ask anything above to start one.
          </p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {threads.map(({ thread, at, attention }) => (
              <li key={thread.id}>
                <button
                  type="button"
                  onClick={() => onOpenThread(thread.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-body font-medium">
                    {state.titles[thread.id] ?? "Thread"}
                  </span>
                  <span className="shrink-0 text-meta text-faint-foreground">
                    {attention === "settled" ? age(at) : <AttentionBadge attention={attention} />}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {editable && (
        <aside className="flex flex-col gap-3">
          <Instructions space={space} view={view} />
          <Files hostId={hostId} space={space} view={view} />
        </aside>
      )}
    </div>
  );
}

/** The instructions card, which opens an editor. */
function Instructions({ space, view }: { space: Repo; view: ThreadsView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const open = () => {
    setText(space.instructions ?? "");
    setError(undefined);
    dialog.current?.showModal();
  };
  return (
    <section aria-label="Instructions" className={card}>
      <div className="flex items-center justify-between">
        <h2 className="text-body font-medium">Instructions</h2>
        <IconButton
          label={space.instructions ? "Edit instructions" : "Add instructions"}
          onClick={open}
        >
          {space.instructions ? <PencilLine /> : <Plus />}
        </IconButton>
      </div>
      {space.instructions ? (
        <button
          type="button"
          onClick={open}
          className="mt-2 line-clamp-6 text-left text-meta whitespace-pre-wrap text-muted-foreground hover:text-foreground"
        >
          {space.instructions}
        </button>
      ) : (
        <p className="mt-2 text-meta text-faint-foreground">
          Tell every thread here how to work: a tone, a format, or what it should know.
        </p>
      )}
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto w-[min(40rem,90vw)] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            const failed = await view.updateRepo(space.id, { instructions: text });
            setSaving(false);
            if (failed) return setError(failed);
            dialog.current?.close();
          }}
          className="flex flex-col p-5"
        >
          <h2 id={titleId} className="text-reading font-semibold">
            Instructions for {space.name}
          </h2>
          <p className="mt-1 text-body text-muted-foreground">
            New threads in this Space follow them.
          </p>
          <textarea
            aria-label="Instructions"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Answer as a patient tutor. Show the steps, then the result."
            className="mt-4 h-64 resize-none rounded-lg border border-border bg-background p-3 text-body leading-relaxed placeholder:text-faint-foreground focus-visible:border-transparent focus-visible:outline-2 focus-visible:outline-ring"
          />
          {error && (
            <p role="alert" className="mt-2 text-meta text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="rounded-md px-3 py-1.5 text-body hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

/** The files card: each file with Remove, and Add or a drop, which uploads to the host. */
function Files({ hostId, space, view }: { hostId: string; space: Repo; view: ThreadsView }) {
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  const caps = uploadBytes(useConnection(hostId));
  const files = space.files ?? [];
  const save = async (next: string[]) => {
    const failed = await view.updateRepo(space.id, { files: next });
    if (failed) notify({ tone: "error", title: "Couldn't change the files", body: failed });
  };
  const add = async (picked: File[]) => {
    if (!caps || picked.length === 0) return;
    const big = picked.find((f) => f.size > caps.maxBytes);
    if (big)
      return notify({
        tone: "error",
        title: "Couldn't add the file",
        body: `${big.name} is larger than this host takes.`,
      });
    setAdding(true);
    const paths = await uploadFiles(hostId, picked, caps.chunkBytes);
    if (typeof paths === "string")
      notify({ tone: "error", title: "Couldn't add the file", body: paths });
    else await save([...files, ...paths]);
    setAdding(false);
  };
  const takesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <section
      aria-label="Files"
      onDragOver={(e) => {
        if (!caps || adding || !takesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!takesFiles(e)) return;
        e.preventDefault();
        setOver(false);
        void add([...e.dataTransfer.files]);
      }}
      className={`${card} transition-colors ${over ? "border-accent bg-accent/5" : ""}`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-body font-medium">
          Files
          {files.length > 0 && (
            <span className="ml-1.5 font-normal text-faint-foreground tabular-nums">
              {files.length}
            </span>
          )}
        </h2>
        <IconButton
          label="Add files"
          disabled={!caps || adding}
          onClick={() => input.current?.click()}
        >
          <Plus />
        </IconButton>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {files.length === 0 ? (
        <p className="mt-2 text-meta text-faint-foreground">
          {adding ? "Adding…" : "Add or drop PDFs, notes, or code for every thread here to read."}
        </p>
      ) : (
        <ul className="mt-2 flex max-h-40 flex-col overflow-y-auto">
          {files.map((path) => {
            const name = path.split(/[\\/]/).at(-1) ?? path;
            return (
              <li key={path} className="group/file flex items-center gap-2 rounded-md py-1 pr-1">
                <span aria-hidden className="shrink-0 [&_img]:size-4">
                  {fileIcon(name)}
                </span>
                <span title={name} className="min-w-0 flex-1 truncate text-meta">
                  {name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  // An add in flight saves the list as it began, which would undo a remove.
                  disabled={adding}
                  onClick={() => void save(files.filter((f) => f !== path))}
                  className="grid size-5 place-items-center rounded-sm text-faint-foreground opacity-0 group-hover/file:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 disabled:hidden"
                >
                  <X className="size-3" />
                </button>
              </li>
            );
          })}
          {adding && <li className="py-1 text-meta text-faint-foreground">Adding…</li>}
        </ul>
      )}
    </section>
  );
}
