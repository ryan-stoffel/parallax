// The Projects page (0090): every host's Projects and Spaces as cards, pinned ones
// first, with a search, a sort, and New project for either kind.
import {
  Check,
  ChevronDown,
  Ellipsis,
  Layers,
  MessagesSquare,
  Pin,
  PinOff,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import type { ProjectIcon as ProjectIconValue, Repo } from "../protocol/generated/protocol";
import type { FavoriteAction } from "./Favorites";
import { IconPicker } from "./IconPicker";
import { imageUrl } from "./images";
import { iconLook } from "./projectIcons";
import { sortProjects, type ProjectEntry, type ProjectSort } from "./projectList";
import { stored } from "./stored";
import { AttentionBadge } from "./AttentionMark";
import { age } from "./Sidebar";
import { Menu, menuItem, openOnContextMenu, Segmented } from "./ui";

const sorts: { value: ProjectSort; label: string }[] = [
  { value: "activity", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
];

const projectSort = stored<ProjectSort>("parallax.projectSort", "activity", (raw, fallback) =>
  sorts.some((s) => s.value === raw) ? (raw as ProjectSort) : fallback,
);

/** A project's color, as a CSS value: its icon's, else the accent, or gray for a Space. */
function tint(entry: Pick<ProjectEntry, "icon" | "kind">) {
  if (entry.icon?.color) return `var(--project-${entry.icon.color})`;
  return entry.kind === "space" && !entry.icon ? "var(--project-gray)" : "var(--accent)";
}

/**
 * A project's icon on a tile tinted with its color: its uploaded image, its glyph, or Layers for a
 * Project and a chat bubble for a chat project when it has none.
 */
export function ProjectTile({
  entry,
  size = "md",
}: {
  entry: Pick<ProjectEntry, "icon" | "kind">;
  /**
   * `glyph` draws only its glyph, the size of an icon beside text, with its color as `--tint`
   * for the row to show when it chooses.
   */
  size?: "glyph" | "sm" | "md" | "lg";
}) {
  const box = {
    glyph: "size-4 rounded-sm",
    sm: "size-5 rounded-sm",
    md: "size-10 rounded-lg",
    lg: "size-12 rounded-xl",
  }[size];
  const glyph = { glyph: "size-4", sm: "size-3.5", md: "size-5", lg: "size-6" }[size];
  if (entry.icon?.image)
    return (
      <img alt="" src={imageUrl(entry.icon.image)} className={`${box} shrink-0 object-cover`} />
    );
  const { Icon } = iconLook(entry.icon);
  const Glyph = entry.icon ? Icon : entry.kind === "space" ? MessagesSquare : Layers;
  const color = tint(entry);
  if (size === "glyph")
    return (
      <Glyph
        aria-hidden
        style={{ "--tint": color } as CSSProperties}
        className={`${glyph} shrink-0`}
      />
    );
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

/** What a card's last line says: its size, and a Project's branch or a Space's files. */
function details(entry: ProjectEntry) {
  const n = entry.threads;
  const parts = [`${n} ${n === 1 ? "thread" : "threads"}`];
  if (entry.kind === "project" && entry.branch) parts.push(entry.branch);
  if (entry.kind === "space" && entry.files > 0)
    parts.push(`${entry.files} ${entry.files === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

/** A card's hover light: its color from the top left corner, fading out across it. */
const glow =
  "radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--tint) 14%, transparent), transparent 70%)";

type KindFilter = "all" | ProjectEntry["kind"];
const kinds: { value: KindFilter; name: string }[] = [
  { value: "all", name: "All" },
  { value: "project", name: "Projects" },
  { value: "space", name: "Spaces" },
];

export function ProjectsPage({
  entries,
  pins,
  onOpen,
  onTogglePin,
  actionsFor,
  onNewProject,
  onNewChatProject,
}: {
  entries: ProjectEntry[];
  /** Pinned keys, in the order pinned. */
  pins: string[];
  onOpen: (entry: ProjectEntry) => void;
  onTogglePin: (key: string) => void;
  /** A project's menu: Rename, Change icon, Delete, and what else its plxd allows. */
  actionsFor: (entry: ProjectEntry) => FavoriteAction[];
  /** Opens Create Project, a coordinator on a repository. */
  onNewProject: () => void;
  /** Opens Create Space, or undefined where no host makes Spaces. */
  onNewChatProject?: () => void;
}) {
  const sort = projectSort.use();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const sortMenu = useId();
  const newMenu = useId();
  const words = query.trim().toLowerCase();
  const shown = sortProjects(
    entries.filter(
      (e) =>
        (kind === "all" || e.kind === kind) && (!words || e.name.toLowerCase().includes(words)),
    ),
    sort,
  );
  const pinned = pins.flatMap((key) => shown.filter((e) => e.key === key));
  const others = shown.filter((e) => !pins.includes(e.key));
  const waiting = entries.filter((e) => e.needsYou).length;
  const bothKinds =
    entries.some((e) => e.kind === "space") && entries.some((e) => e.kind === "project");
  const card = (e: ProjectEntry) => (
    <ProjectCard
      key={e.key}
      entry={e}
      pinned={pins.includes(e.key)}
      onOpen={() => onOpen(e)}
      onTogglePin={() => onTogglePin(e.key)}
      actionsFor={() => actionsFor(e)}
    />
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 pt-12 pb-16">
        <header className="flex items-center gap-4">
          <div className="mr-auto">
            <h1 className="text-display font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-body text-muted-foreground">
              {entries.length} {entries.length === 1 ? "project" : "projects"}
              {waiting > 0 && (
                <span className="text-warning">
                  {" "}
                  · {waiting} {waiting === 1 ? "needs" : "need"} you
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            popoverTarget={newMenu}
            aria-haspopup="menu"
            className="flex h-8 items-center gap-1.5 rounded-lg bg-primary pr-2.5 pl-3 text-body font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus aria-hidden className="size-4" />
            New project
            <ChevronDown aria-hidden className="size-3.5 opacity-60" />
          </button>
          <Menu id={newMenu} label="New project" align="end" className="w-72 p-1">
            <NewChoice
              menu={newMenu}
              kind="project"
              title="Project"
              detail="A coordinator plans and runs work in a repository."
              onClick={onNewProject}
            />
            {onNewChatProject && (
              <NewChoice
                menu={newMenu}
                kind="space"
                title="Space"
                detail="Threads that share your instructions and files, with no repository."
                onClick={onNewChatProject}
              />
            )}
          </Menu>
        </header>

        {entries.length > 0 && (
          <div className="mt-8 flex items-center gap-2">
            <label className="flex h-8 w-64 items-center gap-2 rounded-lg bg-hover px-2.5 focus-within:outline-2 focus-within:outline-ring">
              <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
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
            {bothKinds && (
              <Segmented label="Kind" options={kinds} value={kind} onChange={setKind} />
            )}
            <button
              type="button"
              popoverTarget={sortMenu}
              aria-haspopup="menu"
              className="ml-auto flex h-8 items-center gap-1 rounded-lg px-2 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              {sorts.find((s) => s.value === sort)?.label}
              <ChevronDown aria-hidden className="size-3.5" />
            </button>
            <Menu
              id={sortMenu}
              label="Sort by"
              align="end"
              focus='[role="menuitemradio"]'
              className="w-40 p-1"
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
        )}

        {entries.length === 0 ? (
          <div className="mt-24 flex flex-col items-center text-center">
            <div className="flex -space-x-2">
              <ProjectTile entry={{ kind: "project" }} size="lg" />
              <ProjectTile entry={{ kind: "space" }} size="lg" />
            </div>
            <h2 className="mt-5 text-reading font-semibold">No projects yet</h2>
            <p className="mt-1 max-w-sm text-body text-muted-foreground">
              A Project runs work in a repository with a coordinator. A Space keeps threads together
              with the instructions and files they share.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <p className="mt-16 text-center text-body text-muted-foreground">
            {words ? `No projects match “${query.trim()}”.` : "None of this kind yet."}
          </p>
        ) : (
          <>
            {pinned.length > 0 && <Section title="Pinned">{pinned.map(card)}</Section>}
            {others.length > 0 && (
              <Section title={pinned.length > 0 ? "Other projects" : undefined}>
                {others.map(card)}
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NewChoice({
  menu,
  kind,
  title,
  detail,
  onClick,
}: {
  menu: string;
  kind: ProjectEntry["kind"];
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      popoverTarget={menu}
      popoverTargetAction="hide"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-md p-2 text-left hover:bg-hover"
    >
      <ProjectTile entry={{ kind }} size="md" />
      <span className="min-w-0 pt-0.5">
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-meta text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section aria-label={title ?? "Projects"} className="mt-6">
      {title && (
        <h2 className="mb-2.5 px-1 text-meta font-medium text-faint-foreground">{title}</h2>
      )}
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
    </section>
  );
}

/**
 * A project's card, laid out as the sidebar's thread cards are: its tile and its status or age,
 * its name, then its size and branch or files. Hovering lights it in its own color and shows Pin
 * and its menu.
 */
function ProjectCard({
  entry,
  pinned,
  onOpen,
  onTogglePin,
  actionsFor,
}: {
  entry: ProjectEntry;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  actionsFor: () => FavoriteAction[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const status = entry.attention === "settled" ? undefined : entry.attention;
  return (
    <li
      data-project={entry.key}
      onContextMenu={(e) => openOnContextMenu(e, trigger.current)}
      style={{ "--tint": tint(entry) } as CSSProperties}
      className="group/card relative"
    >
      <button
        type="button"
        onClick={onOpen}
        className="relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-xl bg-surface p-4 text-left ring-1 ring-border/60 transition-[box-shadow,background-color] duration-200 hover:ring-[color-mix(in_srgb,var(--tint)_45%,transparent)]"
      >
        {/* Its color, glowing from the tile's corner while hovered. */}
        <span
          aria-hidden
          style={{ background: glow }}
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/card:opacity-100"
        />
        <span className="relative flex items-center justify-between gap-2">
          <ProjectTile entry={entry} size="md" />
          <span className="text-meta text-faint-foreground transition-opacity group-focus-within/card:opacity-0 group-hover/card:opacity-0">
            {status ? (
              <AttentionBadge attention={status} count={entry.working} />
            ) : (
              age(entry.activeAt)
            )}
          </span>
        </span>
        <span className="relative min-w-0">
          <span data-title className="block truncate text-reading font-medium">
            {entry.name}
          </span>
          <span className="mt-0.5 block truncate text-meta text-muted-foreground">
            {entry.kind === "space" ? "Space" : "Project"} · {details(entry)}
          </span>
        </span>
      </button>
      <div className="absolute top-4 right-3 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100">
        <button
          type="button"
          aria-label={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
          title={pinned ? "Unpin" : "Pin"}
          onClick={onTogglePin}
          className={cardTool}
        >
          {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        </button>
        <ProjectMenu
          entry={entry}
          pinned={pinned}
          onTogglePin={onTogglePin}
          actionsFor={actionsFor}
          trigger={trigger}
          className={cardTool}
        />
      </div>
    </li>
  );
}

const cardTool =
  "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground";

/**
 * A project's actions button and its menu: Pin or Unpin, then `actionsFor`'s, read as it opens.
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
 * Create Space: a name and an icon, then `space/create` on the open host. Resolves through
 * `onCreated` with the new Space.
 */
export function NewChatProject({
  ref,
  create,
  maxImageBytes,
  onCreated,
}: {
  ref: Ref<HTMLDialogElement>;
  create: (name: string, icon?: ProjectIconValue) => Promise<Repo | string>;
  maxImageBytes?: number;
  onCreated: (space: Repo) => void;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<ProjectIconValue>();
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
          const space = await create(name.trim(), icon);
          setCreating(false);
          if (typeof space === "string") return setError(space);
          dialog.close();
          onCreated(space);
        }}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 id={titleId} className="text-reading font-semibold">
            Create Space
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
            <ProjectTile entry={{ kind: "space", ...(icon && { icon }) }} size="lg" />
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
