// A Space's page, New thread laid out as two columns (0090): its header, the composer, and its
// threads on the left; on the right, the instructions and files plxd gives every thread in it.
import { Pin, PinOff, Plus, Upload, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { activeAt, attentionOf } from "./attention";
import { AttentionBadge } from "./AttentionMark";
import { useConnection } from "./ConnectionStatus";
import type { FavoriteAction } from "./Favorites";
import { fileIcon } from "./Mention";
import { notify } from "./notifications";
import type { ProjectEntry } from "./projectList";
import { ProjectMenu, ProjectTile } from "./ProjectsPage";
import { quietButton } from "./settings/parts";
import { age } from "./Sidebar";
import { asksOf, waitingOf, type ThreadsView } from "./threads";
import { IconButton } from "./ui";
import { uploadBytes, uploadFiles } from "./uploads";

const panel = "rounded-xl border border-border bg-surface p-5";
const panelHead = "mb-3 flex items-center justify-between gap-2";

/** A Space's header, in place of New thread's question: its tile, name, and size, Pin, and its menu. */
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
  const n = entry.threads;
  return (
    <header className="mb-6 flex items-center gap-4">
      <ProjectTile entry={entry} size="lg" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-display font-semibold tracking-tight">{entry.name}</h1>
        <p className="mt-0.5 text-body text-muted-foreground">
          Space · {n} {n === 1 ? "thread" : "threads"}
        </p>
      </div>
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
    </header>
  );
}

/** A Space's threads under the composer, newest first: each title, when it was last active, and its status. */
export function SpaceThreads({
  space,
  view,
  onOpenThread,
}: {
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
  return (
    <section aria-label="Threads" className="mt-10">
      <h2 className="mb-2 text-reading font-medium">Threads</h2>
      {threads.length === 0 ? (
        <p className="border-t border-border py-4 text-body text-faint-foreground">
          No threads yet. Ask anything above to start one.
        </p>
      ) : (
        <ul className="border-t border-border">
          {threads.map(({ thread, at, attention }) => (
            <li key={thread.id} className="border-b border-border">
              <button
                type="button"
                onClick={() => onOpenThread(thread.id)}
                className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-4 rounded-lg px-3 py-3 text-left hover:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">
                    {state.titles[thread.id] ?? "Thread"}
                  </span>
                  <span className="mt-0.5 block text-meta text-faint-foreground">
                    {age(at) === "now" ? "Active just now" : `Last active ${age(at)} ago`}
                  </span>
                </span>
                {attention !== "settled" && <AttentionBadge attention={attention} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A Space's instructions and files, beside the composer. */
export function SpaceContext({
  hostId,
  space,
  view,
}: {
  hostId: string;
  space: Repo;
  view: ThreadsView;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Instructions space={space} view={view} />
      <Files hostId={hostId} space={space} view={view} />
    </div>
  );
}

/** The Instructions panel: what every thread here is told, edited in a dialog. */
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
    <section aria-label="Instructions" className={panel}>
      <div className={panelHead}>
        <h2 className="text-reading font-medium">Instructions</h2>
        <button
          type="button"
          aria-label={space.instructions ? "Edit instructions" : "Add instructions"}
          onClick={open}
          className={quietButton}
        >
          {space.instructions ? "Edit" : "Add"}
        </button>
      </div>
      {space.instructions ? (
        <button
          type="button"
          onClick={open}
          className="line-clamp-[12] text-left text-body leading-relaxed whitespace-pre-wrap text-muted-foreground hover:text-foreground"
        >
          {space.instructions}
        </button>
      ) : (
        <p className="text-body leading-relaxed text-faint-foreground">
          Tell every thread here how to work: who it's for, the tone and format you want, and what
          it should know.
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

/**
 * The Files panel: each file as a tile with Remove, then Add or a drop anywhere on the panel, which
 * uploads to the host.
 */
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
  const pick = () => input.current?.click();
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
      className={`${panel} transition-colors ${over ? "border-accent" : ""}`}
    >
      <div className={panelHead}>
        <h2 className="text-reading font-medium">
          Files
          {files.length > 0 && (
            <span className="ml-1.5 font-normal text-faint-foreground tabular-nums">
              {files.length}
            </span>
          )}
        </h2>
        {files.length > 0 && (
          <button
            type="button"
            aria-label="Add files"
            disabled={!caps || adding}
            onClick={pick}
            className={`${quietButton} flex items-center gap-1 disabled:opacity-50 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Add
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <button
          type="button"
          aria-label="Add files"
          disabled={!caps || adding}
          onClick={pick}
          className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center transition-colors disabled:opacity-50 ${over ? "border-accent bg-accent/5" : "border-border hover:bg-hover"}`}
        >
          <Upload aria-hidden className="size-5 text-faint-foreground" />
          <span className="text-body text-muted-foreground">
            {adding ? "Adding…" : "Drop files here, or click to add"}
          </span>
          <span className="text-meta text-faint-foreground">
            PDFs, notes, or code every thread here can read
          </span>
        </button>
      ) : (
        <ul className="grid grid-cols-2 gap-2">
          {files.map((path) => {
            const name = path.split(/[\\/]/).at(-1) ?? path;
            const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
            return (
              <li
                key={path}
                className="group/file relative flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-3"
              >
                <span aria-hidden className="[&_img]:size-5">
                  {fileIcon(name)}
                </span>
                <span title={name} className="line-clamp-2 text-meta break-all">
                  {name}
                </span>
                {ext && (
                  <span className="text-micro tracking-wide text-faint-foreground uppercase">
                    {ext}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  // An add in flight saves the list as it began, which would undo a remove.
                  disabled={adding}
                  onClick={() => void save(files.filter((f) => f !== path))}
                  className="absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-sm text-faint-foreground opacity-0 group-hover/file:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 disabled:hidden"
                >
                  <X className="size-3" />
                </button>
              </li>
            );
          })}
          {adding && (
            <li className="grid place-items-center rounded-lg border border-dashed border-border p-3 text-meta text-faint-foreground">
              Adding…
            </li>
          )}
        </ul>
      )}
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
    </section>
  );
}
