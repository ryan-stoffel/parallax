// A Space's page under New thread's composer (0090): its instructions and files, which plxd
// gives every thread in it, and its threads.
import { PencilLine, Plus, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { activeAt } from "./attention";
import { useConnection } from "./ConnectionStatus";
import { fileIcon } from "./Mention";
import { notify } from "./notifications";
import { age } from "./Sidebar";
import type { ThreadsView } from "./threads";
import { IconButton } from "./ui";
import { uploadBytes, uploadFiles } from "./uploads";

const card = "flex min-h-0 flex-col rounded-xl border border-border/70 bg-surface p-4";

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
  const chats = state.threads
    .filter((t) => t.repo === space.id && !t.parent)
    .map((t) => ({ thread: t, at: activeAt(t, state.runs[t.id], state.stoppedAt[t.id]) }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const editable = "spaceContext" in view.capabilities;
  return (
    <div className="mt-12 flex flex-col gap-8">
      {editable && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Instructions space={space} view={view} />
          <Files hostId={hostId} space={space} view={view} />
        </div>
      )}
      <section aria-label="Threads">
        <h2 className="mb-2 px-1 text-body font-medium text-muted-foreground">Threads</h2>
        {chats.length === 0 ? (
          <p className="px-1 text-body text-faint-foreground">No threads yet. Start one above.</p>
        ) : (
          <ul className="flex flex-col">
            {chats.map(({ thread, at }) => (
              <li key={thread.id} className="border-t border-border/60 first:border-t-0">
                <button
                  type="button"
                  onClick={() => onOpenThread(thread.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate text-body">
                    {state.titles[thread.id] ?? "Thread"}
                  </span>
                  <span className="shrink-0 text-meta text-faint-foreground">{age(at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
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
          className="mt-2 line-clamp-4 text-left text-meta whitespace-pre-wrap text-muted-foreground hover:text-foreground"
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

/** The files card: each file with Remove, and Add, which uploads to the host. */
function Files({ hostId, space, view }: { hostId: string; space: Repo; view: ThreadsView }) {
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
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
  return (
    <section aria-label="Files" className={card}>
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
          {adding ? "Adding…" : "Add PDFs, notes, or code for every thread here to read."}
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
