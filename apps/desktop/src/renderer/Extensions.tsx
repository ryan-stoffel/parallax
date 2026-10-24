import { FolderOpen, Trash2 } from "lucide-react";
import { createElement, useEffect, useId, useState } from "react";

import type { ExtensionInfo } from "../preload/bridge";
import { dismiss, notify } from "./notifications";
import { memory } from "./stored";
import { Extension } from "./symbols";
import { IconButton, Menu, menuHeading, menuItem } from "./ui";

// The installed extensions, shared by every tab's toolbar, read once and after each change.
const installed = memory<ExtensionInfo[] | undefined>(undefined);
const refresh = () => window.parallax.extensions().then((list) => installed.set(list));

/**
 * A tab toolbar's Chrome extensions (PLX-888): electron-chrome-extensions' buttons, with their
 * badges and popups, for the tab whose webview's webContents id is `tab`, and the Extensions menu,
 * which lists them all, removes one, and adds one from a Chrome Web Store link or an unpacked
 * folder. The store's own Add to Chrome button adds one too (webStore.ts in main).
 */
export function Extensions({ tab }: { tab?: number }) {
  const list = installed.use();
  useEffect(() => {
    if (!list) void refresh();
  }, [list]);
  // An extension added or removed from the Chrome Web Store's page (PLX-962).
  useEffect(() => window.parallax.onExtensionsChanged(() => void refresh()), []);
  const menuId = useId();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  const added = (answer: ExtensionInfo | string | undefined) => {
    if (typeof answer === "string")
      notify({
        key: "extension",
        tone: "error",
        title: "Couldn't add the extension",
        body: answer,
      });
    else if (answer) {
      dismiss("extension");
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

  return (
    <div className="flex shrink-0 items-center">
      {/* The library's own element (preload.ts): a button per extension, which opens its popup
          under it. Keyed by the list, so an extension added or removed shows at once. */}
      {createElement("browser-action-list", {
        key: list?.map((e) => e.id).join(),
        partition: "persist:browser",
        alignment: "bottom left",
        ...(tab !== undefined && { tab: String(tab) }),
      })}
      <IconButton label="Extensions" popoverTarget={menuId} aria-haspopup="menu">
        <Extension />
      </IconButton>
      <Menu
        id={menuId}
        label="Extensions"
        align="end"
        focus='input, [role="menuitem"]'
        className="w-72 p-1"
      >
        <p className={menuHeading}>Extensions</p>
        {list?.length ? (
          list.map((extension) => (
            <div key={extension.id} className={`${menuItem} group pr-1 hover:bg-transparent`}>
              {extension.icon ? (
                <img src={extension.icon} alt="" className="size-4 shrink-0" />
              ) : (
                <Extension aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{extension.name}</span>
              <span className="shrink-0 text-[11.5px] text-faint-foreground">
                {extension.version}
              </span>
              <button
                type="button"
                aria-label={`Remove ${extension.name}`}
                title={`Remove ${extension.name}`}
                onClick={() => void window.parallax.removeExtension(extension.id).then(refresh)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100"
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
    </div>
  );
}
