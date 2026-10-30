// The Projects page (0090, 0093): every host's Projects as cards, the row card the sidebar draws,
// with a search, a filter, a sort, and New project.
import { Check, Ellipsis, MessagesSquare, Pin, PinOff, X } from "lucide-react";
import { useId, useRef, useState, type CSSProperties, type Ref, type RefObject } from "react";

import type { ChosenIcon, Repo } from "../protocol/generated/protocol";
import type { FavoriteAction } from "./Favorites";
import { icons } from "./icons";
import { IconPicker } from "./IconPicker";
import { imageUrl } from "./images";
import { iconLook } from "./projectIcons";
import {
  filterProjects,
  sortProjects,
  type ProjectEntry,
  type ProjectFilter,
  type ProjectSort,
} from "./projectList";
import { RowCard, rowTool } from "./RowCard";
import { age, RowPlace } from "./Sidebar";
import { stored } from "./stored";
import {
  Button,
  buttonClass,
  EmptyState,
  Menu,
  menuItem,
  openOnContextMenu,
  Segmented,
} from "./ui";

const sorts: { value: ProjectSort; label: string }[] = [
  { value: "activity", label: "Recent activity" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
  { value: "threads", label: "Most threads" },
];

const filters: { value: ProjectFilter; name: string }[] = [
  { value: "all", name: "All" },
  { value: "pinned", name: "Pinned" },
  { value: "files", name: "With files" },
  { value: "instructions", name: "With instructions" },
];

/** What a filter that keeps nothing says, with no search typed. */
const filteredOut: Record<ProjectFilter, string> = {
  all: "No projects yet.",
  pinned: "No pinned projects. Pin one from its card.",
  files: "No projects with files.",
  instructions: "No projects with instructions.",
};

const projectSort = stored<ProjectSort>("parallax.projectSort", "activity", (raw, fallback) =>
  sorts.some((s) => s.value === raw) ? (raw as ProjectSort) : fallback,
);

/** A Project's color, as a CSS value: its icon's, the accent for an icon with none, else gray. */
function tint(entry: Pick<ProjectEntry, "icon">) {
  if (entry.icon?.color) return `var(--project-${entry.icon.color})`;
  return entry.icon ? "var(--accent)" : "var(--project-gray)";
}

/**
 * A Project's icon: its uploaded image, its glyph, or two speech bubbles when it has none. `mark`
 * draws only its glyph, large and in its color, as a Project's header shows it; `lg` draws it on a
 * tile tinted with its color, as Create Project does.
 */
export function ProjectTile({
  entry,
  size = "lg",
}: {
  entry: Pick<ProjectEntry, "icon">;
  size?: "mark" | "lg";
}) {
  const box = size === "mark" ? "size-7 rounded-md" : "size-12 rounded-xl";
  const glyph = size === "mark" ? "size-7" : "size-6";
  if (entry.icon?.image)
    return (
      <img
        alt=""
        src={imageUrl(entry.icon.image)}
        className={`${box} shrink-0 object-cover ring-1 ring-border/60`}
      />
    );
  const { Icon } = iconLook(entry.icon);
  const Glyph = entry.icon ? Icon : MessagesSquare;
  const color = tint(entry);
  if (size === "mark")
    return <Glyph aria-hidden style={{ color }} className={`${glyph} shrink-0`} />;
  return (
    <span
      aria-hidden
      style={{ "--tint": color } as CSSProperties}
      className={`${box} grid shrink-0 place-items-center bg-[color-mix(in_srgb,var(--tint)_16%,transparent)] text-(--tint)`}
    >
      <Glyph className={glyph} />
    </span>
  );
}

/**
 * The Projects page: a search, a filter (All, Pinned, With files, With instructions), a sort kept on
 * this computer, and New project over the Projects as cards in a grid.
 */
export function ProjectsPage({
  entries,
  pins,
  onOpen,
  onTogglePin,
  actionsFor,
  onNewProject,
}: {
  entries: ProjectEntry[];
  /** Pinned keys, in the order pinned. */
  pins: string[];
  onOpen: (entry: ProjectEntry) => void;
  onTogglePin: (key: string) => void;
  /** A Project's menu: Rename, Change icon, Delete, and what else its plxd allows. */
  actionsFor: (entry: ProjectEntry) => FavoriteAction[];
  /** Opens Create Project, or undefined where no host makes Projects. */
  onNewProject?: () => void;
}) {
  const sort = projectSort.use();
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [query, setQuery] = useState("");
  const sortMenu = useId();
  const shown = sortProjects(filterProjects(entries, filter, pins, query), sort);
  const typed = query.trim();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 pt-6 pb-16">
        <header className="flex items-center gap-3">
          <h1 className="mr-auto text-heading font-semibold">Projects</h1>
          {onNewProject && (
            <Button variant="primary" onClick={onNewProject}>
              <icons.add aria-hidden />
              New project
            </Button>
          )}
        </header>

        {entries.length === 0 ? (
          <EmptyState
            className="mt-16"
            icon={<icons.projects aria-hidden />}
            title="No projects yet"
            body="A Project keeps threads together with the instructions and files they share."
          />
        ) : (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <label className="flex h-8 min-w-48 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-hover/50 px-2.5 transition-colors hover:bg-hover focus-within:border-transparent focus-within:bg-hover focus-within:outline-2 focus-within:outline-ring">
                <icons.search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
                <input
                  type="search"
                  aria-label="Search projects"
                  placeholder="Search projects"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint-foreground focus-visible:outline-none"
                />
              </label>
              <Segmented label="Show" options={filters} value={filter} onChange={setFilter} />
              <button
                type="button"
                popoverTarget={sortMenu}
                aria-haspopup="menu"
                title="Sort by"
                className={buttonClass("outline")}
              >
                <icons.sort aria-hidden />
                {sorts.find((s) => s.value === sort)?.label}
                <icons.expand aria-hidden className="text-faint-foreground" />
              </button>
              <Menu
                id={sortMenu}
                label="Sort by"
                align="end"
                focus='[role="menuitemradio"]'
                className="w-44 p-1"
              >
                {sorts.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={s.value === sort}
                    popoverTarget={sortMenu}
                    popoverTargetAction="hide"
                    onClick={() => projectSort.set(s.value)}
                    className={menuItem}
                  >
                    <span className="flex-1">{s.label}</span>
                    {s.value === sort && <Check aria-hidden className="text-accent" />}
                  </button>
                ))}
              </Menu>
            </div>

            {shown.length === 0 ? (
              <EmptyState
                className="mt-12"
                icon={<icons.search aria-hidden />}
                title="No matching projects"
                body={typed ? `Nothing matches “${typed}”.` : filteredOut[filter]}
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Show all projects
                  </Button>
                }
              />
            ) : (
              <ul
                aria-label="Projects"
                className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2"
              >
                {shown.map((e) => (
                  <ProjectCard
                    key={e.key}
                    entry={e}
                    pinned={pins.includes(e.key)}
                    framed
                    onOpen={() => onOpen(e)}
                    onTogglePin={() => onTogglePin(e.key)}
                    actionsFor={() => actionsFor(e)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A Project's card (0093), the row card a thread's is: its icon and "Project", then its name. It
 * opens the Project's page. A pinned one keeps its pin in its top-right, which unpins it; hovering
 * shows Pin, for one that isn't, and its menu, which a right-click opens too. Traditional's Pinned
 * draws it `dense`, with nothing more, the size of a pinned thread's card; the Projects page draws
 * it `framed`, with its age at its first line's end and its threads, files, and instructions under
 * its name.
 */
export function ProjectCard({
  entry,
  pinned,
  selected = false,
  dense = false,
  framed = false,
  onOpen,
  onTogglePin,
  actionsFor,
}: {
  entry: ProjectEntry;
  pinned: boolean;
  /** Its page is open. */
  selected?: boolean;
  dense?: boolean;
  framed?: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  actionsFor: () => FavoriteAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const repo = entry.view.state.repos.find((r) => r.id === entry.id);
  return (
    <RowCard
      rowKey={entry.key}
      kind="project"
      dense={dense}
      framed={framed}
      place={<RowPlace repo={repo} label="Project" />}
      status={framed && age(entry.activeAt)}
      title={entry.name}
      selected={selected}
      main={{ onClick: onOpen, onContextMenu: (e) => openOnContextMenu(e, trigger.current) }}
      details={
        framed && (
          <span className="flex w-full items-center gap-3 text-meta text-faint-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
            <span className="flex items-center gap-1">
              <icons.thread aria-hidden />
              {plural(entry.threads, "thread")}
            </span>
            {entry.files > 0 && (
              <span className="flex items-center gap-1">
                <icons.files aria-hidden />
                {plural(entry.files, "file")}
              </span>
            )}
            {entry.instructions && (
              <span className="flex items-center gap-1">
                <icons.instructions aria-hidden />
                Instructions
              </span>
            )}
          </span>
        )
      }
      actions={
        <>
          {!pinned && (
            <button
              type="button"
              aria-label={`Pin ${entry.name}`}
              title="Pin"
              onClick={onTogglePin}
              className={rowTool}
            >
              <Pin aria-hidden className="size-3.5" />
            </button>
          )}
          <ProjectMenu
            entry={entry}
            pinned={pinned}
            onTogglePin={onTogglePin}
            actionsFor={actionsFor}
            trigger={trigger}
            className={rowTool}
          />
        </>
      }
      trailing={
        pinned && (
          <button
            type="button"
            aria-label={`Unpin ${entry.name}`}
            title="Unpin"
            onClick={onTogglePin}
            className={rowTool}
          >
            <Pin aria-hidden className="size-3.5" />
          </button>
        )
      }
    />
  );
}

/**
 * A Project's actions button and its menu: Pin or Unpin, then `actionsFor`'s, read as it opens.
 * `trigger` lets a right-click elsewhere open it (openOnContextMenu).
 */
export function ProjectMenu({
  entry,
  pinned,
  onTogglePin,
  actionsFor,
  trigger,
  className,
}: {
  entry: ProjectEntry;
  pinned: boolean;
  onTogglePin: () => void;
  actionsFor: () => FavoriteAction[];
  trigger: RefObject<HTMLButtonElement | null>;
  className: string;
}) {
  const menu = useId();
  const [actions, setActions] = useState<FavoriteAction[]>([]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`${entry.name} actions`}
        popoverTarget={menu}
        aria-haspopup="menu"
        // Read as it opens, since what plxd allows can change while the page is open.
        onClick={() => setActions(actionsFor())}
        className={className}
      >
        <Ellipsis className="size-4" />
      </button>
      <Menu id={menu} label={`${entry.name} actions`} align="end" className="w-52 p-1">
        <button
          type="button"
          role="menuitem"
          popoverTarget={menu}
          popoverTargetAction="hide"
          onClick={onTogglePin}
          className={menuItem}
        >
          {pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
          {pinned ? "Unpin" : "Pin"}
        </button>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            popoverTarget={menu}
            popoverTargetAction="hide"
            onClick={() => trigger.current && a.run(trigger.current)}
            className={`${menuItem} ${a.danger ? "text-danger" : ""}`}
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </Menu>
    </>
  );
}

/**
 * Create Project: a name and an icon, then `project/create` on the open host. Resolves through
 * `onCreated` with the new Project.
 */
export function NewChatProject({
  ref,
  create,
  maxImageBytes,
  onCreated,
}: {
  ref: Ref<HTMLDialogElement>;
  create: (name: string, icon?: ChosenIcon) => Promise<Repo | string>;
  maxImageBytes?: number;
  onCreated: (project: Repo) => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ChosenIcon>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const picker = useId();
  const titleId = useId();
  const reset = () => {
    setName("");
    setIcon(undefined);
    setError(undefined);
  };
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={reset}
      className="m-auto w-[28rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const dialog = e.currentTarget.closest("dialog")!;
          setCreating(true);
          setError(undefined);
          const project = await create(name.trim(), icon);
          setCreating(false);
          if (typeof project === "string") return setError(project);
          dialog.close();
          onCreated(project);
        }}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 id={titleId} className="text-reading font-semibold">
            Create Project
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={(e) => e.currentTarget.closest("dialog")?.close()}
            className="-mr-1.5 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="px-5 pt-1 text-body text-muted-foreground">
          Its threads share the instructions and files you give it.
        </p>
        <div className="flex flex-col items-center gap-3 px-5 pt-6 pb-5">
          <button
            type="button"
            popoverTarget={picker}
            aria-haspopup="dialog"
            aria-label="Choose icon"
            title="Choose icon"
            className="rounded-xl hover:opacity-80"
          >
            <ProjectTile entry={{ ...(icon && { icon }) }} size="lg" />
          </button>
          <input
            aria-label="Name"
            placeholder="Name your project"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            maxLength={128}
            className="w-full bg-transparent text-center text-heading font-semibold placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          {error && (
            <p role="alert" className="min-w-0 text-meta text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!name.trim() || creating}
            className="ml-auto rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
      <IconPicker
        id={picker}
        value={icon}
        onPick={setIcon}
        align="center"
        maxImageBytes={maxImageBytes}
      />
    </dialog>
  );
}
