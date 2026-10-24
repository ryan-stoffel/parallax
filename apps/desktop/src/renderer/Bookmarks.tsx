import { Globe, PanelTop, Star, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";

import { stored } from "./stored";
import { Menu, menuItem, openOnContextMenu } from "./ui";

// The browser's bookmarks (PLX-968): one list, shared by every browser, a thread's, a Project's,
// and the permanent one, and kept on this computer.

/** A bookmarked page, with its title and icon as they were when it was added. */
export interface Bookmark {
  url: string;
  title?: string;
  icon?: string;
}

export const bookmarks = stored<Bookmark[]>("parallax.bookmarks", [], (raw, fallback) =>
  Array.isArray(raw)
    ? raw.filter((b): b is Bookmark => typeof (b as Bookmark | null)?.url === "string")
    : fallback,
);

/** Whether the bookmarks bar shows, while there are bookmarks. */
export const bookmarksBar = stored<boolean>("parallax.bookmarksBar", true, (raw, fallback) =>
  typeof raw === "boolean" ? raw : fallback,
);

/**
 * `list` with `page` bookmarked at its end, or with its bookmark removed when it has one. Its icon,
 * a data URL (main.ts), is kept only when small, as a favicon is.
 */
export function toggled(list: readonly Bookmark[], page: Bookmark): Bookmark[] {
  if (list.some((b) => b.url === page.url)) return list.filter((b) => b.url !== page.url);
  return [
    ...list,
    {
      url: page.url,
      ...(page.title && { title: page.title }),
      ...(page.icon && page.icon.length <= 16_384 && { icon: page.icon }),
    },
  ];
}

/** The star at the end of the address bar: bookmarks `page`, or removes its bookmark. */
export function BookmarkStar({ page }: { page?: Bookmark }) {
  const marked = bookmarks.use().some((b) => b.url === page?.url);
  return (
    <button
      type="button"
      aria-label={marked ? "Remove bookmark" : "Bookmark this page"}
      title={marked ? "Remove bookmark" : "Bookmark this page"}
      aria-pressed={marked}
      disabled={!page}
      onClick={() => page && bookmarks.set(toggled(bookmarks.get(), page))}
      className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-0 aria-pressed:text-accent [&_svg]:size-3.5"
    >
      <Star aria-hidden className={marked ? "fill-current" : ""} />
    </button>
  );
}

/**
 * The bookmarks bar under a tab's toolbar, as Chrome and Helium draw it: each bookmark's icon and
 * title. A click opens it with `onOpen`, in the tab, and a middle click or Mod-click in a new tab.
 * Right-click offers Open in new tab and Remove. It shows only while turned on and not empty.
 */
export function BookmarksBar({ onOpen }: { onOpen: (url: string, newTab: boolean) => void }) {
  const list = bookmarks.use();
  const shown = bookmarksBar.use();
  const menuId = useId();
  const [menuFor, setMenuFor] = useState<string>();
  const triggers = useRef(new Map<string, HTMLElement>());
  if (!shown || !list.length) return null;
  return (
    <nav
      aria-label="Bookmarks"
      className="flex h-7 shrink-0 items-center gap-0.5 overflow-hidden px-2"
    >
      {list.map((b) => (
        <span key={b.url} className="relative min-w-0 shrink">
          <button
            type="button"
            title={b.url}
            onClick={(e) => onOpen(b.url, e.metaKey || e.ctrlKey)}
            onAuxClick={(e) => e.button === 1 && onOpen(b.url, true)}
            onContextMenu={(e) => {
              setMenuFor(b.url);
              openOnContextMenu(e, triggers.current.get(b.url) ?? null);
            }}
            className="flex h-6 max-w-44 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            {b.icon ? (
              <img src={b.icon} alt="" className="size-3.5 shrink-0" />
            ) : (
              <Globe aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{b.title || b.url}</span>
          </button>
          {/* The context menu's anchor, so it opens under this bookmark. */}
          <button
            ref={(el) => {
              if (el) triggers.current.set(b.url, el);
              else triggers.current.delete(b.url);
            }}
            type="button"
            tabIndex={-1}
            aria-hidden
            popoverTarget={menuId}
            onClick={() => setMenuFor(b.url)}
            className="pointer-events-none absolute bottom-0 left-2 size-0 opacity-0"
          />
        </span>
      ))}
      <Menu id={menuId} label="Bookmark" className="w-48 p-1">
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            if (menuFor) onOpen(menuFor, true);
            e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
          }}
          className={menuItem}
        >
          <PanelTop aria-hidden />
          Open in new tab
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            if (menuFor) bookmarks.set(bookmarks.get().filter((b) => b.url !== menuFor));
            e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
          }}
          className={menuItem}
        >
          <Trash2 aria-hidden />
          Remove
        </button>
      </Menu>
    </nav>
  );
}
