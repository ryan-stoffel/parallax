// A Project's page, New thread laid out as a page (0090): its header, the composer, then its threads
// beside the instructions and files plxd gives every thread in it.
import {
  Archive,
  ArrowLeft,
  Check,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useId, useRef, useState, type DragEvent, type Ref } from "react";

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
import { asksOf, projectOf, waitingOf, type ThreadsView } from "./threads";
import { IconButton } from "./ui";
import { toast } from "./undo";
import { uploadBytes, uploadFiles } from "./uploads";

const panelPart = "p-5";
const panelHead = "mb-3 flex items-center justify-between gap-2";

/**
 * A Project's header, in place of New thread's question: a way back to Projects, then its icon and
 * name on one line, Pin, and its menu. Where its plxd keeps icons, the icon turns to a pencil on hover
 * and opens the icon picker.
 */
export function ProjectHeader({
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
  /** Opens the orchestrators page. */
  onBack: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const changeIcon = actionsFor().find((a) => a.label === "Change icon…");
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
        {changeIcon ? (
          <button
            type="button"
            aria-label="Change icon"
            title="Change icon"
            onClick={(e) => changeIcon.run(e.currentTarget)}
            className="group relative -m-1 shrink-0 rounded-md p-1"
          >
            <ProjectTile entry={entry} size="mark" />
            <span className="absolute inset-0 grid place-items-center rounded-md bg-surface text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [&_svg]:size-4">
              <Pencil aria-hidden />
            </span>
          </button>
        ) : (
          <ProjectTile entry={entry} size="mark" />
        )}
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

/**
 * A Project's threads under the composer, newest first, as the sidebar's thread cards show them:
 * those started in it, and those the user added. Each archives from its card, as in the sidebar,
 * and Add opens a picker of this computer's other threads.
 */
export function ProjectThreads({
  host,
  project,
  view,
  onOpenThread,
}: {
  /** The computer the Project, and so each thread in it, is on. */
  host: Host;
  project: Repo;
  view: ThreadsView;
  onOpenThread: (threadId: string) => void;
}) {
  const { state } = view;
  const picker = useRef<HTMLDialogElement>(null);
  const canAdd = "projectThreads" in view.capabilities;
  const archive = async (thread: string, title: string) => {
    const failed = await view.archive(thread, true);
    if (failed)
      return notify({ tone: "error", title: "Couldn't archive the thread", body: failed });
    toast(`Archived “${title}”`, () => void view.archive(thread, false));
  };
  const threads = state.threads
    .filter((t) => projectOf(state, t) === project.id && !t.parent && !t.archived)
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
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-reading font-medium">Threads</h2>
        {canAdd && (
          <IconButton label="Add threads" onClick={() => picker.current?.showModal()}>
            <Plus />
          </IconButton>
        )}
      </div>
      {threads.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-hover text-muted-foreground">
            <MessagesSquare aria-hidden className="size-5" />
          </span>
          <p className="mt-3 text-body font-medium">No threads yet</p>
          <p className="mt-1 max-w-xs text-body text-muted-foreground">
            Ask anything above, or add threads you've started. Each thread here follows this
            Project's instructions and can read its files.
          </p>
        </div>
      ) : (
        <ul className="-mx-2 flex flex-col gap-1">
          {threads.map(({ thread, run, at, attention }) => {
            const Logo = run?.backend ? backendLogo(run.backend) : undefined;
            const title = state.titles[thread.id] ?? "Thread";
            return (
              <li key={thread.id} className="group/row relative rounded-lg hover:bg-hover">
                <button
                  type="button"
                  onClick={() => onOpenThread(thread.id)}
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-transform duration-100 active:scale-[0.985]"
                >
                  <span className="flex h-4.5 w-full items-center gap-2 text-meta text-faint-foreground">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <RepoIcon repo={project} />
                      <span className="truncate">{project.name}</span>
                    </span>
                    <span className="shrink-0 group-focus-within/row:invisible group-hover/row:invisible">
                      {attention === "settled" ? age(at) : <AttentionBadge attention={attention} />}
                    </span>
                  </span>
                  <span className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-body font-semibold transition-colors group-hover/row:font-bold">
                      {title}
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
                <button
                  type="button"
                  title="Archive (E)"
                  onClick={() => void archive(thread.id, title)}
                  className="absolute top-1 right-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
                >
                  <Archive aria-hidden />
                  Archive
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {canAdd && <AddThreads ref={picker} project={project} view={view} />}
    </section>
  );
}

/**
 * Add threads: this computer's threads outside the Project, newest first, to search and check, then
 * add. A thread started in a Project lives there, and an orchestrator's in its orchestrator, so
 * neither shows.
 */
function AddThreads({
  ref,
  project,
  view,
}: {
  ref: Ref<HTMLDialogElement>;
  project: Repo;
  view: ThreadsView;
}) {
  const { state } = view;
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const titleId = useId();
  const homes = new Map(state.repos.map((r) => [r.id, r]));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const threads = state.threads
    .filter((t) => {
      const home = homes.get(t.repo);
      return home && !home.project && !t.parent && !t.archived && t.project !== project.id;
    })
    .map((t) => {
      const run = state.runs[t.id];
      const home = homes.get(t.repo)!;
      return {
        thread: t,
        title: state.titles[t.id] ?? "Thread",
        // Where it is now: the Project it was added to, else where it works.
        place: (t.project && homes.get(t.project)) || home,
        at: activeAt(t, run, state.stoppedAt[t.id]),
      };
    })
    .filter(({ title, place }) => {
      const text = `${title} ${place.scratch ? "No repo" : place.name}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };
  const reset = () => {
    setQuery("");
    setPicked(new Set());
    setError(undefined);
  };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={reset}
      className="m-auto w-[min(36rem,90vw)] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        method="dialog"
        onSubmit={async (e) => {
          e.preventDefault();
          const dialog = e.currentTarget.closest("dialog");
          setAdding(true);
          const failed = await view.setProject([...picked], project.id);
          setAdding(false);
          if (failed) return setError(failed);
          dialog?.close();
        }}
        className="flex flex-col p-5"
      >
        <h2 id={titleId} className="text-reading font-semibold">
          Add threads to {project.name}
        </h2>
        <p className="mt-1 text-body text-muted-foreground">
          They keep working where they are, and follow this Project's instructions from their next
          message.
        </p>
        <label className="mt-4 flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:outline-2 focus-within:outline-ring">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            type="search"
            aria-label="Search threads"
            placeholder="Search threads"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <ul
          aria-label="Threads to add"
          className="-mx-2 mt-3 flex h-80 flex-col gap-0.5 overflow-y-auto"
        >
          {threads.length === 0 && (
            <li className="m-auto text-body text-faint-foreground">
              {words.length ? "Nothing matches" : "No other threads on this computer"}
            </li>
          )}
          {threads.map(({ thread, title, place, at }) => (
            <li key={thread.id}>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-hover ${picked.has(thread.id) ? "bg-accent/8" : ""}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Add ${title}`}
                  checked={picked.has(thread.id)}
                  onChange={() => toggle(thread.id)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className="grid size-4 shrink-0 place-items-center rounded-sm border border-faint-foreground/50 bg-background text-accent-foreground peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-ring [&_svg]:invisible peer-checked:[&_svg]:visible"
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">{title}</span>
                  <span className="flex items-center gap-1.5 text-meta text-faint-foreground">
                    <RepoIcon repo={place} />
                    <span className="truncate">{place.scratch ? "No repo" : place.name}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{age(at)}</span>
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="mt-2 text-meta text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={(e) => e.currentTarget.closest("dialog")?.close()}
            className="rounded-md px-3 py-1.5 text-body hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={adding || picked.size === 0}
            className="rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            {adding ? "Adding…" : picked.size > 1 ? `Add ${picked.size} threads` : "Add"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** A Project's instructions and files, beside its threads, in one panel that stays in view. */
export function ProjectContext({
  hostId,
  project,
  view,
}: {
  hostId: string;
  project: Repo;
  view: ThreadsView;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface lg:sticky lg:top-6">
      <Instructions project={project} view={view} />
      <Files hostId={hostId} project={project} view={view} />
    </div>
  );
}

/** The panel's Instructions: what every thread here is told, edited in a dialog. */
function Instructions({ project, view }: { project: Repo; view: ThreadsView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const open = () => {
    setText(project.instructions ?? "");
    setError(undefined);
    dialog.current?.showModal();
  };
  return (
    <section aria-label="Instructions" className={panelPart}>
      <div className={panelHead}>
        <h2 className="text-reading font-medium">Instructions</h2>
        <button
          type="button"
          aria-label={project.instructions ? "Edit instructions" : "Add instructions"}
          onClick={open}
          className={quietButton}
        >
          {project.instructions ? "Edit" : "Add"}
        </button>
      </div>
      {project.instructions ? (
        <button
          type="button"
          onClick={open}
          className="line-clamp-[12] text-left text-body leading-relaxed whitespace-pre-wrap text-muted-foreground hover:text-foreground"
        >
          {project.instructions}
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
            const failed = await view.updateRepo(project.id, { instructions: text });
            setSaving(false);
            if (failed) return setError(failed);
            dialog.current?.close();
          }}
          className="flex flex-col p-5"
        >
          <h2 id={titleId} className="text-reading font-semibold">
            Instructions for {project.name}
          </h2>
          <p className="mt-1 text-body text-muted-foreground">
            New threads in this Project follow them.
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
function Files({ hostId, project, view }: { hostId: string; project: Repo; view: ThreadsView }) {
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState(false);
  const caps = uploadBytes(useConnection(hostId));
  const files = project.files ?? [];
  const save = async (next: string[]) => {
    const failed = await view.updateRepo(project.id, { files: next });
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
