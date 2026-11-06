import { useRef, useState, type Ref } from "react";

import { browserHistory, byDay, searchHistory } from "./browserHistory";
import { Close, Search } from "./symbols";
import { ConfirmDialog, IconButton } from "./ui";

/**
 * The browser's History (PLX-976), as Chrome's: a search, and the visits, the newest first, by
 * day. A click opens a visit with `onOpen` in the tab, a middle click or Mod-click in a new tab,
 * and × forgets it. Clear browsing history forgets them all, once confirmed.
 */
export function HistoryDialog({
  ref,
  onOpen,
}: {
  ref: Ref<HTMLDialogElement>;
  onOpen: (url: string, newTab: boolean) => void;
}) {
  // Every browser has one, so the visits are read and drawn only while it's open, not on each
  // visit every browser makes.
  const [open, setOpen] = useState(false);
  return (
    <dialog
      ref={ref}
      aria-label="History"
      // Its own toggles, not the confirm's inside it, whose toggle bubbles up here too.
      onToggle={(e) => e.target === e.currentTarget && setOpen(e.newState === "open")}
      className="m-auto flex h-[min(42rem,85vh)] w-[min(44rem,90vw)] flex-col rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/40 not-open:hidden"
    >
      {open && <HistoryList onOpen={onOpen} />}
    </dialog>
  );
}

// One formatter for every row's time.
const timeOf = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** History's search, visits, and Clear browsing history, while the dialog is open. */
function HistoryList({ onOpen }: { onOpen: (url: string, newTab: boolean) => void }) {
  const visits = browserHistory.use();
  const [query, setQuery] = useState("");
  const confirm = useRef<HTMLDialogElement>(null);
  const days = byDay(searchHistory(visits, query));
  const close = (e: { currentTarget: HTMLElement }) => e.currentTarget.closest("dialog")?.close();
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-reading font-semibold">History</h2>
        <label className="ml-4 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--browser-omnibox,var(--selected))] px-2.5 text-body [&>svg]:size-4 [&>svg]:text-muted-foreground">
          <Search aria-hidden />
          <input
            autoFocus
            aria-label="Search history"
            placeholder="Search history"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint-foreground"
          />
        </label>
        <button
          type="button"
          disabled={!visits.length}
          onClick={() => confirm.current?.showModal()}
          className="rounded-md px-2.5 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50"
        >
          Clear browsing history
        </button>
        <IconButton label="Close history" onClick={close}>
          <Close />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!days.length && (
          <p className="px-3 py-8 text-center text-body text-muted-foreground">
            {visits.length ? "No visits match." : "Pages you visit show up here."}
          </p>
        )}
        {days.map(({ day, visits: list }) => (
          <section key={day} aria-label={day} className="mb-3">
            <h3 className="px-3 py-1.5 text-meta font-medium text-muted-foreground">{day}</h3>
            <ul>
              {list.map((v) => (
                <li
                  key={`${v.time}:${v.url}`}
                  className="group flex items-center gap-3 rounded-md px-3 hover:bg-hover"
                >
                  <span className="w-16 shrink-0 text-meta text-faint-foreground tabular-nums">
                    {timeOf.format(v.time)}
                  </span>
                  <button
                    type="button"
                    title={v.url}
                    onClick={(e) => {
                      onOpen(v.url, e.metaKey || e.ctrlKey);
                      close(e);
                    }}
                    onAuxClick={(e) => e.button === 1 && onOpen(v.url, true)}
                    className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-left text-body"
                  >
                    <span className="truncate">{v.title || v.url.replace(/^https?:\/\//, "")}</span>
                    <span className="shrink-0 truncate text-meta text-faint-foreground">
                      {URL.parse(v.url)?.host}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${v.title || v.url} from history`}
                    title="Remove from history"
                    onClick={() => browserHistory.set(browserHistory.get().filter((x) => x !== v))}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 [&_svg]:size-4"
                  >
                    <Close aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <ConfirmDialog
        ref={confirm}
        title="Clear browsing history?"
        action="Clear history"
        onConfirm={() => {
          browserHistory.set([]);
          confirm.current?.close();
        }}
      >
        Every page every browser in Parallax has visited goes from History.
      </ConfirmDialog>
    </>
  );
}
