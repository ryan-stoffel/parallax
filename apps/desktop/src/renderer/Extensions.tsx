import { createElement, useEffect, useId, useRef, useState } from "react";

import type { ExtensionInfo } from "../preload/bridge";
import { browserSettingsAsked } from "./browserSettings";
import { memory, stored } from "./stored";
import { Close, Delete, Extension, Keep, KeepOff, MoreVert, Settings, Storefront } from "./symbols";
import { IconButton, Menu, toolbarButton, toolbarMenuDivider, ToolbarMenuRow } from "./ui";

// The installed extensions, shared by every tab's toolbar, read once and after each change.
const installed = memory<ExtensionInfo[] | undefined>(undefined);
const refresh = () => window.parallax.extensions().then((list) => installed.set(list));

/** The installed extensions, read the first time they're asked for, and how to read them again. */
export function useExtensions() {
  const list = installed.use();
  useEffect(() => {
    if (!list) void refresh();
  }, [list]);
  return { list, refresh };
}

/**
 * The extensions unpinned from the toolbar, by id, kept on this computer. A new extension starts
 * pinned, so it shows as soon as it's added.
 */
const unpinned = stored<string[]>("parallax.unpinnedExtensions", [], (raw, fallback) =>
  Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : fallback,
);

// electron-chrome-extensions' toolbar actions in the page (preload.ts): their state, which the
// hidden `browser-action-list` keeps fetching, and opening one's popup.
interface BrowserActions {
  getAction(id: string): unknown;
  addEventListener(name: "update", listener: () => void): void;
  removeEventListener(name: "update", listener: () => void): void;
  activate(
    partition: string,
    details: {
      eventType: string;
      extensionId: string;
      tabId: number;
      alignment: string;
      anchorRect: { x: number; y: number; width: number; height: number };
    },
  ): void;
}
const actions = () => (window as unknown as { browserAction?: BrowserActions }).browserAction;
const partition = "persist:browser";

/**
 * A tab toolbar's Chrome extensions (PLX-888): the pinned ones' buttons, with their badges and
 * popups, for the tab whose webview's webContents id is `tab`, and the Extensions menu, laid out
 * as Chrome's (PLX-981). It lists every extension: a click opens its popup, the pin shows or
 * hides its button, and its ⋮ removes it. Manage extensions opens Settings › Browser, which adds
 * one from a link or a folder; the Chrome Web Store's own Add to Chrome adds one too (webStore.ts
 * in main), and `onOpen` opens the store in a new tab.
 */
