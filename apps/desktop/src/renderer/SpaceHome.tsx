// A Space's page, New thread laid out as a page (0090): its header, the composer, then its threads
// beside the instructions and files plxd gives every thread in it.
import { ArrowLeft, MessagesSquare, Pin, PinOff, Plus, Upload } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { activeAt, attentionOf } from "./attention";
import { AttentionBadge } from "./AttentionMark";
import { useConnection } from "./ConnectionStatus";
import type { FavoriteAction } from "./Favorites";
import { FileCard } from "./FileCard";
import { notify } from "./notifications";
import type { ProjectEntry } from "./projectList";
import { ProjectMenu, ProjectTile } from "./ProjectsPage";
import { quietButton } from "./settings/parts";
import type { Host } from "./hosts";
import { hostIcon } from "./RunTargetMenu";
import { age, backendLogo, RepoIcon } from "./Sidebar";
import { asksOf, waitingOf, type ThreadsView } from "./threads";
import { IconButton } from "./ui";
import { uploadBytes, uploadFiles } from "./uploads";

const panelPart = "p-5";
const panelHead = "mb-3 flex items-center justify-between gap-2";

/**
 * A Space's header, in place of New thread's question: a way back to Projects, then its icon and
 * name on one line, Pin, and its menu.
 */
export function SpaceHeader({
  entry,
  pinned,
  onTogglePin,
  actionsFor,
  onBack,
}: {
  entry: ProjectEntry;
  pinned: boolean;
  onTogglePin: () => void;
  actionsFor: () => FavoriteAction[];
  /** Opens the Projects page. */
  onBack: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <header className="mb-6">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 mb-4 flex items-center gap-1 rounded-md px-1 text-body text-muted-foreground hover:text-foreground [&_svg]:size-4"
      >
        <ArrowLeft aria-hidden />
        Projects
      </button>
      <div className="flex items-center gap-3">
        <ProjectTile entry={entry} size="mark" />
        <h1 className="min-w-0 flex-1 truncate text-display leading-none font-semibold tracking-tight">
          {entry.name}
        </h1>
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
    </header>
  );
}

/** A Space's threads under the composer, newest first, as the sidebar's thread cards show them. */
export function SpaceThreads({
  host,
  space,
  view,
  onOpenThread,
}: {
  /** The computer the Space, and so each thread in it, is on. */
  host: Host;
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
        run,
        at: activeAt(t, run, state.stoppedAt[t.id]),
        attention: attentionOf(t, run, asksOf(state, t.id), waitingOf(state, t.id)),
      };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <section aria-label="Threads">
      <h2 className="mb-2 text-reading font-medium">Threads</h2>
      {threads.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-hover text-muted-foreground">
            <MessagesSquare aria-hidden className="size-5" />
          </span>
          <p className="mt-3 text-body font-medium">No threads yet</p>
          <p className="mt-1 max-w-xs text-body text-muted-foreground">
            Ask anything above. Each thread here follows this Space's instructions and can read its
            files.
          </p>
        </div>
      ) : (
        <ul className="-mx-2 flex flex-col gap-1">
          {threads.map(({ thread, run, at, attention }) => {
            const Logo = run?.backend ? backendLogo(run.backend) : undefined;
            return (
              <li key={thread.id} className="group/row rounded-lg hover:bg-hover">
                <button
                  type="button"
                  onClick={() => onOpenThread(thread.id)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-transform duration-100 active:scale-[0.985]"
                >
                  <span className="flex h-4.5 w-full items-center gap-2 text-meta text-faint-foreground">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <RepoIcon repo={space} />
                      <span className="truncate">{space.name}</span>
                    </span>
                    <span className="shrink-0">
                      {attention === "settled" ? age(at) : <AttentionBadge attention={attention} />}
                    </span>
                  </span>
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-body font-semibold transition-colors group-hover/row:font-bold">
                      {state.titles[thread.id] ?? "Thread"}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-meta text-faint-foreground [&_svg]:size-3.5">
                      {hostIcon(host)}
                      {host.name}
                      {Logo && (
                        <>
                          <span aria-hidden>·</span>
                          <Logo className="opacity-80 grayscale" />
                        </>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A Space's instructions and files, beside its threads, in one panel that stays in view. */
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
    <div className="overflow-hidden rounded-xl border border-border bg-surface lg:sticky lg:top-6">
      <Instructions space={space} view={view} />
      <Files hostId={hostId} space={space} view={view} />
    </div>
  );
}

/** The panel's Instructions: what every thread here is told, edited in a dialog. */
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
    <section aria-label="Instructions" className={panelPart}>
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
 * The panel's Files: each file as a card with its preview and Remove, then an Add card, or a drop
 * anywhere on it, which uploads to the host.
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
      className={`${panelPart} border-t border-border transition-colors ${over ? "bg-accent/5" : ""}`}
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
      </div>
      {files.length === 0 ? (
        <button
          type="button"
          aria-label="Add files"
          disabled={!caps || adding}
          onClick={pick}
          className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors disabled:opacity-50 ${over ? "border-accent" : "border-border hover:bg-hover"}`}
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
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {files.map((path) => (
            <li key={path} className="flex min-w-0 flex-col gap-1.5">
              <FileCard
                file={path}
                hostId={hostId}
                fill
                // An add in flight saves the list as it began, which would undo a remove.
                onRemove={adding ? undefined : () => void save(files.filter((f) => f !== path))}
              />
              <span className="truncate px-0.5 text-meta text-muted-foreground">
                {path.split(/[\\/]/).at(-1)}
              </span>
            </li>
          ))}
          <li className="flex flex-col">
            <button
              type="button"
              aria-label="Add files"
              disabled={!caps || adding}
              onClick={pick}
              className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-meta text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50 [&_svg]:size-4"
            >
              <Plus aria-hidden />
              {adding ? "Adding…" : "Add"}
            </button>
          </li>
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
