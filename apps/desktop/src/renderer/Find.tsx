import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { appShortcut, IconButton } from "./ui";

/**
 * A message's Markdown as it reads once rendered: link syntax, emphasis, code ticks, and list or
 * heading markers gone, so a search finds what the transcript shows.
 */
export function searchText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|#+|>)\s+/gm, "")
    .replace(/\*\*|__|`/g, "");
}

/** Where `query` occurs in `text`, ignoring case, as non-overlapping [start, end) offsets. */
export function occurrences(text: string, query: string): [number, number][] {
  const found: [number, number][] = [];
  if (!query) return found;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    found.push([at, at + needle.length]);
  return found;
}

/** One match: its row, and which of that row's matches it is. */
interface Hit {
  row: number;
  nth: number;
}

/** `query`'s matches across `texts` (a row's searchable text, or "" for none), in row order. */
export function findHits(texts: readonly string[], query: string): Hit[] {
  return texts.flatMap((text, row) => occurrences(text, query).map((_, nth) => ({ row, nth })));
}

const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;

/** The ranges of `query` in `el`'s rendered text, which runs across its elements. */
function domRanges(el: HTMLElement, query: string): Range[] {
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += n.textContent;
  }
  const at = (offset: number, end: boolean) => {
    const i = nodes.findLastIndex((n) => n.start < offset || (!end && n.start === offset));
    const { node, start } = nodes[Math.max(i, 0)]!;
    return [node, offset - start] as const;
  };
  return occurrences(text, query).map(([from, to]) => {
    const range = new Range();
    range.setStart(...at(from, false));
    range.setEnd(...at(to, true));
    return range;
  });
}

/**
 * Find in a thread's transcript, as a browser's: Mod+F opens a box that counts the matches of
 * what's typed, highlights them, and steps through them with Enter and Shift+Enter (or Mod+G and
 * Mod+Shift+G), scrolling to each. The list is virtualized, so matches are counted in `texts`, one
 * per row, and `scrollToRow` brings a match's row into the DOM, where `list`'s rendered rows are
 * highlighted. Returns the box, to render over the transcript.
 */
export function useFind({
  texts,
  list,
  scrollToRow,
}: {
  texts: readonly string[];
  /** The element the rows render in, each marked with its `data-index`. */
  list: RefObject<HTMLElement | null>;
  scrollToRow: (row: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Set by a jump, until the match's row is rendered and scrolled into view.
  const pending = useRef(false);

  const hits = useMemo(() => (open ? findHits(texts, query) : []), [open, texts, query]);
  const at = hits.length ? Math.min(current, hits.length - 1) : -1;
  const step = (by: number) => {
    if (!hits.length) return;
    pending.current = true;
    setCurrent((at + by + hits.length) % hits.length);
  };
  const close = () => setOpen(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (appShortcut(e) === "find") {
        setOpen(true);
        input.current?.focus();
        input.current?.select();
      } else if (open && e.code === "KeyG" && (e.metaKey || e.ctrlKey) && !e.altKey) {
        step(e.shiftKey ? -1 : 1);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // A new search starts at its first match, and so does any jump bring its row into view.
  const rowOf = useRef<number>(undefined);
  rowOf.current = hits[at]?.row;
  useEffect(() => {
    pending.current = true;
    setCurrent(0);
  }, [query, open]);
  useEffect(() => {
    if (rowOf.current !== undefined) scrollToRow(rowOf.current);
    // Only a new current match scrolls, not text streaming in under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, query, open]);

  // Rows render and unmount as the list scrolls, so each render marks the ones in the DOM.
  useLayoutEffect(() => {
    const root = list.current;
    if (!highlights || !root || !open || !query) return;
    const others: Range[] = [];
    let chosen: Range | undefined;
    for (const el of root.querySelectorAll<HTMLElement>("[data-index]")) {
      const ranges = domRanges(el, query);
      const hit = hits[at];
      const pick =
        hit && hit.row === Number(el.dataset["index"]) ? Math.min(hit.nth, ranges.length - 1) : -1;
      ranges.forEach((r, i) => (i === pick ? (chosen = r) : others.push(r)));
    }
    highlights.set("find", new Highlight(...others));
    highlights.set("find-current", new Highlight(...(chosen ? [chosen] : [])));
    if (chosen && pending.current) {
      pending.current = false;
      chosen.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }
  });
  useEffect(() => {
    if (open && query) return;
    highlights?.delete("find");
    highlights?.delete("find-current");
  }, [open, query]);
  useEffect(
    () => () => {
      highlights?.delete("find");
      highlights?.delete("find-current");
    },
    [],
  );

  const bar = open && (
    <div
      role="search"
      aria-label="Find in thread"
      className="absolute top-2 right-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-surface p-1 pl-2.5 text-[13px] shadow-composer"
    >
      <input
        ref={input}
        type="text"
        aria-label="Find in thread"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
          else return;
          e.preventDefault();
        }}
        className="w-48 bg-transparent py-1 text-foreground outline-none placeholder:text-faint-foreground"
      />
      <span
        role="status"
        aria-live="polite"
        className="min-w-14 px-1 text-right text-[12px] text-muted-foreground tabular-nums"
      >
        {query && (hits.length ? `${at + 1}/${hits.length}` : "No results")}
      </span>
      <IconButton label="Previous match" disabled={!hits.length} onClick={() => step(-1)}>
        <ChevronUp />
      </IconButton>
      <IconButton label="Next match" disabled={!hits.length} onClick={() => step(1)}>
        <ChevronDown />
      </IconButton>
      <IconButton label="Close find" onClick={close}>
        <X />
      </IconButton>
    </div>
  );
  return { bar };
}
