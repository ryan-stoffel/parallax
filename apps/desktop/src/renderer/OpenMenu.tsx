import { Check, ChevronDown, FolderOpen, SquareTerminal } from "./icons";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { OpenTarget, TerminalApp } from "../preload/bridge";
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

// Supplied editor artwork, with fallback marks for native file managers and terminals.
const marks: Record<OpenTarget, ReactNode> = {
  cursor: <img src={cursorIcon} alt="" className="size-4 shrink-0" />,
  vscode: <img src={vscodeIcon} alt="" className="size-4 shrink-0" />,
  files: <FolderOpen />,
  terminal: <SquareTerminal />,
};

/** Supplied editor artwork, or a native app icon from main with a fallback mark. */
export const targetIcon = (target: OpenTarget, appIcons: Partial<Record<OpenTarget, string>>) => {
  if (target === "cursor" || target === "vscode") return marks[target];
  const src = appIcons[target];
  return src ? <img src={src} alt="" className="size-4 shrink-0" /> : marks[target];
};

/**
 * A terminal app's icon: Ghostty's and Alacritty's own artwork, else `appIcon` (main's icon for the
 * chosen terminal) or the terminal mark.
 */
export const terminalIcon = (name: string | null, appIcon?: string) => {
  const src = name === "Ghostty" ? ghosttyIcon : name === "Alacritty" ? alacrittyIcon : appIcon;
  return src ? <img src={src} alt="" className="size-4 shrink-0" /> : marks.terminal;
};

/** A target's name for people; the terminal's is the chosen app's, `terminal`. */
export const nameOf = (target: OpenTarget, terminal?: string | null) => {
  if (target === "cursor") return "Cursor";
  if (target === "vscode") return "VS Code";
  if (target === "terminal") return terminal ?? "Terminal";
  const platform = window.parallax.platform;
  return platform === "darwin" ? "Finder" : platform === "win32" ? "File Explorer" : "Files";
};

/**
 * Folder launch rows in Thread details. The main part opens `folder` on the host with the last target
 * chosen, also on its shortcut (keybindings.ts); the chevron lists the targets main found, and choosing one opens with it
 * and keeps it. Disabled while there's no folder, and absent while nothing can open one.
 */
export function OpenMenu({ hostId, folder }: { hostId: string; folder?: string }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  const [appIcons, setAppIcons] = useState<Partial<Record<OpenTarget, string>>>({});
  const [terminal, setTerminal] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<TerminalApp[]>([]);
  const terminalId = useId();
  const terminalMenu = useRef<HTMLDivElement>(null);
  // Bumped when Settings chooses a terminal app, to list it and fetch its name and icon.
  const [terminalChosen, setTerminalChosen] = useState(0);
  useEffect(() => {
    const onChosen = () => setTerminalChosen((n) => n + 1);
    window.addEventListener(TERMINAL_CHOSEN, onChosen);
    return () => window.removeEventListener(TERMINAL_CHOSEN, onChosen);
  }, []);
  useEffect(() => {
    void window.parallax.openTargetIcons().then(setAppIcons);
    void window.parallax.terminalApps().then(setTerminals);
  }, [terminalChosen]);
  const iconOf = (name: string | null) =>
    terminalIcon(name, name === terminal ? appIcons.terminal : undefined);
  const icon = (target: OpenTarget) =>
    target === "terminal" ? iconOf(terminal) : targetIcon(target, appIcons);
  useEffect(() => {
    let live = true;
    void window.parallax.openTargets(hostId).then((found) => {
      if (!live) return;
      setTargets(found.filter((target) => target !== "terminal"));
      void window.parallax.terminalApp().then((name) => live && setTerminal(name));
    });
    return () => {
      live = false;
    };
  }, [hostId, terminalChosen]);
  const current = targets.find((t) => t === chosen) ?? targets[0];
  const keys = useShortcutLabel("open");

  const open = (target: OpenTarget) => {
    if (folder) void window.parallax.openFolder(hostId, target, folder);
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (appShortcut(e) !== "open" || !current) return;
      e.preventDefault();
      open(current);
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
    const selected = await window.parallax.selectTerminalApp(app.path);
    if (selected) window.dispatchEvent(new Event(TERMINAL_CHOSEN));
  };
  const local = hostId === "local";
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
            onClick={() => open(current)}
            aria-label={`Open in ${nameOf(current)}`}
            title={
              folder
                ? `Open in ${nameOf(current)}${keys ? ` (${keys})` : ""}`
                : "No folder to open yet"
            }
            className={`${menuItem} min-w-0 flex-1 disabled:opacity-50`}
          >
            {icon(current)}
            <span className="truncate">Open in {nameOf(current)}</span>
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
      <Menu ref={menu} id={id} label="Open in" align="end" className="min-w-44 p-1" focus="button">
        {targets.map((t) => (
          <button
            key={t}
            type="button"
            role="menuitem"
            onClick={() => choose(t)}
            className={`${menuItem} [&_svg]:size-4`}
          >
            {icon(t)}
            <span className="flex-1">{nameOf(t)}</span>
            {t === current && keys && (
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
          className={`${menuItem} min-w-0 flex-1 disabled:opacity-50`}
        >
          {icon("terminal")}
          <span className="truncate">Open in {terminal ?? "terminal"}</span>
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
        className="min-w-44 p-1"
        focus="button"
      >
        {terminals.map((app) => (
          <button
            key={app.path}
            type="button"
            role="menuitemradio"
            aria-checked={app.name === terminal}
            onClick={() => void chooseTerminal(app)}
            className={menuItem}
          >
            {iconOf(app.name)}
            <span className="flex-1">{app.name}</span>
            {app.name === terminal && <Check aria-hidden className="text-muted-foreground" />}
          </button>
        ))}
      </Menu>
    </>
  );
}
