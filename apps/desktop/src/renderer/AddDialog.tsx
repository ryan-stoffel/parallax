import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Folder,
  FolderGit2,
  FolderKanban,
  FolderOpen,
  Search,
} from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { flushSync } from "react-dom";

import { githubSlug, isFolderName, type FolderListing } from "../preload/bridge";
import type { Project, Repo } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { localId, type Host } from "./hosts";
import { GitHubLogo } from "./logos";
import { NewProjectForm } from "./NewProjectForm";
import type { ThreadsView } from "./threads";
import { uuidv7 } from "./uuidv7";
import type { Workspace, WorkspaceSource } from "./WorkspaceMenu";

/** A key in a palette's footer of keys. */
export const kbd = "rounded-md bg-selected px-1.5 py-0.5 font-sans text-[11.5px] text-foreground";

type Step = { kind: "menu" | WorkspaceSource | "project" } | { kind: "cloneTo"; slug: string };

/** Opens the palette, at its menu or straight at Create Project. */
export type AddDialogHandle = { open: (start?: "project") => void };

/**
 * The sidebar's add palette, a native modal <dialog> laid out like a command palette. Its menu
 * offers New repository, Local folder, Clone from GitHub, and New Project, and each opens a step
 * of its own in the same dialog; Back returns to the step before. The first three make a
 * repository on this computer and register it with its plxd (`repo/add`), then close, or, when
 * Create Project's Workspace menu asked for it, return there with it chosen.
 */
export function AddDialog({
  ref,
  hosts,
  hostId,
  repos,
  create,
  onCreated,
}: {
  ref: Ref<AddDialogHandle>;
  hosts: Host[];
  /** The open host, whose first repository is Create Project's default. */
  hostId: string;
  /** The open host's repo entries. */
  repos: Repo[];
  /** Creates a Project on the open host. */
  create: ThreadsView["createProject"];
  onCreated: (hostId: string, project: Project) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [stack, setStack] = useState<Step[]>([{ kind: "menu" }]);
  // A new one each time it closes, so every step opens empty again.
  const [session, setSession] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace>();
  const step = stack.at(-1)!;

  useImperativeHandle(ref, () => ({
    open: (start) => {
      // Rendered before showModal, which focuses the step's autofocus field.
      flushSync(() => setStack([{ kind: start ?? "menu" }]));
      dialog.current?.showModal();
    },
  }));

  // Back on Create Project, from its own Workspace's step or on opening there: its name.
  useEffect(() => {
    if (step.kind === "project")
      dialog.current?.querySelector<HTMLInputElement>('input[aria-label="Name"]')?.focus();
  }, [step.kind]);

  const push = (next: Step) => setStack((all) => [...all, next]);
  const back = () =>
    stack.length > 1 ? setStack((all) => all.slice(0, -1)) : dialog.current?.close();
  const added = (repo: Repo) => {
    // Closed while it was being made, as with Escape: drop the late answer.
    if (!dialog.current?.open) return;
    const project = stack.findIndex((s) => s.kind === "project");
    if (project < 0) return dialog.current?.close();
    setWorkspace({ hostId: localId, repo });
    setStack((all) => all.slice(0, project + 1));
  };
  const steps = { onBack: back, onAdded: added };

  return (
    <dialog
      ref={dialog}
      aria-label="New project or repository"
      onClose={() => {
        setStack([{ kind: "menu" }]);
        setWorkspace(undefined);
        setSession((n) => n + 1);
      }}
      className="mx-auto mt-[14vh] w-[36rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface p-0 text-foreground shadow-composer backdrop:bg-black/50"
    >
      {step.kind === "menu" && (
        <MenuStep key={session} onBack={back} onPick={(kind) => push({ kind })} />
      )}
      {step.kind === "create" && <CreateStep {...steps} />}
      {step.kind === "browse" && <FolderStep {...steps} />}
      {step.kind === "clone" && (
        <CloneStep onBack={back} onNext={(slug) => push({ kind: "cloneTo", slug })} />
      )}
      {step.kind === "cloneTo" && <FolderStep {...steps} slug={step.slug} />}
      {/* Kept while its Workspace's step is open, so what's typed in it stays. */}
      {stack.some((s) => s.kind === "project") && (
        <div hidden={step.kind !== "project"}>
          <NewProjectForm
            key={session}
            hosts={hosts}
            hostId={hostId}
            repos={repos}
            create={create}
            chosen={workspace}
            onChoose={setWorkspace}
            onAdd={(kind) => push({ kind })}
            onBack={back}
            onCreated={onCreated}
          />
        </div>
      )}
    </dialog>
  );
}

type StepProps = { onBack: () => void; onAdded: (repo: Repo) => void };

const menu: { kind: WorkspaceSource | "project"; name: string; detail: string; icon: ReactNode }[] =
  [
    {
      kind: "create",
      name: "New repository",
      detail: "Start an empty repository in ~/.parallax/projects",
      icon: <FolderGit2 />,
    },
    {
      kind: "browse",
      name: "Local folder",
      detail: "Add a repository that's already on this computer",
      icon: <FolderOpen />,
    },
    {
      kind: "clone",
      name: "Clone from GitHub",
      detail: "Clone a repository by its owner/name",
      icon: <GitHubLogo />,
    },
    {
      kind: "project",
      name: "New Project",
      detail: "A focused chat where agents coordinate work",
      icon: <FolderKanban />,
    },
  ];

/** The palette's first step: what to add, searchable. */
function MenuStep({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (kind: WorkspaceSource | "project") => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const shown = menu.filter((m) => `${m.name} ${m.detail}`.toLowerCase().includes(q));
  const list = useList(shown.length, active, setActive);
  return (
    <>
      <Header onBack={onBack}>
        <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
        <input
          ref={autofocus}
          {...list.input}
          aria-label="Search"
          placeholder="Search…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            list.onKeyDown(e);
            const picked = shown[list.active];
            if (e.key !== "Enter" || !picked) return;
            // Else the Enter would go on to submit Create Project's form, which it focuses.
            e.preventDefault();
            onPick(picked.kind);
          }}
          className={field}
        />
      </Header>
      <Body>
        <Options
          list={list}
          label="Add"
          options={shown.map((m) => ({ id: m.kind, ...m }))}
          onPick={(o) => onPick(o.id as WorkspaceSource | "project")}
        />
        {shown.length === 0 && <Note>Nothing matches</Note>}
      </Body>
      <Footer keys={[navigate, ["Enter", "Pick"], close]} />
    </>
  );
}

