import { ChevronDown, FolderOpen } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type ToggleEvent } from "react";

import type { OpenTarget } from "../preload/bridge";
import { CursorLogo, VSCodeLogo } from "./logos";
import { appShortcut, menuButton, menuItem, menuPanel, moveFocus, shortcut } from "./ui";

const STORAGE_KEY = "parallax.openTarget";

// Each target's mark, shown where main has no app icon for it (anywhere but macOS).
const marks: Record<OpenTarget, ReactNode> = {
  cursor: <CursorLogo />,
  vscode: <VSCodeLogo />,
  files: <FolderOpen />,
};

const nameOf = (target: OpenTarget) => {
  if (target === "cursor") return "Cursor";
  if (target === "vscode") return "VS Code";
  const platform = window.parallax.platform;
  return platform === "darwin" ? "Finder" : platform === "win32" ? "File Explorer" : "Files";
};

/**
 * The top bar's Open split button. The main part opens `folder` on the host with the last target
 * chosen, also on Mod+Alt+O; the chevron lists the targets main found, and choosing one opens with it
 * and keeps it. Disabled while there's no folder, and absent while nothing can open one.
 */
export function OpenMenu({ hostId, folder }: { hostId: string; folder?: string }) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<OpenTarget[]>([]);
  const [chosen, setChosen] = useState(() => localStorage.getItem(STORAGE_KEY));
  const [appIcons, setAppIcons] = useState<Partial<Record<OpenTarget, string>>>({});
  useEffect(() => {
    void window.parallax.openTargetIcons().then(setAppIcons);
  }, []);
  const icon = (target: OpenTarget) => {
    const src = appIcons[target];
    return src ? <img src={src} alt="" className="size-4 shrink-0" /> : marks[target];
  };
  useEffect(() => {
    let live = true;
    void window.parallax.openTargets(hostId).then((found) => live && setTargets(found));
    return () => {
      live = false;
    };
  }, [hostId]);
  const current = targets.find((t) => t === chosen) ?? targets[0];

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
    localStorage.setItem(STORAGE_KEY, target);
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
          aria-label={`Open in ${nameOf(current)}`}
          // Unset without a folder, so the wrapper's tooltip says why it's disabled.
          title={folder ? `Open in ${nameOf(current)} (${shortcut("Alt+O")})` : undefined}
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
            <span className="flex-1">{nameOf(t)}</span>
            {t === current && (
              <span className="text-[11.5px] text-faint-foreground">{shortcut("Alt+O")}</span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}
