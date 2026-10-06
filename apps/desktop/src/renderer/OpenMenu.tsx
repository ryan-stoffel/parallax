import { ChevronDown, FolderOpen, SquareTerminal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type ToggleEvent } from "react";

import type { OpenTarget } from "../preload/bridge";
import { CursorLogo, VSCodeLogo } from "./logos";
import { useShortcutLabel } from "./keybindings";
import { appShortcut, menuButton, menuItem, menuPanel, moveFocus } from "./ui";

/** Where the last target chosen is kept; Settings > General sets it too. */
export const OPEN_TARGET_KEY = "parallax.openTarget";
/** The window event Settings fires after choosing a terminal app, so Open lists it. */
export const TERMINAL_CHOSEN = "parallax:terminalChosen";

// Each target's mark, shown where main has no app icon for it (anywhere but macOS).
const marks: Record<OpenTarget, ReactNode> = {
  cursor: <CursorLogo />,
  vscode: <VSCodeLogo />,
  files: <FolderOpen />,
  terminal: <SquareTerminal />,
};

/** A target's app icon from main (`openTargetIcons`), else its mark. */
export const targetIcon = (target: OpenTarget, appIcons: Partial<Record<OpenTarget, string>>) => {
  const src = appIcons[target];
  return src ? <img src={src} alt="" className="size-4 shrink-0" /> : marks[target];
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
 * The top bar's Open split button. The main part opens `folder` on the host with the last target
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
  // Bumped when Settings chooses a terminal app, to list it and fetch its name and icon.
  const [terminalChosen, setTerminalChosen] = useState(0);
  useEffect(() => {
    const onChosen = () => setTerminalChosen((n) => n + 1);
    window.addEventListener(TERMINAL_CHOSEN, onChosen);
    return () => window.removeEventListener(TERMINAL_CHOSEN, onChosen);
  }, []);
  useEffect(() => {
    void window.parallax.openTargetIcons().then(setAppIcons);
  }, [terminalChosen]);
  const icon = (target: OpenTarget) => targetIcon(target, appIcons);
  useEffect(() => {
    let live = true;
    void window.parallax.openTargets(hostId).then((found) => {
      if (!live) return;
      setTargets(found);
      if (found.includes("terminal"))
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

  if (!current) return null;
  const choose = (target: OpenTarget) => {
    menu.current?.hidePopover();
    localStorage.setItem(OPEN_TARGET_KEY, target);
    setChosen(target);
    open(target);
  };
  return (
    <>
      <div
        title={folder ? undefined : "No folder to open yet"}
        className="flex shrink-0 items-center rounded-lg border border-border"
      >
        <button
          type="button"
          disabled={!folder}
          onClick={() => open(current)}
          aria-label={`Open in ${nameOf(current, terminal)}`}
          // Unset without a folder, so the wrapper's tooltip says why it's disabled.
          title={
            folder ? `Open in ${nameOf(current, terminal)}${keys ? ` (${keys})` : ""}` : undefined
          }
          className={`${menuButton} rounded-r-none pr-2.5`}
        >
          {icon(current)}
          Open
        </button>
        <button
          type="button"
          disabled={!folder}
          popoverTarget={id}
          aria-haspopup="menu"
          aria-label="Open in…"
          className={`${menuButton} self-stretch rounded-l-none border-l border-border pr-1 pl-1`}
        >
          <ChevronDown aria-hidden className="opacity-70" />
        </button>
      </div>
      <div
        ref={menu}
        id={id}
        popover="auto"
        role="menu"
        aria-label="Open in"
        onToggle={(e: ToggleEvent<HTMLDivElement>) => {
          if (e.newState === "open") e.currentTarget.querySelector<HTMLElement>("button")?.focus();
        }}
        onKeyDown={moveFocus}
        className={`${menuPanel("end")} min-w-44 p-1`}
      >
        {targets.map((t) => (
          <button
            key={t}
            type="button"
            role="menuitem"
            onClick={() => choose(t)}
            className={`${menuItem} [&_svg]:size-4`}
          >
            {icon(t)}
            <span className="flex-1">{nameOf(t, terminal)}</span>
            {t === current && keys && (
              <span className="text-[11.5px] text-faint-foreground">{keys}</span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}