export function Extensions({ tab, onOpen }: { tab?: number; onOpen: (url: string) => void }) {
  const { list } = useExtensions();
  const hidden = unpinned.use();
  // An extension added or removed from the Chrome Web Store's page (PLX-962).
  useEffect(() => window.parallax.onExtensionsChanged(() => void refresh()), []);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  // A pinned button draws from its action's state, which the hidden list fetches, so it mounts
  // once that's there, and its badge and icon change with it; the library updates only its own
  // list's buttons, so these update here.
  const [, setFetched] = useState(0);
  useEffect(() => {
    const update = () => {
      setFetched((n) => n + 1);
      bar.current
        ?.querySelectorAll<HTMLButtonElement & { update?: () => void }>("button[is]")
        .forEach((button) => button.update?.());
    };
    actions()?.addEventListener("update", update);
    return () => actions()?.removeEventListener("update", update);
  }, []);

  const pinned =
    list?.filter((e) => !hidden.includes(e.id) && actions()?.getAction(e.id) !== undefined) ?? [];
  const setPinned = (id: string, pin: boolean) =>
    unpinned.set(pin ? hidden.filter((x) => x !== id) : [...hidden, id]);
  // Opens an extension's popup under the Extensions button, as Chrome does from its menu.
  const activate = (id: string) => {
    menu.current?.hidePopover();
    const rect = bar.current?.querySelector('[aria-label="Extensions"]')?.getBoundingClientRect();
    if (!rect) return;
    actions()?.activate(partition, {
      eventType: "click",
      extensionId: id,
      tabId: tab ?? -1,
      alignment: "bottom left",
      anchorRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  };

  return (
    <div ref={bar} className="flex shrink-0 items-center">
      {/* The library's own list, hidden, keeps the actions' state fetched for the buttons. */}
      {createElement("browser-action-list", { partition, hidden: true })}
      {pinned.map((extension) =>
        // The library's button for one extension, which opens its popup under it. Its state
        // is there once the list has fetched it.
        createElement("button", {
          is: "browser-action",
          key: extension.id,
          id: extension.id,
          partition,
          alignment: "bottom left",
          tab: String(tab ?? -1),
          class: "browser-action",
        }),
      )}
      <IconButton
        label="Extensions"
        className={toolbarButton}
        popoverTarget={menuId}
        aria-haspopup="menu"
      >
        <Extension />
      </IconButton>
      <Menu
        ref={menu}
        id={menuId}
        label="Extensions"
        align="end"
        focus='[role="menuitem"]'
        className="w-80 p-1.5"
      >
        <div className="flex items-center justify-between py-1 pr-0.5 pl-2.5">
          <p className="text-[14px] font-medium">Extensions</p>
          <button
            type="button"
            aria-label="Close"
            onClick={() => menu.current?.hidePopover()}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-[18px]"
          >
            <Close aria-hidden />
          </button>
        </div>
        {list?.length ? (
          list.map((extension) => (
            <ExtensionRow
              key={extension.id}
              extension={extension}
              pinned={!hidden.includes(extension.id)}
              onActivate={() => activate(extension.id)}
              onPin={(pin) => setPinned(extension.id, pin)}
            />
          ))
        ) : (
          <p className="px-2.5 pt-1 pb-2 text-[12.5px] text-muted-foreground">
            None yet. Add one from the Chrome Web Store, such as a password manager.
          </p>
        )}
        <hr className={toolbarMenuDivider} />
        <ToolbarMenuRow
          icon={<Storefront aria-hidden />}
          label="Chrome Web Store"
          onClick={() => {
            menu.current?.hidePopover();
            onOpen("https://chromewebstore.google.com/category/extensions");
          }}
        />
        <ToolbarMenuRow
          icon={<Settings aria-hidden />}
          label="Manage extensions"
          onClick={() => {
            menu.current?.hidePopover();
            browserSettingsAsked.set({ title: "Extensions" });
          }}
        />
      </Menu>
    </div>
  );
}

/**
 * One extension in the Extensions menu: its icon and name, which open its popup, a pin, blue
 * while it's on the toolbar, and a ⋮ menu that removes it.
 */
function ExtensionRow({
  extension,
  pinned,
  onActivate,
  onPin,
}: {
  extension: ExtensionInfo;
  pinned: boolean;
  onActivate: () => void;
  onPin: (pin: boolean) => void;
}) {
  const moreId = useId();
  const rowButton =
    "grid size-7 shrink-0 place-items-center rounded-md hover:bg-hover [&_svg]:size-[18px]";
  return (
    <div className="flex items-center gap-0.5 rounded-md hover:bg-hover">
      <button
        type="button"
        role="menuitem"
        onClick={onActivate}
        className="flex h-9 min-w-0 flex-1 items-center gap-3 pl-2.5 text-left text-[13px]"
      >
        {extension.icon ? (
          <img src={extension.icon} alt="" className="size-[18px] shrink-0" />
        ) : (
          <Extension aria-hidden className="size-[18px] shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{extension.name}</span>
      </button>
      <button
        type="button"
        aria-label={pinned ? `Unpin ${extension.name}` : `Pin ${extension.name}`}
        title={pinned ? "Unpin from toolbar" : "Pin to toolbar"}
        aria-pressed={pinned}
        onClick={() => onPin(!pinned)}
        className={`${rowButton} ${pinned ? "text-accent" : "text-muted-foreground hover:text-foreground"}`}
      >
        {pinned ? <KeepOff aria-hidden /> : <Keep aria-hidden />}
      </button>
      <button
        type="button"
        aria-label={`More for ${extension.name}`}
        title="More"
        popoverTarget={moreId}
        aria-haspopup="menu"
        className={`${rowButton} mr-1 text-muted-foreground hover:text-foreground`}
      >
        <MoreVert aria-hidden />
      </button>
      <Menu id={moreId} label={extension.name} align="end" className="w-56 p-1.5">
        <ToolbarMenuRow
          icon={<Delete aria-hidden />}
          label="Remove from Parallax"
          onClick={() => void window.parallax.removeExtension(extension.id).then(refresh)}
        />
      </Menu>
    </div>
  );
}
