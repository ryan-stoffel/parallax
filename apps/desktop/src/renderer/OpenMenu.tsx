import { Code, FolderOpen, SquareTerminal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { OpenApp, OpenTarget, TerminalApp } from "../preload/bridge";
import cursorIcon from "./assets/cursor.svg";
import vscodeIcon from "./assets/vscode.svg";
import ghosttyIcon from "./assets/ghostty.svg";
import alacrittyIcon from "./assets/alacritty.svg";
import { useShortcutLabel } from "./keybindings";
import { appShortcut } from "./ui";

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

/**
 * One app of Open in: its icon, gray until hovered or focused, opening the folder in it. `current`
 * marks the one the Open shortcut uses.
 */
function AppButton({
  name,
  icon,
  current,
  shortcut,
  disabled,
  onClick,
}: {
  name: string;
  icon: ReactNode;
  current?: boolean;
  shortcut?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`Open in ${name}`}
      title={
        disabled
          ? "No folder to open yet"
          : `Open in ${name}${current && shortcut ? ` (${shortcut})` : ""}`
      }
      className="group/app relative grid size-8 shrink-0 place-items-center rounded-md hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none disabled:opacity-40"
    >
      <span className="opacity-55 grayscale transition-[filter,opacity] duration-150 group-hover/app:opacity-100 group-hover/app:grayscale-0 group-focus-visible/app:opacity-100 group-focus-visible/app:grayscale-0 [&_img]:size-5! [&_svg]:size-4.5!">
        {icon}
      </span>
      {current && (
        <span
          aria-hidden
          className="absolute bottom-0.5 size-1 rounded-full bg-faint-foreground group-hover/app:bg-muted-foreground"
        />
      )}
    </button>
  );
}

/**
 * Thread details' Open in: every editor and IDE main found, the file manager, and, for this
 * computer's folders, every installed terminal, each as its app's icon that opens `folder` on the
 * host. The editor or file manager last used is what the Open shortcut (keybindings.ts) uses, and
 * it's kept. Disabled while there's no folder, and absent while nothing can open one.
 */
export function OpenMenu({ hostId, folder }: { hostId: string; folder?: string }) {
  const [apps, setApps] = useState<OpenApp[]>([]);
  const [terminals, setTerminals] = useState<TerminalApp[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_TARGET_KEY));
  // Bumped when Settings chooses a terminal app, which changes the targets.
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
    if (local) void window.parallax.terminalApps().then((found) => live && setTerminals(found));
    else setTerminals([]);
    return () => {
      live = false;
    };
  }, [hostId, local, terminalChosen]);
  // The chosen terminal opens from the terminals, so it isn't listed twice.
  const editors = apps.filter((app) => app.target !== "terminal");
  const current = editors.find((app) => app.target === chosen) ?? editors[0];
  const keys = useShortcutLabel("open");

  const open = (target: OpenTarget, terminal?: string) => {
    if (folder) void window.parallax.openFolder(hostId, target, folder, terminal);
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
    localStorage.setItem(OPEN_TARGET_KEY, target);
    setChosen(target);
    open(target);
  };
  if (!editors.length && !terminals.length) return null;
  return (
    <div className="px-2 pt-1 pb-1">
      <h3 className="pb-1 text-meta text-muted-foreground">Open in</h3>
      <div role="group" aria-label="Open in" className="-mx-1 flex flex-wrap items-center gap-0.5">
        {editors.map((app) => (
          <AppButton
            key={app.target}
            name={app.name}
            icon={appIcon(app)}
            current={app === current}
            shortcut={keys}
            disabled={!folder}
            onClick={() => choose(app.target)}
          />
        ))}
        {editors.length > 0 && terminals.length > 0 && (
          <span aria-hidden className="mx-1 h-5 w-px bg-border" />
        )}
        {terminals.map((app) => (
          <AppButton
            key={app.path}
            name={app.name}
            icon={terminalIcon(app)}
            disabled={!folder}
            onClick={() => open("terminal", app.path)}
          />
        ))}
      </div>
    </div>
  );
}
