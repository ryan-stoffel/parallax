import {
  Bug,
  ChevronDown,
  FlaskConical,
  Globe,
  Hammer,
  Package,
  Pencil,
  Play,
  Plus,
  Rocket,
  Server,
  SquareTerminal,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { browserUrl } from "./Browser";
import { editingKeys, formatKeybinding, keybindingOf, modifiers } from "./keybindings";
import { appShortcut, IconButton, menuButton, Menu, menuItem, menuPanel } from "./ui";
import { uuidv7 } from "./uuidv7";

/** A saved command for a repository, run from the top bar in the thread's terminal drawer. */
export interface RepoAction {
  id: string;
  /** A name from `actionIcons`. */
  icon: string;
  name: string;
  command: string;
  /** As `keybindingOf` writes it. */
  keybinding?: string;
  previewUrl?: string;
  /** Whether running it opens `previewUrl` in the side panel's Browser view. */
  openPreview: boolean;
}

/** The glyphs an action can wear, by the name it keeps. */
export const actionIcons: Record<string, LucideIcon> = {
  play: Play,
  test: FlaskConical,
  build: Hammer,
  debug: Bug,
  deploy: Rocket,
  terminal: SquareTerminal,
  web: Globe,
  package: Package,
  server: Server,
  tool: Wrench,
  zap: Zap,
};

const IconOf = (name: string) => actionIcons[name] ?? Play;

// A repository's actions, kept in this app by host and repository id, like its other renderer
// preferences. ponytail: not shared with other computers running the app.
const storageKey = (hostId: string, repoId: string) => `parallax:actions:${hostId}/${repoId}`;

export function readActions(hostId: string, repoId: string): RepoAction[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(hostId, repoId)) ?? "[]") as unknown;
    // Entries without an id, name, and command are dropped, so a bad one can't break the top bar.
    return Array.isArray(stored) ? stored.filter(isAction) : [];
  } catch {
    return [];
  }
}

function isAction(value: unknown): value is RepoAction {
  const a = value as Partial<RepoAction> | null;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.id === "string" &&
    typeof a.name === "string" &&
    typeof a.command === "string"
  );
}

function writeActions(hostId: string, repoId: string, actions: RepoAction[]) {
  try {
    localStorage.setItem(storageKey(hostId, repoId), JSON.stringify(actions));
  } catch {
    // Storage is off: the change lasts until the window closes.
  }
}

/**
 * The top bar's repository actions for repository `repoId` on host `hostId`: Add action while
 * there are none, else the first few as run buttons and a menu with every one, to run or edit,
 * and Add action. An action's keybinding runs it too, unless a dialog is open. `onRun` runs one;
 * without `canRun` (no folder yet) they can't run.
 */
