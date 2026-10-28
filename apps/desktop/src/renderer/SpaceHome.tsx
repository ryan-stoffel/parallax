// A Space in New thread (0090): its instructions and files in the tray tucked under the composer,
// where a repository's thread shows where it runs, and its threads under the box.
import { Paperclip, Plus, ScrollText, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { activeAt, attentionOf } from "./attention";
import { AttentionBadge } from "./AttentionMark";
import { useConnection } from "./ConnectionStatus";
import { fileIcon } from "./Mention";
import { notify } from "./notifications";
import { age } from "./Sidebar";
import { asksOf, waitingOf, type ThreadsView } from "./threads";
import { menuButton, menuItem, menuPanel } from "./ui";
import { uploadBytes, uploadFiles } from "./uploads";

/**
 * A Space's tray under the composer: Instructions, which opens their editor, and its files, whose
 * menu lists them with Remove and takes more by Add or a drop.
 */
export function SpaceTray({
  hostId,
  space,
  view,
}: {
  hostId: string;
  space: Repo;
  view: ThreadsView;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Instructions space={space} view={view} />
      <span aria-hidden className="text-faint-foreground">
        ·
      </span>
      <Files hostId={hostId} space={space} view={view} />
    </div>
  );
}

/** A Space's threads under the composer, newest first, each with its status or age. */
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
  if (threads.length === 0) return null;
  return (
    <section aria-label="Threads" className="mx-4 mt-10">
      <h2 className="mb-1 px-2 text-meta font-medium text-faint-foreground">Threads</h2>
      <ul className="flex flex-col">
        {threads.map(({ thread, at, attention }) => (
          <li key={thread.id}>
            <button
              type="button"
              onClick={() => onOpenThread(thread.id)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-body">
                {state.titles[thread.id] ?? "Thread"}
              </span>
              <span className="shrink-0 text-meta text-faint-foreground">
                {attention === "settled" ? age(at) : <AttentionBadge attention={attention} />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The tray's Instructions: what every thread here is told, edited in a dialog. */
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
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={space.instructions ? "Edit instructions" : "Add instructions"}
        title={space.instructions}
        onClick={open}
        className={menuButton}
      >
        <ScrollText aria-hidden />
        {space.instructions ? "Instructions" : "Add instructions"}
      </button>
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
    </>
  );
}

/**
 * The tray's files: how many, opening a menu that lists each with Remove, then Add files. Files
 * dropped on the button or the menu are added too.
 */
function Files({ hostId, space, view }: { hostId: string; space: Repo; view: ThreadsView }) {
  const input = useRef<HTMLInputElement>(null);
  const menu = useId();
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
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!caps || adding || !takesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      if (!takesFiles(e)) return;
      e.preventDefault();
      setOver(false);
      void add([...e.dataTransfer.files]);
    },
  };
  const n = files.length;
  return (
    <>
      <button
        type="button"
        popoverTarget={menu}
        aria-haspopup="menu"
        {...drop}
        className={`${menuButton} ${over ? "bg-hover text-foreground" : ""}`}
      >
        <Paperclip aria-hidden />
        {adding ? "Adding…" : n === 0 ? "Add files" : `${n} ${n === 1 ? "file" : "files"}`}
      </button>
      <div
        id={menu}
        popover="auto"
        role="menu"
        aria-label="Files"
        {...drop}
        className={`${menuPanel("start")} w-72 p-1 ${over ? "outline-2 outline-accent" : ""}`}
      >
        {n === 0 ? (
          <p className="px-2 py-1.5 text-meta text-faint-foreground">
            Every thread here can read the files you add. Drop them here, or add them.
          </p>
        ) : (
          <ul aria-label="Files" className="flex max-h-60 flex-col overflow-y-auto">
            {files.map((path) => {
              const name = path.split(/[\\/]/).at(-1) ?? path;
              return (
                <li key={path} className="group/file flex items-center gap-2 rounded-md px-2 py-1">
                  <span aria-hidden className="shrink-0 [&_img]:size-4">
                    {fileIcon(name)}
                  </span>
                  <span title={name} className="min-w-0 flex-1 truncate text-body">
                    {name}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    // An add in flight saves the list as it began, which would undo a remove.
                    disabled={adding}
                    onClick={() => void save(files.filter((f) => f !== path))}
                    className="grid size-5 shrink-0 place-items-center rounded-sm text-faint-foreground opacity-0 group-hover/file:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 disabled:hidden"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <hr className="-mx-1 my-1 border-border" />
        <button
          type="button"
          role="menuitem"
          aria-label="Add files"
          disabled={!caps || adding}
          onClick={() => input.current?.click()}
          className={`${menuItem} disabled:opacity-50`}
        >
          <Plus aria-hidden />
          Add files…
        </button>
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
    </>
  );
}
