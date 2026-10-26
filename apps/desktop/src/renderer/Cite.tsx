import { Quote } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ToggleEvent,
} from "react";
import { createPortal } from "react-dom";

/** Agent text the user cites in their next prompt, with what they say about it. */
export interface Citation {
  quote: string;
  comment: string;
}

/** A citation as the prompt sends it: the cited text as a Markdown quote, then the comment. */
export function citationText({ quote, comment }: Citation): string {
  const quoted = quote
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  return comment.trim() ? `${quoted}\n\n${comment.trim()}` : quoted;
}

/**
 * The box for a citation's comment, under `at`, or over it in the window's lower part, as for the
 * composer's chip. Save, or Enter, hands back what's typed; Cancel, Escape, and clicking away
 * close it.
 */
export function CommentBox({
  at,
  initial = "",
  onSave,
  onClose,
}: {
  at: DOMRect;
  initial?: string;
  onSave: (comment: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLFormElement>(null);
  const [comment, setComment] = useState(initial);
  useLayoutEffect(() => {
    box.current?.showPopover();
    // With the caret after the comment being edited.
    const area = box.current?.querySelector("textarea");
    area?.focus();
    area?.setSelectionRange(area.value.length, area.value.length);
  }, []);
  const below = at.bottom < window.innerHeight * 0.6;
  const width = Math.min(384, window.innerWidth - 16);
  return createPortal(
    <form
      ref={box}
      popover="auto"
      aria-label="Cite"
      onToggle={(e: ToggleEvent<HTMLFormElement>) => e.newState === "closed" && onClose()}
      onSubmit={(e) => {
        e.preventDefault();
        // React bubbles it through the portal, and the composer's own form would send.
        e.stopPropagation();
        onSave(comment.trim());
      }}
      style={{
        width,
        left: Math.max(8, Math.min(at.left, window.innerWidth - width - 8)),
        ...(below ? { top: at.bottom + 8 } : { bottom: window.innerHeight - at.top + 8 }),
      }}
      className="fixed inset-auto m-0 rounded-xl border border-border bg-surface p-3 text-foreground shadow-composer"
    >
      <textarea
        aria-label="Comment"
        placeholder="Add an optional comment..."
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.currentTarget.form?.requestSubmit();
        }}
        className="block w-full resize-none bg-transparent text-reading outline-none placeholder:text-faint-foreground"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => box.current?.hidePopover()}
          className="rounded-md border border-border px-3 py-1.5 text-body hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-body font-medium text-accent-foreground hover:opacity-90"
        >
          Save
        </button>
      </div>
    </form>,
    document.body,
  );
}

/** The agent text selected in `log`, Markdown that Enriched Markdown drew, or undefined. */
function selectedIn(log: HTMLElement) {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const inAgentText = (node: Node | null) => {
    const el = node instanceof Element ? node : node?.parentElement;
    return !!el && log.contains(el) && !!el.closest(".enriched");
  };
  if (!inAgentText(selection.anchorNode) || !inAgentText(selection.focusNode)) return;
  const quote = selection.toString().trim();
  return quote ? { quote, range: selection.getRangeAt(0).cloneRange() } : undefined;
}

// The cited text's highlight while its comment box has focus, which takes the selection away.
const citing = "cite";

/**
 * Cite, beside agent text the user finishes selecting in the transcript `log`, and the comment
 * box it opens. `onCite` gets the text and the comment saved for it.
 */
export function CiteSelection({
  log,
  onCite,
}: {
  log: RefObject<HTMLElement | null>;
  onCite: (citation: Citation) => void;
}) {
  const [picked, setPicked] = useState<{ quote: string; range: Range }>();
  const [open, setOpen] = useState<{ quote: string; at: DOMRect }>();
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    // After the browser settles the selection: a click inside one clears it on the way up.
    const onUp = () => setTimeout(() => setPicked(selectedIn(el)));
    const onChange = () => getSelection()?.isCollapsed && setPicked(undefined);
    // Cite follows the text as it scrolls, by hand or as a reply streams in.
    const onScroll = () => setPicked((p) => p && { ...p });
    el.addEventListener("pointerup", onUp);
    el.addEventListener("scroll", onScroll);
    document.addEventListener("selectionchange", onChange);
    return () => {
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [log]);
  const close = () => {
    CSS.highlights.delete(citing);
    setOpen(undefined);
  };

  const rects = picked?.range.getClientRects();
  const end = rects?.[rects.length - 1];
  return (
    <>
      {picked &&
        end &&
        createPortal(
          <button
            type="button"
            // Keeps the selection, which a press would clear.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              CSS.highlights.set(citing, new Highlight(picked.range));
              setOpen({ quote: picked.quote, at: picked.range.getBoundingClientRect() });
              setPicked(undefined);
            }}
            style={{ top: end.bottom + 6, left: Math.max(8, end.right - 24) }}
            className="fixed z-50 flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-body text-foreground shadow-composer hover:bg-hover [&_svg]:size-4"
          >
            <Quote aria-hidden />
            Cite
          </button>,
          document.body,
        )}
      {open && (
        <CommentBox
          at={open.at}
          onClose={close}
          onSave={(comment) => {
            close();
            getSelection()?.removeAllRanges();
            onCite({ quote: open.quote, comment });
          }}
        />
      )}
    </>
  );
}