/** New repository: a name, then `~/.parallax/projects/<name>` with git init. */
function CreateStep({ onBack, onAdded }: StepProps) {
  const [name, setName] = useState("");
  const add = useAdd(onAdded);
  const trimmed = name.trim();
  const valid = isFolderName(trimmed);
  const submit = () =>
    valid && void add.run(`create:${trimmed}`, () => window.parallax.createRepo(trimmed));
  return (
    <>
      <Header
        onBack={onBack}
        action={
          <Action
            label={add.busy ? "Creating…" : "Create"}
            keys="Enter"
            disabled={!valid || add.busy}
            onClick={submit}
          />
        }
      >
        <input
          ref={autofocus}
          aria-label="Repository name"
          placeholder="Repository name"
          value={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
          className={field}
        />
      </Header>
      <Body>
        <Note>
          {trimmed && !valid
            ? "Use letters, digits, ., _, and - only."
            : `Creates ~/.parallax/projects/${trimmed || "<name>"} as a git repository, ready for threads.`}
        </Note>
        <Problem error={add.error} />
      </Body>
      <Footer keys={[["Enter", "Create"], close]} />
    </>
  );
}

/** Clone from GitHub's first step: which repository. */
function CloneStep({ onBack, onNext }: { onBack: () => void; onNext: (slug: string) => void }) {
  const [text, setText] = useState("");
  const slug = githubSlug(text);
  return (
    <>
      <Header
        onBack={onBack}
        action={
          <Action label="Next" keys="Enter" disabled={!slug} onClick={() => slug && onNext(slug)} />
        }
      >
        <GitHubLogo className="size-4 shrink-0 text-faint-foreground" />
        <input
          ref={autofocus}
          aria-label="Repository"
          placeholder="owner/name"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (slug) onNext(slug);
          }}
          className={field}
        />
      </Header>
      <Body>
        {slug ? (
          <GithubRepo slug={slug} />
        ) : (
          <Note>Type a GitHub repository as owner/name, or paste its URL.</Note>
        )}
      </Body>
      <Footer keys={[["Enter", "Next"], close]} />
    </>
  );
}

/**
 * Local folder, or with `slug`, where Clone from GitHub clones it. The field is a path from `~/`;
 * the list is its folder's folders, filtered by what's typed after its last `/` (but not when
 * cloning, where that's the clone's own name). Enter opens the highlighted folder, Backspace at a
 * folder's end goes up, and Mod+Enter adds the folder, or clones into the path.
 */
