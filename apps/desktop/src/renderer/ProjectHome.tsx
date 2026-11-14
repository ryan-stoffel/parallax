// A Project's page, New thread laid out as a page (0090): its header, the composer, then its threads
// beside the instructions and files plxd gives every thread in it.
import { t } from "i18next";
import {
  Archive,
  ArrowLeft,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";

import type { Repo } from "../protocol/generated/protocol";
import { close, Footer } from "./AddDialog";
import { activeAt, attentionOf } from "./attention";
import { AttentionBadge } from "./AttentionMark";
import { useShownConnection } from "./ConnectionStatus";
import type { FavoriteAction } from "./Favorites";
import { FileCard } from "./FileCard";
import { notify } from "./notifications";
import type { ProjectEntry } from "./projectList";
import { ProjectMenu, ProjectTile } from "./ProjectsPage";
import { quietButton } from "./settings/parts";
import type { Host } from "./hosts";
import { hostIcon } from "./RunTargetMenu";
import { age, backendLogo, ProjectIcon, RepoIcon, type HostThreads } from "./Sidebar";
import { Check as CheckSymbol } from "./symbols";
import { addToProject, asksOf, projectOf, waitingOf, type ThreadsView } from "./threads";
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
  // By its label, English or shown.
  const changeIcon = actionsFor().find(
    (a) => a.label === "Change icon…" || a.label === t("Change icon…"),
  );
  return (
    <header className="mb-6">
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 mb-4 flex items-center gap-1 rounded-md px-1 text-body text-muted-foreground hover:text-foreground [&_svg]:size-4"
      >
        <ArrowLeft aria-hidden />
        {t("Projects")}
      </button>
      <div className="flex items-center gap-3">
        {changeIcon ? (
          <button
            type="button"
            aria-label={t("Change icon")}
            title={t("Change icon")}
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
        <IconButton label={pinned ? t("Unpin") : t("Pin")} onClick={onTogglePin}>
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

/** The ids `project` goes by on `where`: its own on its computer, else its namesakes' (0097). */
function projectIds(where: HostThreads, home: Host, project: Repo) {
  return new Set(
    where.host.id === home.id
      ? [project.id]
      : where.view.state.repos.filter((r) => r.project && r.name === project.name).map((r) => r.id),
  );
}

/**
 * A thread's card, as the sidebar draws it: `place` and `status` over its title, its computer, and
 * its provider's logo.
 */
function ThreadCardText({
  place,
  status,
  title,
  host,
  backend,
}: {
  place: ReactNode;
  status: ReactNode;
  title: string;
  host: Host;
  backend?: string | undefined;
}) {
  const Logo = backend ? backendLogo(backend) : undefined;
  return (
    <>
      <span className="flex h-4.5 w-full items-center gap-2 text-meta text-faint-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{place}</span>
        {status}
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
    </>
  );
}

/**
 * A Project's threads under the composer, newest first, as the sidebar's thread cards show them:
 * those started in it or added to it, on its computer and on any computer with a Project of its name
 * (0097). Each archives from its card, as in the sidebar, and Add opens a picker of the other threads.
 */
export function ProjectThreads({
  host,
  project,
  computers,
  onOpenThread,
}: {
  /** The computer `project` is on. */
  host: Host;
  project: Repo;
  /** Every computer, whose threads the page and its picker list. */
  computers: HostThreads[];
  onOpenThread: (hostId: string, threadId: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const canAdd = computers.some(({ view }) => "projectThreads" in view.capabilities);
  const archive = async (view: ThreadsView, thread: string, title: string) => {
    const failed = await view.archive(thread, true);
    if (failed)
      return notify({ tone: "error", title: t("Couldn't archive the thread"), body: failed });
    toast(t("Archived “{{title}}”", { title }), () => void view.archive(thread, false));
  };
  const threads = computers
    .flatMap((computer) => {
      const { state } = computer.view;
      const ids = projectIds(computer, host, project);
      return state.threads
        .filter(
          (thread) => ids.has(projectOf(state, thread) ?? "") && !thread.parent && !thread.archived,
        )
        .map((thread) => {
          const run = state.runs[thread.id];
          return {
            ...computer,
            thread,
            title: state.titles[thread.id] ?? t("Thread"),
            run,
            at: activeAt(thread, run, state.stoppedAt[thread.id]),
            attention: attentionOf(
              thread,
              run,
              asksOf(state, thread.id),
              waitingOf(state, thread.id),
            ),
          };
        });
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <section aria-label={t("Threads")}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-reading font-medium">{t("Threads")}</h2>
        {canAdd && (
          <IconButton label={t("Add threads")} onClick={() => setPicking(true)}>
            <Plus />
          </IconButton>
        )}
      </div>
      {threads.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-hover text-muted-foreground">
            <MessagesSquare aria-hidden className="size-5" />
          </span>
          <p className="mt-3 text-body font-medium">{t("No threads yet")}</p>
          <p className="mt-1 max-w-xs text-body text-muted-foreground">
            {t(
              "Ask anything above, or add threads you've started. Each thread here follows this Project's instructions and can read its files.",
            )}
          </p>
        </div>
      ) : (
        <ul className="-mx-2 flex flex-col gap-1">
          {threads.map(({ host: where, view, thread, title, run, at, attention }) => (
            <li
              key={`${where.id}/${thread.id}`}
              className="group/row relative rounded-lg hover:bg-hover"
            >
              <button
                type="button"
                onClick={() => onOpenThread(where.id, thread.id)}
                className="flex w-full flex-col gap-0.5 rounded-lg px-2 py-2 text-left transition-transform duration-100 active:scale-[0.985]"
              >
                <ThreadCardText
                  place={
                    <>
                      <RepoIcon repo={project} />
                      <span className="truncate">{project.name}</span>
                    </>
                  }
                  status={
                    <span className="shrink-0 group-focus-within/row:invisible group-hover/row:invisible">
                      {attention === "settled" ? age(at) : <AttentionBadge attention={attention} />}
                    </span>
                  }
                  title={title}
                  host={where}
                  backend={run?.backend}
                />
              </button>
              <button
                type="button"
                title={t("Archive ({{key}})", { key: "E" })}
                onClick={() => void archive(view, thread.id, title)}
                className="absolute top-1 right-1 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-meta text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
              >
                <Archive aria-hidden />
                {t("Archive")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picking && (
        <AddThreads
          host={host}
          project={project}
          computers={computers}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

/**
 * Add threads, New thread's picker in shape: the threads outside the Project on every computer that
 * can hold it, newest first, archived and orchestrator threads included, to search and check, then
 * add. A thread started in a Project lives there, and an orchestrator's child with its orchestrator,
 * so neither shows. It opens when mounted, and `onClose` should unmount it.
 */
function AddThreads({
  host,
  project,
  computers,
  onClose,
}: {
  host: Host;
  project: Repo;
  computers: HostThreads[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = computers
    .flatMap((computer) => {
      const { host: where, view } = computer;
      const { state, capabilities } = view;
      const ids = projectIds(computer, host, project);
      // Where it can't join, or can't make the Project it lacks, its threads don't show.
      if (!("projectThreads" in capabilities) || (ids.size === 0 && !("projects" in capabilities)))
        return [];
      const homes = new Map(state.repos.map((r) => [r.id, r]));
      return state.threads.flatMap((thread) => {
        const home = homes.get(thread.repo);
        const orchestrator = state.orchestrators.find((o) => o.run === thread.id);
        if ((home ? home.project : !orchestrator) || thread.parent || ids.has(thread.project ?? ""))
          return [];
        // Where it is now: the Project it was added to, else where it works.
        const added = thread.project ? homes.get(thread.project) : undefined;
        const repo = added ?? home;
        return {
          key: `${where.id}/${thread.id}`,
          view,
          where,
          thread,
          title: state.titles[thread.id] ?? orchestrator?.name ?? t("Thread"),
          backend: state.runs[thread.id]?.backend,
          repo,
          placeName: repo ? (repo.scratch ? t("No repo") : repo.name) : (orchestrator?.name ?? ""),
          placeIcon: orchestrator?.icon,
          at: activeAt(thread, state.runs[thread.id], state.stoppedAt[thread.id]),
        };
      });
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const shown = candidates.filter(({ title, placeName, where }) => {
    const text = `${title} ${placeName} ${where.name}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const chosen = candidates.filter((c) => picked.has(c.key));
  const toggle = (key: string) => {
    const next = new Set(picked);
    if (!next.delete(key)) next.add(key);
    setPicked(next);
  };
  return (
    <dialog
      ref={dialog}
      aria-label={t("Add threads to {{project}}", { project: project.name })}
      onClose={onClose}
      // It stays while adding, so a failure has somewhere to show.
      onCancel={(e) => adding && e.preventDefault()}
      // A click on the backdrop, outside the panel, closes it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !adding) e.currentTarget.close();
      }}
      className="mx-auto mt-[14vh] w-[36rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface p-0 text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setAdding(true);
          // A computer that fails leaves its threads checked, and the rest are out of the list.
          const failures = await Promise.all(
            computers.map(async ({ host: where, view }) => {
              const threads = chosen.filter((c) => c.where.id === where.id).map((c) => c.thread);
              return threads.length ? addToProject(view, threads, project) : undefined;
            }),
          );
          setAdding(false);
          const failed = failures.find((f) => f !== undefined);
          if (failed) return setError(failed);
          dialog.current?.close();
        }}
      >
        <div className="flex items-center gap-3 px-4 py-3.5">
          <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
          <input
            // The native attribute, so showModal focuses the search box.
            ref={(el) => el?.setAttribute("autofocus", "")}
            type="search"
            aria-label={t("Search threads")}
            placeholder={t("Add threads to {{project}}", { project: project.name })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-reading placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <ul
          aria-label={t("Threads to add")}
          className="flex h-[50vh] flex-col gap-1 overflow-y-auto px-2 pb-2"
        >
          {shown.length === 0 && (
            <li className="m-auto text-body text-faint-foreground">
              {words.length ? t("Nothing matches") : t("No other threads")}
            </li>
          )}
          {shown.map(({ key, where, thread, title, backend, repo, placeName, placeIcon, at }) => (
            <li
              key={key}
              // Off-screen rows skip layout, so a long list stays quick.
              className="group/row shrink-0 [contain-intrinsic-size:auto_56px] [content-visibility:auto]"
            >
              <label className="flex cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-2 hover:bg-hover has-checked:bg-selected has-focus-visible:outline-2 has-focus-visible:outline-ring">
                <input
                  type="checkbox"
                  aria-label={t("Add {{title}}", { title })}
                  checked={picked.has(key)}
                  onChange={() => toggle(key)}
                  className="sr-only"
                />
                <ThreadCardText
                  place={
                    <>
                      {placeIcon ? (
                        <ProjectIcon icon={placeIcon} className="size-4 shrink-0" />
                      ) : (
                        <RepoIcon repo={repo} />
                      )}
                      <span className="truncate">{placeName}</span>
                    </>
                  }
                  status={
                    picked.has(key) ? (
                      <CheckSymbol aria-hidden className="size-4 shrink-0 text-accent" />
                    ) : (
                      <span className="shrink-0">
                        {thread.archived ? t("Archived · {{age}}", { age: age(at) }) : age(at)}
                      </span>
                    )
                  }
                  title={title}
                  host={where}
                  backend={backend}
                />
              </label>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="px-4 pb-2 text-meta text-danger">
            {error}
          </p>
        )}
        <Footer keys={[close]}>
          <button
            type="submit"
            disabled={adding || chosen.length === 0}
            className="ml-auto rounded-md bg-primary px-3 py-1 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            {adding
              ? t("Adding…")
              : chosen.length > 1
                ? t("Add {{count}} threads", { count: chosen.length })
                : t("Add")}
          </button>
        </Footer>
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
    <section aria-label={t("Instructions")} className={panelPart}>
      <div className={panelHead}>
        <h2 className="text-reading font-medium">{t("Instructions")}</h2>
        <button
          type="button"
          aria-label={project.instructions ? t("Edit instructions") : t("Add instructions")}
          onClick={open}
          className={quietButton}
        >
          {project.instructions ? t("Edit") : t("Add")}
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
          {t(
            "Tell every thread here how to work: who it's for, the tone and format you want, and what it should know.",
          )}
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
            {t("Instructions for {{project}}", { project: project.name })}
          </h2>
          <p className="mt-1 text-body text-muted-foreground">
            {t("New threads in this Project follow them.")}
          </p>
          <textarea
            aria-label={t("Instructions")}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("Answer as a patient tutor. Show the steps, then the result.")}
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
              {t("Cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t("Saving…") : t("Save")}
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
  const caps = uploadBytes(useShownConnection(hostId));
  const files = project.files ?? [];
  const save = async (next: string[]) => {
    const failed = await view.updateRepo(project.id, { files: next });
    if (failed) notify({ tone: "error", title: t("Couldn't change the files"), body: failed });
  };
  const add = async (picked: File[]) => {
    if (!caps || picked.length === 0) return;
    const big = picked.find((f) => f.size > caps.maxBytes);
    if (big)
      return notify({
        tone: "error",
        title: t("Couldn't add the file"),
        body: t("{{file}} is larger than this host takes.", { file: big.name }),
      });
    setAdding(true);
    const paths = await uploadFiles(hostId, picked, caps.chunkBytes);
    if (typeof paths === "string")
      notify({ tone: "error", title: t("Couldn't add the file"), body: paths });
    else await save([...files, ...paths]);
    setAdding(false);
  };
  const pick = () => input.current?.click();
  const takesFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  return (
    <section
      aria-label={t("Files")}
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
          {t("Files")}
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
          aria-label={t("Add files")}
          disabled={!caps || adding}
          onClick={pick}
          className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors disabled:opacity-50 ${over ? "border-accent" : "border-border hover:bg-hover"}`}
        >
          <Upload aria-hidden className="size-5 text-faint-foreground" />
          <span className="text-body text-muted-foreground">
            {adding ? t("Adding…") : t("Drop files here, or click to add")}
          </span>
          <span className="text-meta text-faint-foreground">
            {t("PDFs, notes, or code every thread here can read")}
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
              aria-label={t("Add files")}
              disabled={!caps || adding}
              onClick={pick}
              className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-meta text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50 [&_svg]:size-4"
            >
              <Plus aria-hidden />
              {adding ? t("Adding…") : t("Add")}
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