export function Actions({
  hostId,
  repoId,
  canRun,
  onRun,
}: {
  hostId: string;
  repoId: string;
  canRun: boolean;
  onRun: (action: RepoAction) => void;
}) {
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  // Read on each render, so another repository's show at once; a save renders again.
  const [, saved] = useReducer((n: number) => n + 1, 0);
  const actions = readActions(hostId, repoId);
  // The dialog's action, or "new" to add one.
  const [editing, setEditing] = useState<RepoAction | "new">();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The app's own shortcuts win over a keybinding saved before they were taken.
      if (!canRun || appShortcut(e) || document.querySelector("dialog[open]")) return;
      const keybinding = keybindingOf(e);
      const action = keybinding && actions.find((a) => a.keybinding === keybinding);
      if (!action) return;
      e.preventDefault();
      onRun(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const save = (next: RepoAction[]) => {
    writeActions(hostId, repoId, next);
    saved();
  };
  const titleOf = (a: RepoAction) =>
    canRun
      ? `Run ${a.name}${a.keybinding ? ` (${formatKeybinding(a.keybinding)})` : ""}`
      : "No folder to run in yet";
  const edit = (action: RepoAction | "new") => {
    menu.current?.hidePopover();
    setEditing(action);
  };

  return (
    <>
      {actions.length === 0 ? (
        <button
          type="button"
          onClick={() => edit("new")}
          className={`${menuButton} shrink-0 border border-border pr-2.5`}
        >
          <Plus aria-hidden />
          Add action
        </button>
      ) : (
        <div className="flex shrink-0 items-center rounded-lg border border-border">
          {actions.slice(0, 3).map((a) => {
            const Icon = IconOf(a.icon);
            return (
              <button
                key={a.id}
                type="button"
                disabled={!canRun}
                onClick={() => onRun(a)}
                title={titleOf(a)}
                className={`${menuButton} rounded-none border-r border-border pr-2.5 first:rounded-l-lg`}
              >
                <Icon aria-hidden />
                {/* Icons only in a narrow top bar (App's is a container), with the name in the tooltip. */}
                <span className="max-w-32 truncate @max-2xl:sr-only">{a.name}</span>
              </button>
            );
          })}
          <button
            type="button"
            popoverTarget={menuId}
            aria-haspopup="menu"
            aria-label="Actions"
            className={`${menuButton} self-stretch rounded-l-none pr-1 pl-1`}
          >
            <ChevronDown aria-hidden className="opacity-70" />
          </button>
        </div>
      )}
      <Menu ref={menu} id={menuId} label="Actions" align="end" className="w-64 p-1" focus="button">
        {actions.map((a) => {
          const Icon = IconOf(a.icon);
          return (
            <div key={a.id} className="flex items-center gap-0.5">
              <button
                type="button"
                role="menuitem"
                disabled={!canRun}
                title={titleOf(a)}
                onClick={() => {
                  menu.current?.hidePopover();
                  onRun(a);
                }}
                className={`${menuItem} min-w-0 flex-1 disabled:opacity-50 [&_svg]:size-4`}
              >
                <Icon aria-hidden />
                <span className="flex-1 truncate">{a.name}</span>
                {a.keybinding && (
                  <span className="text-[11.5px] text-faint-foreground">
                    {formatKeybinding(a.keybinding)}
                  </span>
                )}
              </button>
              <IconButton role="menuitem" label={`Edit ${a.name}`} onClick={() => edit(a)}>
                <Pencil />
              </IconButton>
            </div>
          );
        })}
        <div role="separator" className="-mx-1 my-1 h-px bg-border" />
        <button
          type="button"
          role="menuitem"
          onClick={() => edit("new")}
          className={`${menuItem} [&_svg]:size-4`}
        >
          <Plus aria-hidden />
          Add action
        </button>
      </Menu>
      {editing && (
        <ActionDialog
          action={editing === "new" ? undefined : editing}
          others={actions.filter((a) => editing === "new" || a.id !== editing.id)}
          onSave={(action) =>
            save(
              editing === "new"
                ? [...actions, action]
                : actions.map((a) => (a.id === action.id ? action : a)),
            )
          }
          onDelete={(id) => save(actions.filter((a) => a.id !== id))}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

const field = "flex flex-col gap-1.5 text-[12.5px] font-medium";
const input =
  "w-full rounded-lg border border-border bg-transparent px-3 py-1.5 text-[13px] font-normal placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring";
const hint = "text-[12px] font-normal text-muted-foreground";

/**
 * The Add action and Edit action dialog, a native modal <dialog> open while it's mounted:
 * icon, name, keybinding, command, an optional preview URL, and whether running it opens the
 * preview. The keybinding field records a press, Backspace clears it, and it refuses the app's
 * own shortcuts and those of `others`, the repository's other actions. Saving or deleting closes
 * it; closing calls `onClose`.
 */
export function ActionDialog({
  action,
  others,
  onSave,
  onDelete,
  onClose,
}: {
  /** The one to edit, or none to add one. */
  action?: RepoAction;
  others: RepoAction[];
  onSave: (action: RepoAction) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const iconsId = useId();
  const [icon, setIcon] = useState(action?.icon ?? "play");
  const [name, setName] = useState(action?.name ?? "");
  const [keybinding, setKeybinding] = useState(action?.keybinding);
  const [refused, setRefused] = useState<string>();
  const [command, setCommand] = useState(action?.command ?? "");
  const [previewUrl, setPreviewUrl] = useState(action?.previewUrl ?? "");
  const [openPreview, setOpenPreview] = useState(action?.openPreview ?? false);
  useEffect(() => dialog.current?.showModal(), []);

  const badUrl = !!previewUrl.trim() && !browserUrl(previewUrl);
  const ready = !!name.trim() && !!command.trim() && !badUrl;
  const Icon = IconOf(icon);

  const record = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Tab moves on and Escape closes, as anywhere in the dialog.
    if (e.key === "Tab" || e.key === "Escape") return;
    e.preventDefault();
    // Not a shortcut of the app's or another action's while it's being pressed here.
    e.stopPropagation();
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey) {
      setKeybinding(undefined);
      return setRefused(undefined);
    }
    if (modifiers.includes(e.key)) return;
    const next = keybindingOf(e);
    if (!next)
      return setRefused(
        `Hold ${window.parallax.platform === "darwin" ? "⌘ or ⌃" : "Ctrl"} with a key.`,
      );
    const shown = formatKeybinding(next);
    const taken = others.find((a) => a.keybinding === next);
    if (appShortcut(e)) return setRefused(`${shown} is one of Parallax's shortcuts.`);
    if (editingKeys.includes(e.code)) return setRefused(`${shown} is an editing shortcut.`);
    if (taken) return setRefused(`${shown} already runs ${taken.name}.`);
    setRefused(undefined);
    setKeybinding(next);
  };

  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[28rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          const url = previewUrl.trim();
          onSave({
            id: action?.id ?? uuidv7(),
            icon,
            name: name.trim(),
            command: command.trim(),
            ...(keybinding && { keybinding }),
            ...(url && { previewUrl: url }),
            openPreview: !!url && openPreview,
          });
          close();
        }}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {action ? "Edit action" : "Add action"}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              A command for this repository, run from the top bar in the thread's terminal.
            </p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X />
          </IconButton>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5">
          <div className={field}>
            <span id={`${titleId}-name`}>Name</span>
            <div className="flex gap-2">
              <button
                type="button"
                popoverTarget={iconsId}
                aria-haspopup="dialog"
                aria-label="Choose icon"
                title="Choose icon"
                className="grid size-8.5 shrink-0 place-items-center rounded-lg border border-border hover:bg-hover [&_svg]:size-4"
              >
                <Icon aria-hidden />
              </button>
              <input
                // The native attribute, so showModal focuses the name rather than Close.
                ref={(el) => el?.setAttribute("autofocus", "")}
                aria-labelledby={`${titleId}-name`}
                placeholder="Test"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className={input}
              />
            </div>
          </div>
          <div className={field}>
            <label htmlFor={`${titleId}-keybinding`}>Keybinding</label>
            <input
              id={`${titleId}-keybinding`}
              readOnly
              placeholder="Press a shortcut"
              value={keybinding ? formatKeybinding(keybinding) : ""}
              onKeyDown={record}
              aria-describedby={`${titleId}-keys`}
              className={`${input} caret-transparent`}
            />
            <span
              id={`${titleId}-keys`}
              role={refused ? "alert" : undefined}
              className={refused ? "text-[12px] font-normal text-danger" : hint}
            >
              {refused ?? "Press a shortcut. Backspace clears it."}
            </span>
          </div>
          <label className={field}>
            Command
            <textarea
              placeholder="pnpm test"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              rows={3}
              spellCheck={false}
              className={`${input} resize-none font-mono text-[12.5px]`}
            />
          </label>
          <div className={field}>
            <label htmlFor={`${titleId}-preview`}>Preview URL (optional)</label>
            <input
              id={`${titleId}-preview`}
              placeholder="localhost:5173"
              value={previewUrl}
              onChange={(e) => setPreviewUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={badUrl}
              aria-describedby={`${titleId}-url`}
              className={input}
            />
            <span
              id={`${titleId}-url`}
              className={badUrl ? "text-[12px] font-normal text-danger" : hint}
            >
              {badUrl ? "Only http and https pages open here." : "A page this action serves."}
            </span>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-[13px] has-disabled:opacity-50">
            Open preview when this action runs
            <input
              type="checkbox"
              checked={openPreview}
              disabled={!previewUrl.trim()}
              onChange={(e) => setOpenPreview(e.target.checked)}
              className="size-4 accent-accent"
            />
          </label>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          {action && (
            <button
              type="button"
              onClick={() => {
                onDelete(action.id);
                close();
              }}
              className="shrink-0 rounded-md px-3 py-1.5 text-[13px] text-danger hover:bg-hover"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="ml-auto shrink-0 rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            Save action
          </button>
        </div>
      </form>
      <div
        id={iconsId}
        popover="auto"
        role="dialog"
        aria-label="Action icon"
        className={`${menuPanel()} p-1.5`}
      >
        {/* Inside, since a display class on the popover would show it while closed. */}
        <div className="grid grid-cols-6 gap-0.5">
          {Object.entries(actionIcons).map(([key, Glyph]) => (
            <button
              key={key}
              type="button"
              aria-label={key}
              aria-pressed={key === icon}
              title={key}
              onClick={(e) => {
                setIcon(key);
                e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
              }}
              className="grid size-8 place-items-center rounded-md hover:bg-hover aria-pressed:bg-selected [&_svg]:size-4"
            >
              <Glyph aria-hidden />
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
