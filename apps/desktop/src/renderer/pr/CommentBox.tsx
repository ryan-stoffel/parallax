import { useEffect, useRef, useState } from "react";

import type { CommentTarget } from "../diffRows";
import { icons } from "../icons";
import { useSticky } from "../sticky";
import { Button, IconButton } from "../ui";
import { suggestionBlock } from "./suggestions";

/** What a comment box's lines are called. */
export function targetName(target: CommentTarget) {
  const r = target.range;
  if (!r) return "Whole file";
  const lines = r.start === r.end ? `Line ${r.end}` : `Lines ${r.start} to ${r.end}`;
  return r.side === "left" ? `${lines}, old file` : lines;
}

/**
 * The box for a new comment under a diff's lines. Its primary starts or adds to the pending review,
 * and with no pending review it can also post the comment alone, as GitHub's page offers. Its text
 * outlives the row, under `draftKey`. `onSend` resolves to whether it worked: the text stays until
 * it does. With `lines`, the new-side text it's on, its Suggest icon inserts a suggestion block to edit.
 */
export function CommentBox({
  target,
  draftKey,
  pending,
  lines,
  onText,
  onSend,
  onCancel,
}: {
  target: CommentTarget;
  draftKey: string;
  /** Whether a pending review is already open. */
  pending: boolean;
  lines?: readonly string[];
  /** Told whether the box holds text, which stops a click on another line replacing it. */
  onText: (hasText: boolean) => void;
  onSend: (body: string, single: boolean) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [body, setBody] = useSticky(draftKey, "");
  const [sending, setSending] = useState<"review" | "single">();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  const text = body.trim();
  // Not cleared when the row scrolls away: its text waits under `draftKey` for these lines.
  useEffect(() => onText(!!text), [text, onText]);
  const suggest = () => {
    const el = field.current!;
    const at = el.selectionStart;
    const before = body.slice(0, at);
    const block = suggestionBlock(lines!, before);
    setBody(before + block + body.slice(el.selectionEnd));
    // Inside the block, on its last line, ready to edit.
    const caret = before.length + block.lastIndexOf("\n```");
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
    });
  };
  const send = async (how: "review" | "single") => {
    if (!text || sending) return;
    setSending(how);
    const ok = await onSend(text, how === "single");
    setSending(undefined);
    if (ok) setBody("");
  };
  return (
    <form
      aria-label={`Comment on ${targetName(target)}`}
      className="overflow-hidden rounded-xl border border-border bg-surface font-sans shadow-xs focus-within:border-faint-foreground/60"
      onSubmit={(e) => {
        e.preventDefault();
        void send("review");
      }}
    >
      <p className="px-3 pt-2 text-meta text-faint-foreground">{targetName(target)}</p>
      <textarea
        ref={field}
        aria-label="Comment"
        placeholder="Leave a comment"
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          if (e.key === "Escape" && !body) onCancel();
        }}
        className="field-sizing-content block max-h-64 min-h-16 w-full resize-none bg-transparent px-3 py-1.5 text-body placeholder:text-faint-foreground focus-visible:outline-none"
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5 px-2 pb-2">
        {lines && (
          <span className="mr-auto">
            <IconButton size="md" label="Suggest a change" disabled={!!sending} onClick={suggest}>
              <icons.suggest aria-hidden />
            </IconButton>
          </span>
        )}
        <Button
          size="sm"
          disabled={!!sending}
          onClick={() => {
            setBody("");
            onCancel();
          }}
        >
          Cancel
        </Button>
        {!pending && (
          <Button
            size="sm"
            variant="outline"
            disabled={!text || !!sending}
            onClick={() => void send("single")}
          >
            {sending === "single" ? "Posting…" : "Add single comment"}
          </Button>
        )}
        <Button size="sm" variant="primary" type="submit" disabled={!text || !!sending}>
          {sending === "review" ? "Adding…" : pending ? "Add to review" : "Start a review"}
        </Button>
      </div>
    </form>
  );
}