function FolderStep({ onBack, onAdded, slug }: StepProps & { slug?: string }) {
  const repoName = slug?.split("/")[1];
  const [text, setText] = useState(repoName ? `~/${repoName}` : "~/");
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1;
  const dir = text.slice(0, cut);
  const leaf = text.slice(cut);
  const [listing, setListing] = useState<{ dir: string; result: FolderListing }>();
  useEffect(() => {
    let stale = false;
    void window.parallax.listFolders(dir || "~/").then((result) => {
      if (!stale) setListing({ dir, result });
    });
    return () => {
      stale = true;
    };
  }, [dir]);
  const current = listing?.dir === dir ? listing.result : undefined;
  const filter = slug ? "" : leaf.toLowerCase();
  const folders = (current && "folders" in current ? current.folders : []).filter(
    (f) =>
      (filter.startsWith(".") || !f.name.startsWith(".")) && f.name.toLowerCase().includes(filter),
  );
  const [active, setActive] = useState(0);
  const list = useList(folders.length, active, setActive);
  const highlighted = folders[list.active];
  const add = useAdd(onAdded);
  const go = (next: string) => {
    setText(next);
    setActive(0);
  };

  // Cloning goes to the path as typed. Adding takes the open folder, or the highlighted one once
  // something's typed after it.
  let target: string | undefined;
  if (slug) target = leaf ? text : undefined;
  else if (!leaf) target = current && "path" in current ? current.path : undefined;
  else target = highlighted?.path;
  const submit = () => {
    if (!target) return;
    if (slug) {
      const dest = target;
      void add.run(`clone:${slug}:${dest}`, () => window.parallax.cloneRepo(slug, dest));
    } else void add.run(`add:${target}`, async () => ({ path: target }));
  };
  const busyLabel = slug ? "Cloning…" : "Adding…";

  return (
    <>
      <Header
        onBack={onBack}
        action={
          <Action
            label={add.busy ? busyLabel : slug ? "Clone" : "Add"}
            keys={`${mod()} Enter`}
            disabled={!target || add.busy}
            onClick={submit}
          />
        }
      >
        <input
          ref={autofocus}
          {...list.input}
          aria-label={slug ? "Clone into" : "Folder"}
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => go(e.target.value)}
          onKeyDown={(e) => {
            list.onKeyDown(e);
            const box = e.currentTarget;
            const atEnd = box.selectionStart === text.length && box.selectionEnd === text.length;
            if (e.key === "Enter") e.preventDefault();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            else if (e.key === "Enter" && highlighted)
              go(`${dir}${highlighted.name}/${slug ? leaf : ""}`);
            else if (e.key === "Backspace" && atEnd && leaf === (repoName ?? "")) {
              const up = parent(dir);
              if (up === undefined) return;
              e.preventDefault();
              go(`${up}${leaf}`);
            }
          }}
          className={field}
        />
      </Header>
      <Body>
        {slug && (
          <>
            <Heading>Repository</Heading>
            <GithubRepo slug={slug} />
          </>
        )}
        <Heading>{slug ? "Select where to clone" : "Folders"}</Heading>
        <Options
          list={list}
          label="Folders"
          options={folders.map((f) => ({ id: f.path, name: f.name, icon: <Folder /> }))}
          onPick={(o) => go(`${dir}${o.name}/${slug ? leaf : ""}`)}
        />
        {current && "error" in current && <Note>{current.error}</Note>}
        {current && "folders" in current && folders.length === 0 && (
          <Note>{filter ? "No folders match" : "No folders here"}</Note>
        )}
        <Problem error={add.error} />
      </Body>
      <Footer keys={[navigate, ["Enter", "Open"], ["Backspace", "Back"], close]}>
        <button
          type="button"
          onClick={async () => {
            const picked = await window.parallax.pickFolder();
            if (picked) go(`${picked}/${slug ? leaf : ""}`);
          }}
          className="ml-auto rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-foreground"
        >
          {chooseInFiles()}
        </button>
      </Footer>
    </>
  );
}

/** `dir`'s parent, both ending in a separator, or undefined at the top (`~/` or `/`). */
export function parent(dir: string): string | undefined {
  const trimmed = dir.slice(0, -1);
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? undefined : trimmed.slice(0, cut + 1);
}

/**
 * Makes a repository on this computer, then registers it with its plxd. `key` names what's made,
 * so a retry after a failed `repo/add` registers the same one rather than making it again.
 */
