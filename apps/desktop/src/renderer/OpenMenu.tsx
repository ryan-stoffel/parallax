import { t } from "i18next";
import { Check, ChevronDown, Code, FolderOpen, SquareTerminal } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { OpenApp, OpenTarget, TerminalApp } from "../preload/bridge";
import cursorIcon from "./assets/cursor.svg";
import vscodeIcon from "./assets/vscode.svg";
import ghosttyIcon from "./assets/ghostty.svg";
import alacrittyIcon from "./assets/alacritty.svg";
import { useShortcutLabel } from "./keybindings";
import { icons } from "./icons";
import {
  appShortcut,
  Button,
  Dialog,
  Menu,
  menuItem,
  splitChevron,
  toolbarMenuDivider,
} from "./ui";

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
 * IDE main found and the file manager, and choosing one opens with it and keeps it. The second
 * opens it in the terminal chosen in Settings; its chevron lists every installed terminal, and
 * choosing one makes it the terminal and opens with it. Each app shows its own icon, gray until
 * hovered. Disabled while there's no folder, and absent while nothing can open one.
 *
 * On another computer, editors open the folder over Remote SSH and terminals run an ssh session
 * in it, wherever main works out the computer is (PLX-1343). A dialog asks when it can't tell, and
 * each chevron's menu opens it to change that.
 */
export function OpenMenu({
  hostId,
  hostName,
  folder,
}: {
  hostId: string;
  hostName: string;
  folder?: string;
}) {
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
  const destinationDialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const [destinationError, setDestinationError] = useState<string>();
  // What to open once the dialog has a destination, when opening is what asked for one.
  const pending = useRef<() => void>(undefined);
  const askDestination = async () => {
    setDraft((folder && (await window.parallax.sshDestination(hostId, folder))) || "");
    setDestinationError(undefined);
    destinationDialog.current?.showModal();
  };
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
  // The terminal the second row opens: the chosen one.
  const terminal = apps.find((app) => app.target === "terminal");
  const terminalApp = terminals.find((app) => app.name === terminal?.name);
  const keys = useShortcutLabel("open");

  // Opens with `target`, or asks where the computer is, then opens.
  const open = async (target: OpenTarget, terminalPath?: string) => {
    if (!folder) return;
    const answer = await window.parallax.openFolder(hostId, target, folder, terminalPath);
    if (answer !== "noDestination") return;
    pending.current = () => void open(target, terminalPath);
    void askDestination();
  };
  const saveDestination = async () => {
    const error = await window.parallax.setSshDestination(hostId, draft);
    if (error) return setDestinationError(error);
    // Taken first, since closing the dialog forgets it.
    const then = pending.current;
    destinationDialog.current?.close();
    then?.();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (appShortcut(e) !== "open" || !current) return;
      e.preventDefault();
      void open(current.target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const choose = (target: OpenTarget) => {
    menu.current?.hidePopover();
    localStorage.setItem(OPEN_TARGET_KEY, target);
    setChosen(target);
    void open(target);
  };
  const chooseTerminal = async (app: TerminalApp) => {
    terminalMenu.current?.hidePopover();
    if (!(await window.parallax.selectTerminalApp(app.path))) return;
    window.dispatchEvent(new Event(TERMINAL_CHOSEN));
    void open("terminal", app.path);
  };
  const terminalWhy = !folder
    ? t("No folder to open yet")
    : !terminal
      ? t("No installed terminal found")
      : undefined;
  // On another computer, how to change where it's reached.
  const destinationItem = !local && (
    <>
      <hr className={toolbarMenuDivider} />
      <button
        type="button"
        role="menuitem"
        disabled={!folder}
        onClick={() => {
          menu.current?.hidePopover();
          terminalMenu.current?.hidePopover();
          void askDestination();
        }}
        className={`${menuItem} disabled:opacity-50`}
      >
        <icons.ssh aria-hidden />
        <span className="flex-1">{t("SSH destination…")}</span>
      </button>
    </>
  );
  return (
    <>
      {current && (
        <div className="flex items-center">
          <button
            type="button"
            disabled={!folder}
            onClick={() => void open(current.target)}
            aria-label={t("Open in {{app}}", { app: current.name })}
            title={
              !folder
                ? t("No folder to open yet")
                : keys
                  ? t("Open in {{app}} ({{keys}})", { app: current.name, keys })
                  : t("Open in {{app}}", { app: current.name })
            }
            className={`${menuItem} group/app min-w-0 flex-1 disabled:opacity-50`}
          >
            {muted(appIcon(current))}
            <span className="truncate">{t("Open in {{app}}", { app: current.name })}</span>
          </button>
          <button
            type="button"
            popoverTarget={id}
            aria-haspopup="menu"
            aria-label={t("Choose editor or file manager")}
            className={splitChevron}
          >
            <ChevronDown aria-hidden />
          </button>
        </div>
      )}
      <Menu
        ref={menu}
        id={id}
        label={t("Open in")}
        align="end"
        className="min-w-52 p-1"
        focus="button"
      >
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
        {destinationItem}
      </Menu>
      <div className="flex items-center">
        <button
          type="button"
          disabled={!!terminalWhy}
          title={terminalWhy}
          onClick={() => void open("terminal")}
          className={`${menuItem} group/app min-w-0 flex-1 disabled:opacity-50`}
        >
          {muted(terminalApp ? terminalIcon(terminalApp) : terminalIcon())}
          <span className="truncate">
            {t("Open in {{app}}", { app: terminal?.name ?? t("terminal") })}
          </span>
        </button>
        <button
          type="button"
          popoverTarget={terminalId}
          aria-haspopup="menu"
          aria-label={t("Choose terminal")}
          disabled={terminals.length === 0}
          className={splitChevron}
        >
          <ChevronDown aria-hidden />
        </button>
      </div>
      <Menu
        ref={terminalMenu}
        id={terminalId}
        label={t("Terminals")}
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
        {destinationItem}
      </Menu>
      {/* In the body, since the Open shortcut can ask while the panel or this row is hidden, where
          a modal would block the window unseen. */}
      {createPortal(
        <Dialog
          ref={destinationDialog}
          aria-label={t("SSH destination")}
          onClose={() => {
            pending.current = undefined;
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveDestination();
            }}
          >
            <div className="px-5 pt-4 pb-3">
              <h2 className="text-reading font-semibold">
                {t("SSH destination for {{computer}}", { computer: hostName })}
              </h2>
              <p className="mt-0.5 text-body text-muted-foreground">
                {t(
                  "Where editors and terminals reach it, using your ssh config and keys. The computer needs SSH turned on, called Remote Login on a Mac. Leave it empty to use the address Parallax finds.",
                )}
              </p>
            </div>
            <div className="px-5 pb-4">
              <input
                aria-label={t("SSH destination")}
                // The native attribute, so showModal focuses the field.
                ref={(el) => el?.setAttribute("autofocus", "")}
                placeholder="me@mac-mini"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDestinationError(undefined);
                }}
                spellCheck={false}
                autoComplete="off"
                className="w-full rounded-lg border border-border bg-transparent px-3 py-1.5 text-body placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
              {destinationError && (
                <p role="alert" className="mt-1.5 text-meta text-danger">
                  {destinationError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
              <Button type="button" onClick={() => destinationDialog.current?.close()}>
                {t("Cancel")}
              </Button>
              <Button type="submit" variant="primary">
                {t("Save")}
              </Button>
            </div>
          </form>
        </Dialog>,
        document.body,
      )}
    </>
  );
}
