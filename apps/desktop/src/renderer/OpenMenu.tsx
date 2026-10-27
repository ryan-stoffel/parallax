import { Check, ChevronDown, Code, FolderOpen, SquareTerminal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { OpenApp, OpenTarget, TerminalApp } from "../preload/bridge";
import cursorIcon from "./assets/cursor.svg";
import vscodeIcon from "./assets/vscode.svg";
import ghosttyIcon from "./assets/ghostty.svg";
import alacrittyIcon from "./assets/alacritty.svg";
import { useShortcutLabel } from "./keybindings";
import { appShortcut, Menu, menuItem, splitChevron } from "./ui";

/** Where the last target chosen is kept; Settings > General sets it too. */
export const OPEN_TARGET_KEY = "parallax.openTarget";
/** The window event Settings fires after choosing a terminal app, so Open lists it. */
export const TERMINAL_CHOSEN = "parallax:terminalChosen";

// Supplied artwork for apps main has no icon for, such as on Linux.
const artwork: Partial<Record<OpenTarget, string>> = { cursor: cursorIcon, vscode: vscodeIcon };
const terminalArtwork: Record<string, string> = { Ghostty: ghosttyIcon, Alacritty: alacrittyIcon };

const image = (src: string) => <img src={src} alt="" className="size-4 shrink-0" />;

/** An Open target's app icon: main's, else supplied artwork, else a mark for its kind. */
export const appIcon = (app: OpenApp): ReactNode => {
  const src = app.icon ?? artwork[app.target];
  if (src) return image(src);
  return app.target === "files" ? (
    <FolderOpen />
  ) : app.target === "terminal" ? (
    <SquareTerminal />
  ) : (
    <Code />
  );
};

/** A terminal app's icon: main's, else Ghostty's or Alacritty's artwork, else the terminal mark. */
export const terminalIcon = (app?: TerminalApp): ReactNode => {
  const src = app && (app.icon ?? terminalArtwork[app.name]);
  return src ? image(src) : <SquareTerminal />;
};

/** An app icon, gray until its row is hovered or focused. Rows set `group/app`. */
const muted = (icon: ReactNode) => (
  <span className="flex shrink-0 opacity-55 grayscale transition-[filter,opacity] duration-150 group-hover/app:opacity-100 group-hover/app:grayscale-0 group-focus-visible/app:opacity-100 group-focus-visible/app:grayscale-0">
    {icon}
  </span>
);

/**
 * Thread details' Open in rows. The first opens `folder` on the host in the editor or file
 * manager last chosen, also on its shortcut (keybindings.ts); its chevron lists every editor and
 * IDE main found and the file manager, and choosing one opens with it and keeps it. The second,
 * for this computer's folders, opens it in the terminal chosen in Settings; its chevron lists
 * every installed terminal, and choosing one makes it the terminal and opens with it. Each app
 * shows its own icon, gray until hovered. Disabled while there's no folder, and absent while
 * nothing can open one.
 */
export function OpenMenu({ hostId, folder }: { hostId: string; folder?: string }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const terminalId = useId();
  const terminalMenu = useRef<HTMLDivElement>(null);
  const [apps, setApps] = useState<OpenApp[]>([]);
  const [terminals, setTerminals] = useState<TerminalApp[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  // Bumped when a terminal app is chosen, here or in Settings, which changes the targets.
  const [terminalChosen, setTerminalChosen] = useState(0);
  useEffect(() => {
    const onChosen = () => setTerminalChosen((n) => n + 1);
    window.addEventListener(TERMINAL_CHOSEN, onChosen);
    return () => window.removeEventListener(TERMINAL_CHOSEN, onChosen);
  }, []);
  const local = hostId === "local";
  useEffect(() => {
    let live = true;
    void window.parallax.openTargets(hostId).then((found) => live && setApps(found));
    void window.parallax.terminalApps().then((found) => live && setTerminals(found));
    return () => {
      live = false;
    };
  }, [hostId, terminalChosen]);
  const editors = apps.filter((app) => app.target !== "terminal");
  const current = editors.find((app) => app.target === chosen) ?? editors[0];
  // The terminal the second row opens: the chosen one, which only this computer's folders list.
  const terminal = apps.find((app) => app.target === "terminal");
  const terminalApp = terminals.find((app) => app.name === terminal?.name);
  const keys = useShortcutLabel("open");

  const open = (target: OpenTarget) => {
    if (folder) void window.parallax.openFolder(hostId, target, folder);
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (appShortcut(e) !== "open" || !current) return;
      e.preventDefault();
      open(current.target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const choose = (target: OpenTarget) => {
    menu.current?.hidePopover();
    localStorage.setItem(OPEN_TARGET_KEY, target);
    setChosen(target);
    open(target);
  };
  const chooseTerminal = async (app: TerminalApp) => {
    terminalMenu.current?.hidePopover();
    if (!(await window.parallax.selectTerminalApp(app.path))) return;
    window.dispatchEvent(new Event(TERMINAL_CHOSEN));
    if (folder) void window.parallax.openFolder(hostId, "terminal", folder, app.path);
  };
  const terminalWhy = !local
    ? "Terminals open folders on this computer only"
    : !folder
      ? "No folder to open yet"
      : !terminal
        ? "No installed terminal found"
        : undefined;
  return (
    <>
      {current && (
        <div className="flex items-center">
          <button
            type="button"
            disabled={!folder}
            onClick={() => open(current.target)}
            aria-label={`Open in ${current.name}`}
            title={
              folder
                ? `Open in ${current.name}${keys ? ` (${keys})` : ""}`
                : "No folder to open yet"
            }
            className={`${menuItem} group/app min-w-0 flex-1 disabled:opacity-50`}
          >
            {muted(appIcon(current))}
            <span className="truncate">Open in {current.name}</span>
          </button>
          <button
            type="button"
            popoverTarget={id}
            aria-haspopup="menu"
            aria-label="Choose editor or file manager"
            className={splitChevron}
          >
            <ChevronDown aria-hidden />
          </button>
        </div>
      )}
      <Menu ref={menu} id={id} label="Open in" align="end" className="min-w-52 p-1" focus="button">
        {editors.map((app) => (
          <button
            key={app.target}
            type="button"
            role="menuitem"
            disabled={!folder}
            onClick={() => choose(app.target)}
            className={`${menuItem} group/app disabled:opacity-50 [&_img]:size-4 [&_svg]:size-4`}
          >
            {muted(appIcon(app))}
            <span className="flex-1">{app.name}</span>
            {app === current && keys && (
              <span className="text-meta text-faint-foreground">{keys}</span>
            )}
          </button>
        ))}
      </Menu>
      <div className="flex items-center">
        <button
          type="button"
          disabled={!!terminalWhy}
          title={terminalWhy}
          onClick={() => open("terminal")}
          className={`${menuItem} group/app min-w-0 flex-1 disabled:opacity-50`}
        >
          {muted(terminalApp ? terminalIcon(terminalApp) : terminalIcon())}
          <span className="truncate">Open in {terminal?.name ?? "terminal"}</span>
        </button>
        <button
          type="button"
          popoverTarget={terminalId}
          aria-haspopup="menu"
          aria-label="Choose terminal"
          disabled={!local || terminals.length === 0}
          title={!local ? terminalWhy : undefined}
          className={splitChevron}
        >
          <ChevronDown aria-hidden />
        </button>
      </div>
      <Menu
        ref={terminalMenu}
        id={terminalId}
        label="Terminals"
        align="end"
        className="min-w-52 p-1"
        focus="button"
      >
        {terminals.map((app) => (
          <button
            key={app.path}
            type="button"
            role="menuitemradio"
            aria-checked={app.name === terminal?.name}
            onClick={() => void chooseTerminal(app)}
            className={`${menuItem} group/app [&_img]:size-4 [&_svg]:size-4`}
          >
            {muted(terminalIcon(app))}
            <span className="flex-1">{app.name}</span>
            {app.name === terminal?.name && <Check aria-hidden className="text-muted-foreground" />}
          </button>
        ))}
      </Menu>
    </>
  );
}
