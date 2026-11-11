import { useRef, useState } from "react";

import type { PrReviewEvent, PrWrite } from "../../protocol/generated/protocol";
import { icons } from "../icons";
import { useSticky } from "../sticky";
import { Badge, Button, ConfirmDialog } from "../ui";

/**
 * The box to comment, approve, or request changes. With a pending review it sends that review, its
 * `pending` comments included, and can discard it. Its text outlives it, under `draftKey`.
 */
export function ReviewForm({
  write,
  open,
  draftKey,
  reviewId,
  pending = 0,
  bare,
  onDone,
}: {
  write?: (w: PrWrite) => Promise<boolean>;
  open: boolean;
  draftKey: string;
  /** The viewer's pending review. */
  reviewId?: string;
  /** How many comments it holds. */
  pending?: number;
  /** Sits in a panel of its own, so it draws no box. */
  bare?: boolean;
  onDone?: () => void;
}) {
  const [body, setBody] = useSticky(draftKey, "");
  const [sending, setSending] = useState<string>();
  const discard = useRef<HTMLDialogElement>(null);
  if (!write)
    return (
      <p className="text-meta text-faint-foreground">
        Commenting and reviewing need a newer plxd on this host.
      </p>
    );
  const send = async (kind: string, w: PrWrite) => {
    setSending(kind);
    const ok = await write(w);
    setSending(undefined);
    if (ok) {
      setBody("");
      onDone?.();
    }
    return ok;
  };
  const text = body.trim();
  const review = (kind: string, event: PrReviewEvent) =>
    send(
      kind,
      reviewId
        ? { kind: "submitReview", reviewId, event, body: text }
        : { kind: "review", event, body: text },
    );
  const comment = () =>
    reviewId ? review("comment", "comment") : send("comment", { kind: "comment", body: text });
  const canSay = !!text || pending > 0;
  return (
    <form
      aria-label="Comment"
      className={
        bare
          ? ""
          : "overflow-hidden rounded-xl border border-border bg-surface focus-within:border-faint-foreground/60"
      }
      onSubmit={(e) => {
        e.preventDefault();
        if (canSay) void comment();
      }}
    >
      {pending > 0 && (
        <p className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-meta text-muted-foreground">
          <icons.comment aria-hidden className="size-3.5" />
          Sends with {pending} pending {pending === 1 ? "comment" : "comments"}
        </p>
      )}
      <textarea
        aria-label="Comment"
        placeholder={pending > 0 ? "Add a summary, optional" : "Leave a comment"}
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
        className="field-sizing-content block max-h-64 min-h-20 w-full resize-none bg-transparent px-3 py-2.5 text-body placeholder:text-faint-foreground focus-visible:outline-none"
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border px-2 py-2">
        {reviewId && (
          <Button
            size="sm"
            className="mr-auto"
            disabled={!!sending}
            onClick={() => discard.current?.showModal()}
          >
            <icons.delete aria-hidden />
            Discard
          </Button>
        )}
        {open && (
          <>
            <Button
              size="sm"
              disabled={!canSay || !!sending}
              onClick={() => void review("changes", "requestChanges")}
            >
              <icons.error aria-hidden />
              {sending === "changes" ? "Sending…" : "Request changes"}
            </Button>
            <Button
              size="sm"
              disabled={!!sending}
              onClick={() => void review("approve", "approve")}
            >
              <icons.success aria-hidden />
              {sending === "approve" ? "Sending…" : "Approve"}
            </Button>
          </>
        )}
        <Button size="sm" variant="primary" type="submit" disabled={!canSay || !!sending}>
          {sending === "comment" ? "Sending…" : "Comment"}
        </Button>
      </div>
      {reviewId && (
        <ConfirmDialog
          ref={discard}
          title="Discard your pending review?"
          action="Discard review"
          busy={sending === "discard" ? "Discarding…" : undefined}
          onConfirm={() =>
            void send("discard", { kind: "discardReview", reviewId }).then(() =>
              discard.current?.close(),
            )
          }
        >
          {pending === 1 ? "Its one comment goes with it." : `Its ${pending} comments go with it.`}{" "}
          This can't be undone.
        </ConfirmDialog>
      )}
    </form>
  );
}

/** The Files bar's button for the form: a count of what's pending, once anything is. */
export function ReviewButton({ pending, popover }: { pending: number; popover: string }) {
  return (
    <Button
      size="sm"
      variant={pending > 0 ? "primary" : "outline"}
      popoverTarget={popover}
      aria-haspopup="dialog"
    >
      Review
      {pending > 0 && (
        <Badge shape="count" className="bg-primary-foreground/20! text-primary-foreground!">
          {pending}
        </Badge>
      )}
    </Button>
  );
}
