import type { WebviewTag } from "electron";
import { FolderOpen, Puzzle, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { ExtensionInfo } from "../preload/bridge";
import { onAsk } from "./Browser";
import { memory } from "./stored";
import { IconButton, Menu, menuHeading, menuItem, menuPanel } from "./ui";

// The installed extensions, shared by every tab's toolbar, read once and after each change.
const installed = memory<ExtensionInfo[] | undefined>(undefined);
const refresh = () => window.parallax.extensions().then((list) => installed.set(list));

/** The most extension icons the toolbar shows before the rest wait in the Extensions menu. */
const SHOWN = 3;

/**
 * A tab toolbar's Chrome extensions (PLX-888): the icons of those with a popup, which opens under
 * the toolbar, and the Extensions menu, which lists them all, removes one, and adds one from a
 * Chrome Web Store link or an unpacked folder. A popup's links open as tabs through `onOpen`.
 */
export function Extensions({ onOpen }: { onOpen: (url: string) => void }) {
  const list = installed.use();
  useEffect(() => {
    if (!list) void refresh();
  }, [list]);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<ExtensionInfo>();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Shows an extension's popup under `from`, the button that asked.
  const open = (extension: ExtensionInfo, from: HTMLElement) => {
    menu.current?.hidePopover();
    setPopup(extension);
    panel.current?.showPopover({ source: from } as ShowPopoverOptions);
  };
  const added = (answer: ExtensionInfo | string | undefined) => {
    if (typeof answer === "string") setError(answer);
    else if (answer) {
      setError(undefined);
      setLink("");
    }
    void refresh();
  };

  const install = () => {
    if (!link.trim() || busy) return;
    setBusy(true);
    void window.parallax
      .installExtension(link)
      .then(added)
      .finally(() => setBusy(false));
  };

  const icon = (extension: ExtensionInfo) =>
    extension.icon ? (
      <img src={extension.icon} alt="" className="size-4 shrink-0" />
    ) : (
      <Puzzle aria-hidden className="size-4 shrink-0" />
    );
  const withPopup = list?.filter((e) => e.popup) ?? [];
  return (
    <div className="flex shrink-0 items-center">
      {withPopup.slice(0, SHOWN).map((extension) => (
        <button
          key={extension.id}
          type="button"
          aria-label={extension.name}
          title={extension.name}
          onClick={(e) => open(extension, e.currentTarget)}
          className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-hover"
        >
          {icon(extension)}
        </button>
      ))}
      <IconButton label="Extensions" popoverTarget={menuId} aria-haspopup="menu">
        <Puzzle />
      </IconButton>
      <Menu
        ref={menu}
        id={menuId}
        label="Extensions"
        align="end"
        focus='input, [role="menuitem"]'
        onClose={() => setError(undefined)}
        className="w-72 p-1"
      >
        <p className={menuHeading}>Extensions</p>
        {list?.length ? (
          list.map((extension) => (
            <div key={extension.id} className="group flex items-center">
              <button
                type="button"
                role="menuitem"
                disabled={!extension.popup}
                title={extension.popup ? `Open ${extension.name}` : "This extension has no popup"}
                onClick={(e) => open(extension, e.currentTarget)}
                className={`${menuItem} min-w-0 flex-1 disabled:hover:bg-transparent`}
              >
                {icon(extension)}
                <span className="min-w-0 flex-1 truncate">{extension.name}</span>
                <span className="shrink-0 text-[11.5px] text-faint-foreground">
                  {extension.version}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${extension.name}`}
                title={`Remove ${extension.name}`}
                onClick={() => void window.parallax.removeExtension(extension.id).then(refresh)}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5"
              >
                <Trash2 aria-hidden />
              </button>
            </div>
          ))
        ) : (
          <p className="px-2 pb-2 text-[12.5px] text-muted-foreground">
            None yet. Add one from the Chrome Web Store, such as a password manager.
          </p>
        )}
        <div className="my-1 h-px bg-border" />
        <form
          className="flex gap-1 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            install();
          }}
        >
          <input
            aria-label="Chrome Web Store link"
            placeholder="Paste a Chrome Web Store link"
            spellCheck={false}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            className="min-w-0 flex-1 rounded-md bg-selected px-2 py-1 text-[12.5px] placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
          <button
            type="submit"
            disabled={busy || !link.trim()}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-foreground disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </form>
        {error && (
          <p role="alert" className="px-2 pb-1 text-[12px] text-danger">
            {error}
          </p>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => void window.parallax.loadUnpackedExtension().then(added)}
          className={menuItem}
        >
          <FolderOpen aria-hidden />
          Load unpacked…
        </button>
      </Menu>
      <div
        ref={panel}
        popover="auto"
        aria-label={popup?.name}
        onToggle={(e) => e.newState !== "open" && setPopup(undefined)}
        className={`${menuPanel("end")} overflow-hidden p-0`}
      >
        {popup?.popup && <Popup key={popup.id} src={popup.popup} onOpen={onOpen} />}
      </div>
    </div>
  );
}

/** An extension's popup page, sized to its content as Chrome sizes one, up to 800 by 600. */
function Popup({ src, onOpen }: { src: string; onOpen: (url: string) => void }) {
  const view = useRef<WebviewTag>(null);
  const [size, setSize] = useState({ width: 320, height: 120 });
  const latest = useRef(onOpen);
  latest.current = onOpen;
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    let stop = () => {};
    const attached = () => {
      stop();
      stop = onAsk(el.getWebContentsId(), (action) => {
        if (action.kind === "open") latest.current(action.url);
        else if (action.kind === "size")
          setSize({
            width: Math.min(800, Math.max(160, action.width)),
            height: Math.min(600, Math.max(40, action.height)),
          });
      });
    };
    el.addEventListener("did-attach", attached);
    return () => {
      stop();
      el.removeEventListener("did-attach", attached);
    };
  }, []);
  return <webview ref={view} src={src} style={size} className="flex" />;
}
