// The Projects page (0090): every host's orchestrators and Spaces as cards, pinned ones
// first, with a search, a sort, and New orchestrator or Space.
import {
  ArrowDownUp,
  Check,
  Ellipsis,
  GitBranch,
  Layers,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  ScrollText,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import type { ChosenIcon, Repo } from "../protocol/generated/protocol";
import type { FavoriteAction } from "./Favorites";
import { IconPicker } from "./IconPicker";
import { imageUrl } from "./images";
import { iconLook } from "./projectIcons";
import { sortProjects, type ProjectEntry, type ProjectSort } from "./projectList";
import { stored } from "./stored";
import { AttentionBadge } from "./AttentionMark";
import { toolButton } from "./PullRequestsPage";
import { age } from "./Sidebar";
import { IconButton, Menu, menuItem, openOnContextMenu, Segmented } from "./ui";

const sorts: { value: ProjectSort; label: string }[] = [
  { value: "activity", label: "Recent" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
];

const projectSort = stored<ProjectSort>("parallax.projectSort", "activity", (raw, fallback) =>
  sorts.some((s) => s.value === raw) ? (raw as ProjectSort) : fallback,
);

/**
 * A project's color, as a CSS value: an uploaded image's own (`imageTint`), its icon's, else the
 * accent, or gray for a Space.
 */
function tint(entry: Pick<ProjectEntry, "icon" | "kind">, imageTint?: string) {
  if (entry.icon?.image) return imageTint ?? "var(--faint-foreground)";
  if (entry.icon?.color) return `var(--project-${entry.icon.color})`;
  return entry.kind === "space" && !entry.icon ? "var(--project-gray)" : "var(--accent)";
}

/**
 * A project's icon on a tile tinted with its color: its uploaded image, its glyph, or Layers for an
 * orchestrator and a chat bubble for a Space when it has none.
 */
export function ProjectTile({
  entry,
  size = "md",
}: {
  entry: Pick<ProjectEntry, "icon" | "kind">;
  /**
   * `glyph` draws only its glyph, the size of an icon beside text, with its color as `--tint`
   * for the row to show when it chooses. `mark` draws only its glyph, large and in its color, as a
   * Space's header shows it.
   */
  size?: "glyph" | "mark" | "sm" | "md" | "lg";
}) {
  const box = {
    glyph: "size-4 rounded-sm",
    mark: "size-7 rounded-md",
    sm: "size-5 rounded-sm",
    md: "size-10 rounded-lg",
    lg: "size-12 rounded-xl",
  }[size];
  const glyph = { glyph: "size-4", mark: "size-7", sm: "size-3.5", md: "size-5", lg: "size-6" }[
    size
  ];
  if (entry.icon?.image)
    return (
      <img
        alt=""
        src={imageUrl(entry.icon.image)}
        className={`${box} shrink-0 object-cover ring-1 ring-border/60`}
      />
    );
  const { Icon } = iconLook(entry.icon);
  const Glyph = entry.icon ? Icon : entry.kind === "space" ? MessagesSquare : Layers;
  const color = tint(entry);
  if (size === "mark")
    return <Glyph aria-hidden style={{ color }} className={`${glyph} shrink-0`} />;
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

// Each uploaded icon's color, by its data URL, read once.
const imageTints = new Map<string, string>();

/**
 * An uploaded icon's color for its card: the average of a 16px copy, each pixel weighted by how
 * vivid it is, so a logo's color wins over its white or black. Undefined until it's read, or for
 * no image.
 */
function useImageTint(icon?: ChosenIcon): string | undefined {
  const url = icon?.image ? imageUrl(icon.image) : undefined;
  const [read, setRead] = useState<{ url: string; color: string }>();
  useEffect(() => {
    if (!url || imageTints.has(url)) return;
    let live = true;
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, 16, 16);
      const pixels = context.getImageData(0, 0, 16, 16).data;
      let [r, g, b, total] = [0, 0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4) {
        const [pr, pg, pb, pa] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
        const weight = ((Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) / 255 + 0.05) * (pa / 255);
        r += pr * weight;
        g += pg * weight;
        b += pb * weight;
        total += weight;
      }
      if (!total) return;
      const color = `rgb(${Math.round(r / total)} ${Math.round(g / total)} ${Math.round(b / total)})`;
      imageTints.set(url, color);
      if (live) setRead({ url, color });
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return url ? (imageTints.get(url) ?? (read?.url === url ? read.color : undefined)) : undefined;
}

/** A card's color, washing down from the top. */
const wash =
  "linear-gradient(180deg, color-mix(in srgb, var(--tint) 9%, transparent), transparent 70%)";
/** A card's hover light: its color from the top left corner, fading out across it. */
const glow =
  "radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, var(--tint) 16%, transparent), transparent 70%)";

type KindFilter = "all" | ProjectEntry["kind"];
const kinds: { value: KindFilter; name: string }[] = [
  { value: "all", name: "All" },
  { value: "orchestrator", name: "Orchestrators" },
  { value: "space", name: "Spaces" },
];

export function ProjectsPage({
  entries,
  pins,
  onOpen,
  onTogglePin,
  actionsFor,
  onNewOrchestrator,
  onNewChatProject,
}: {
  entries: ProjectEntry[];
  /** Pinned keys, in the order pinned. */
  pins: string[];
  onOpen: (entry: ProjectEntry) => void;
  onTogglePin: (key: string) => void;
  /** A project's menu: Rename, Change icon, Delete, and what else its plxd allows. */
  actionsFor: (entry: ProjectEntry) => FavoriteAction[];
  /** Opens New orchestrator thread, on a repository. */
  onNewOrchestrator: () => void;
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
  const bothKinds =
    entries.some((e) => e.kind === "space") && entries.some((e) => e.kind === "orchestrator");
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
      <div className="mx-auto max-w-5xl px-8 pt-6 pb-16">
        <header className="flex items-center gap-2">
          <h1 className="mr-auto text-heading font-semibold">Projects</h1>
          <button type="button" popoverTarget={newMenu} aria-haspopup="menu" className={toolButton}>
            <Plus aria-hidden />
            New orchestrator or Space
          </button>
          <Menu id={newMenu} label="New orchestrator or Space" align="end" className="w-72 p-1">
            <NewChoice
              menu={newMenu}
              kind="orchestrator"
              title="Orchestrator thread"
              detail="Plans work in a repository and hands it to agents."
              onClick={onNewOrchestrator}
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
          <div className="mt-5 flex items-center gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 focus-within:outline-2 focus-within:outline-ring">
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
              className={toolButton}
            >
              <ArrowDownUp aria-hidden />
              {sorts.find((s) => s.value === sort)?.label}
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
              <ProjectTile entry={{ kind: "orchestrator" }} size="lg" />
              <ProjectTile entry={{ kind: "space" }} size="lg" />
            </div>
            <h2 className="mt-5 text-reading font-semibold">No projects yet</h2>
            <p className="mt-1 max-w-sm text-body text-muted-foreground">
              An orchestrator thread runs work in a repository. A Space keeps threads together with
              the instructions and files they share.
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
    <section aria-label={title ?? "Projects"} className="mt-8">
      {title && <h2 className="mb-3 text-reading font-medium">{title}</h2>}
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">{children}</ul>
    </section>
  );
}

/**
 * A project's card: its tile and its status or age, its name, what its latest thread is, then its
 * branch or a Space's files and instructions, and how many threads it has. It's washed in its own
 * color, which lights up from the corner on hover, and Pin and its menu show then.
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
  const imageTint = useImageTint(entry.icon);
  const status = entry.attention === "settled" ? undefined : entry.attention;
  const n = entry.threads;
  return (
    <li
      data-project={entry.key}
      onContextMenu={(e) => openOnContextMenu(e, trigger.current)}
      style={{ "--tint": tint(entry, imageTint) } as CSSProperties}
      className="group/card relative"
    >
      <button
        type="button"
        onClick={onOpen}
        style={{ backgroundImage: wash }}
        className="relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-surface p-4 text-left ring-1 ring-border/60 transition-[box-shadow,translate] duration-200 hover:-translate-y-px hover:shadow-composer hover:ring-[color-mix(in_srgb,var(--tint)_40%,transparent)] motion-reduce:hover:translate-y-0"
      >
        <span
          aria-hidden
          style={{ background: glow }}
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover/card:opacity-100"
        />
        <span className="relative flex items-start justify-between gap-2">
          <ProjectTile entry={entry} size="md" />
          <span className="pt-1 text-meta text-faint-foreground transition-opacity group-focus-within/card:opacity-0 group-hover/card:opacity-0">
            {status ? (
              <AttentionBadge attention={status} count={entry.working} />
            ) : (
              age(entry.activeAt)
            )}
          </span>
        </span>
        <span className="relative mt-4 min-w-0">
          <span data-title className="block truncate text-reading font-semibold tracking-tight">
            {entry.name}
          </span>
          <span className="mt-0.5 block truncate text-body text-muted-foreground">
            {entry.latest ?? (entry.kind === "space" ? "No threads yet" : "No work yet")}
          </span>
        </span>
        <span className="relative mt-4 flex items-center gap-3 border-t border-border/60 pt-3 text-meta text-faint-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
          {entry.kind === "orchestrator" ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch aria-hidden />
              <span className="truncate">{entry.branch ?? "No branch"}</span>
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <Paperclip aria-hidden />
                {entry.files === 0
                  ? "No files"
                  : `${entry.files} ${entry.files === 1 ? "file" : "files"}`}
              </span>
              {entry.instructions && (
                <span className="flex items-center gap-1.5">
                  <ScrollText aria-hidden />
                  Instructions
                </span>
              )}
            </>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <MessageSquare aria-hidden />
            {n} {n === 1 ? "thread" : "threads"}
          </span>
        </span>
      </button>
      <div className="absolute top-3.5 right-3 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100">
        <IconButton
          label={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff /> : <Pin />}
        </IconButton>
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
  create: (name: string, icon?: ChosenIcon) => Promise<Repo | string>;
  maxImageBytes?: number;
  onCreated: (space: Repo) => void;
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