function useAdd(onAdded: (repo: Repo) => void) {
  const made = useRef<{ key: string; path: string }>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A ref, so a second Enter before the first re-renders is dropped too.
  const running = useRef(false);
  const run = async (key: string, make: () => Promise<{ path: string } | { error: string }>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (made.current?.key !== key) {
        const result = await make();
        if ("error" in result) return setError(result.error);
        made.current = { key, path: result.path };
      }
      // A fresh id is safe to retry with: plxd returns the entry a path already has.
      const answer = await window.parallax.request(localId, "repo/add", {
        id: uuidv7(),
        path: made.current.path,
      });
      if ("error" in answer) setError(describeError(answer.error));
      else onAdded(answer.result.repo);
    } catch (error) {
      setError(String(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Up and Down over a palette's list, which the field's `aria-activedescendant` points into. */
function useList(count: number, active: number, setActive: (i: number) => void) {
  const id = useId();
  const at = Math.max(0, Math.min(active, count - 1));
  return {
    id,
    active: at,
    setActive,
    input: {
      role: "combobox",
      "aria-expanded": true,
      "aria-controls": id,
      "aria-activedescendant": count > 0 ? `${id}-${at}` : undefined,
    } as const,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!step || count === 0) return;
      e.preventDefault();
      setActive((at + step + count) % count);
    },
  };
}

type Option = { id: string; name: string; detail?: string; icon: ReactNode };

function Options({
  list,
  label,
  options,
  onPick,
}: {
  list: ReturnType<typeof useList>;
  label: string;
  options: Option[];
  onPick: (option: Option) => void;
}) {
  return (
    <div id={list.id} role="listbox" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.id}
          id={`${list.id}-${i}`}
          type="button"
          role="option"
          tabIndex={-1}
          aria-selected={i === list.active}
          data-active={i === list.active || undefined}
          ref={i === list.active ? (el) => el?.scrollIntoView?.({ block: "nearest" }) : undefined}
          // Keeps the field focused, so the keys go on working.
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => i !== list.active && list.setActive(i)}
          onClick={() => onPick(o)}
          className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left data-active:bg-hover [&>svg]:size-5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
        >
          {o.icon}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px]">{o.name}</span>
            {o.detail && (
              <span className="block truncate text-[12.5px] text-muted-foreground">{o.detail}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function GithubRepo({ slug }: { slug: string }) {
  return (
    <div className="flex items-center gap-3 px-2.5 py-2">
      <GitHubLogo className="size-5 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate text-[14px]">{slug}</span>
        <span className="block truncate text-[12.5px] text-muted-foreground">
          https://github.com/{slug}
        </span>
      </span>
    </div>
  );
}

function Header({
  onBack,
  action,
  children,
}: {
  onBack: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
      >
        <ArrowLeft />
      </button>
      {children}
      {action}
    </div>
  );
}

/** The step's main action, with its keys: Add, Clone, Create, or Next. */
function Action({
  label,
  keys,
  disabled,
  onClick,
}: {
  label: string;
  keys: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-lg border border-border py-1 pr-1 pl-2.5 text-[13px] enabled:hover:bg-hover disabled:opacity-50"
    >
      {label}
      <kbd className={`${kbd} text-muted-foreground`}>{keys}</kbd>
    </button>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <div className="max-h-[24rem] overflow-y-auto px-2 pb-2">{children}</div>;
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-faint-foreground">{children}</p>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-2 text-[13px] text-faint-foreground">{children}</p>;
}

function Problem({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="px-2.5 py-2 text-[12.5px] text-danger">
      {error}
    </p>
  ) : null;
}

const navigate: [ReactNode, string] = [
  <>
    <kbd className={`${kbd} grid size-5.5 place-items-center p-0`}>
      <ArrowUp className="size-3" />
    </kbd>
    <kbd className={`${kbd} grid size-5.5 place-items-center p-0`}>
      <ArrowDown className="size-3" />
    </kbd>
  </>,
  "Navigate",
];
const close: [ReactNode, string] = ["Esc", "Close"];

function Footer({ keys, children }: { keys: [ReactNode, string][]; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-t border-border bg-background/40 px-4 py-2.5 text-[12.5px] text-muted-foreground">
      {keys.map(([key, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          {typeof key === "string" ? <kbd className={kbd}>{key}</kbd> : key}
          {label}
        </span>
      ))}
      {children}
    </div>
  );
}

const field =
  "min-w-0 flex-1 bg-transparent text-[14px] placeholder:text-faint-foreground focus-visible:outline-none";

const mod = () => (window.parallax.platform === "darwin" ? "⌘" : "Ctrl");

const chooseInFiles = () =>
  ({ darwin: "Choose in Finder", win32: "Choose in Explorer" })[window.parallax.platform] ??
  "Choose in Files";

/** Focuses a step's field: now, or, while the dialog is closed, when showModal opens it. */
function autofocus(el: HTMLInputElement | null) {
  el?.setAttribute("autofocus", "");
  el?.focus();
}
