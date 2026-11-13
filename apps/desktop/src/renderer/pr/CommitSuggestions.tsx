import { t } from "i18next";
import { useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../ui";

/**
 * Asks for the commit message for `commentIds`' suggestions, GitHub's default filled in, and commits
 * them. Open while `commentIds` isn't empty. `onCommit` resolves to whether it worked, and it stays
 * open with the message if not.
 */
export function CommitSuggestions({
  commentIds,
  onCommit,
  onClose,
}: {
  commentIds: readonly string[];
  onCommit: (message: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const count = commentIds.length;
  useEffect(() => {
    if (!count) return dialog.current?.close();
    setMessage(
      count === 1 ? "Apply suggestion from code review" : "Apply suggestions from code review",
    );
    dialog.current?.showModal();
  }, [count]);
  useEffect(() => {
    const el = dialog.current;
    el?.addEventListener("close", onClose);
    return () => el?.removeEventListener("close", onClose);
  }, [onClose]);
  return (
    <ConfirmDialog
      ref={dialog}
      title={
        count === 1
          ? t("Commit suggestion")
          : t("Commit {{count}} suggestions", {
              count,
              defaultValue_one: "Commit {{count}} suggestion",
            })
      }
      action={t("Commit changes")}
      safe
      busy={busy ? t("Committing…") : undefined}
      onConfirm={() => {
        if (!message.trim()) return;
        setBusy(true);
        void onCommit(message.trim()).then((ok) => {
          setBusy(false);
          if (ok) dialog.current?.close();
        });
      }}
    >
      <textarea
        aria-label={t("Commit message")}
        value={message}
        rows={2}
        onChange={(e) => setMessage(e.target.value)}
        className="field-sizing-content mt-2 max-h-40 min-h-16 w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-body focus-visible:outline-2 focus-visible:outline-ring"
      />
    </ConfirmDialog>
  );
}
