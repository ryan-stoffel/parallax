import { Check, LoaderCircle, Palette, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  addExtension,
  fetchExtension,
  parallaxTokens,
  searchThemes,
  useAddedThemes,
  type FoundExtension,
} from "../vscodeThemes";

const popular = ["Dracula", "Catppuccin", "Nord", "Tokyo Night", "GitHub", "One Dark"];
const downloads = new Intl.NumberFormat(undefined, { notation: "compact" });

/**
 * Settings > Appearance's Add theme: a modal that searches Open VSX's color themes, most
 * downloaded first, and adds one's themes (vscodeThemes.ts). Opens when mounted; `onClose` runs
 * when it closes.
 */
export function AddThemeDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundExtension[]>();
  const [error, setError] = useState<string>();
  // An extension's add in flight ("busy"), or why it failed, by `namespace.name`.
  const [status, setStatus] = useState<Record<string, string>>({});
  const added = useAddedThemes();

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchThemes(query, controller.signal).then(
        (found) => (setResults(found), setError(undefined)),
        (e: Error) => controller.signal.aborted || setError(e.message),
      );
    }, 250);
    return () => (clearTimeout(timer), controller.abort());
  }, [query]);

  const add = async ({ namespace, name }: FoundExtension) => {
    const id = `${namespace}.${name}`;
    setStatus((s) => ({ ...s, [id]: "busy" }));
    try {
      addExtension(await fetchExtension(namespace, name, parallaxTokens()));
      setStatus((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
    } catch (e) {
      setStatus((s) => ({ ...s, [id]: e instanceof Error ? e.message : String(e) }));
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[80vh] w-[44rem] flex-col open:flex rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="flex items-start justify-between gap-4 px-5 pt-4">
        <div>
          <h2 id={titleId} className="text-[15px] font-semibold">
            Add a theme
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Search color themes from Open VSX. Each adds its light and dark themes.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="px-5 pt-3">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-border px-3 focus-within:outline-2 focus-within:outline-ring">
          <Search aria-hidden className="size-4 text-faint-foreground" />
          <input
            type="search"
            aria-label="Search themes"
            placeholder="Search themes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[12.5px]">
          <span className="mr-1 text-faint-foreground">Popular</span>
          {popular.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setQuery(p)}
              className="rounded-md px-2 py-0.5 hover:bg-hover"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}
        {!results && !error && <p className="text-[13px] text-muted-foreground">Searching…</p>}
        {results?.length === 0 && (
          <p className="text-[13px] text-muted-foreground">No themes match.</p>
        )}
        <ul className="grid grid-cols-2 gap-3">
          {results?.map((e) => {
            const id = `${e.namespace}.${e.name}`;
            const state = status[id];
            const isAdded = added.some((a) => a.id === id);
            return (
              <li key={id} className="flex flex-col gap-2 rounded-xl border border-border p-3">
                <div className="flex items-center gap-3">
                  {e.files.icon ? (
                    <img src={e.files.icon} alt="" className="size-9 shrink-0 rounded-md" />
                  ) : (
                    <Palette aria-hidden className="size-9 shrink-0 p-1.5 text-faint-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{e.displayName ?? e.name}</p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      {e.namespace}
                      {e.downloadCount !== undefined &&
                        ` · ${downloads.format(e.downloadCount)} downloads`}
                    </p>
                  </div>
                </div>
                {e.description && (
                  <p className="line-clamp-2 text-[12.5px] text-muted-foreground">
                    {e.description}
                  </p>
                )}
                {state && state !== "busy" && (
                  <p role="alert" className="text-[12px] text-danger">
                    {state}
                  </p>
                )}
                <button
                  type="button"
                  disabled={isAdded || state === "busy"}
                  onClick={() => void add(e)}
                  className="mt-auto flex h-7 items-center gap-1.5 self-end rounded-md border border-border px-2.5 text-[12.5px] font-medium enabled:hover:bg-hover disabled:text-muted-foreground"
                >
                  {isAdded ? (
                    <Check className="size-3.5" />
                  ) : state === "busy" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : null}
                  {isAdded ? "Added" : state === "busy" ? "Adding" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </dialog>
  );
}
