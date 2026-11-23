import { t } from "i18next";
import { useEffect, useId, useRef, useState } from "react";

import {
  ALREADY_SHARED,
  guestLinksOf,
  HOSTED_OFF,
  readGuestLinks,
  setGuestLinks,
  useGuestLinks,
} from "./guestLinks";
import { primaryButton, quietButton } from "./settings/parts";
import { Checkbox, Dialog } from "./ui";

/** A time as the dialog says it, with its date. */
const when = (at: string) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Share with guest (0108), a modal dialog open while it's mounted: a link that shows one thread to
 * one browser for 24 hours. It says what a guest sees before anything is made. Until plxd has said
 * whether the thread has a live link, and whether its `hostedClient` is on, it offers nothing: a
 * new link ends a live one, and none can be made with the switch off, which it says. With no live
 * link it offers "can suggest messages", off, and Create link. With one, it shows when it expires
 * and whether and when it was opened, Copy link, and Stop sharing. Done or Cancel has the focus,
 * so Enter never ends a link.
 *
 * The link's secret never reaches this window. Main keeps it from Create link until Copy link
 * puts it on the clipboard, or until this closes, and nothing can show it again.
 */
export function ShareWithGuest({
  hostId,
  runId,
  onClose,
}: {
  /** The thread's host and run. */
  hostId: string;
  runId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { links, read } = useGuestLinks(hostId, true);
  const link = links.find((each) => each.threadId === runId);
  // The computer's `hostedClient`, once it answers.
  const [hosted, setHosted] = useState<boolean>();
  const [canSuggest, setCanSuggest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The link made here whose secret main still holds, and whether it was just copied.
  const [ready, setReady] = useState<string>();
  const [copied, setCopied] = useState(false);
  const made = useRef<string>(undefined);
  useEffect(() => {
    dialog.current?.showModal();
    done.current?.focus();
    void window.parallax.request(hostId, "host/settings/get", {}).then((answer) => {
      // A plxd that makes guest links has the switch. One that can't say counts as on, and plxd
      // refuses Create link itself if it isn't.
      setHosted("result" in answer ? answer.result.hostedClient !== false : true);
    });
    return () => {
      if (made.current) void window.parallax.forgetGuestLink(made.current);
    };
  }, [hostId]);

  const create = async () => {
    setBusy(true);
    setError(undefined);
    // A new link ends the thread's live one, so one made elsewhere since the last read is shown
    // here, not replaced.
    await readGuestLinks(hostId);
    if (guestLinksOf(hostId).links.some((each) => each.threadId === runId)) {
      setBusy(false);
      return setError(t(ALREADY_SHARED));
    }
    const answer = await window.parallax.shareWithGuest(hostId, runId, canSuggest);
    setBusy(false);
    if (typeof answer === "string") return setError(answer);
    made.current = answer.id;
    setReady(answer.id);
    setCopied(false);
    await readGuestLinks(hostId);
  };
  const copy = async () => {
    if (!ready) return;
    made.current = undefined;
    setReady(undefined);
    setCopied(await window.parallax.copyGuestLink(ready));
  };
  const stop = async () => {
    if (!link) return;
    setBusy(true);
    setError(undefined);
    const answer = await window.parallax.request(hostId, "guest/revoke", { link: link.id });
    setBusy(false);
    if ("error" in answer) return setError(answer.error.message);
    void window.parallax.forgetGuestLink(link.id);
    made.current = undefined;
    setReady(undefined);
    setCopied(false);
    setGuestLinks(hostId, answer.result);
  };
  const canCopy = !!link && ready === link.id;
  const known = read && hosted !== undefined;

  return (
    <Dialog ref={dialog} width="sm" aria-labelledby={titleId} onClose={onClose}>
      <form method="dialog" className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div>
          <h2 id={titleId} className="text-reading font-semibold">
            {t("Share with guest")}
          </h2>
          <p className="mt-1.5 text-body text-muted-foreground">
            {t(
              "A guest sees everything in this thread's transcript, including what the agent read or printed. The link works in one browser, for 24 hours.",
            )}
          </p>
        </div>
        {!known ? null : link ? (
          <>
            <dl className="rounded-lg border border-border px-3 py-2 text-body">
              <div className="flex justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">{t("Expires")}</dt>
                <dd>{when(link.expiresAt)}</dd>
              </div>
              <div className="flex justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">{t("Opened")}</dt>
                <dd>{link.boundAt ? when(link.boundAt) : t("Not yet")}</dd>
              </div>
              {link.canSuggest && (
                <div className="py-0.5 text-muted-foreground">
                  {t("Guest can suggest messages")}
                </div>
              )}
            </dl>
            <p role="status" className="text-meta text-muted-foreground">
              {canCopy
                ? t("Copy the link now. Parallax doesn't keep it, and closing this forgets it.")
                : t(
                    "Parallax doesn't keep the link. To get one again, stop sharing and create a new one.",
                  )}
            </p>
          </>
        ) : hosted ? (
          <div>
            <Checkbox checked={canSuggest} onChange={setCanSuggest}>
              {t("Guest can suggest messages")}
            </Checkbox>
            <p className="mt-1 pl-6 text-meta text-muted-foreground">
              {t("A suggested message waits in the thread until you send or dismiss it.")}
            </p>
          </div>
        ) : (
          <p role="status" className="text-body text-warning">
            {t(HOSTED_OFF)}
          </p>
        )}
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {known && link && (
            <button
              type="button"
              className={`${quietButton} mr-auto -ml-2.5`}
              disabled={busy}
              onClick={() => void stop()}
            >
              {t("Stop sharing")}
            </button>
          )}
          <button ref={done} type="submit" className={quietButton}>
            {known && link ? t("Done") : t("Cancel")}
          </button>
          {!known ? null : link ? (
            (canCopy || copied) && (
              <button
                type="button"
                className={primaryButton}
                disabled={!canCopy}
                onClick={() => void copy()}
              >
                {copied ? t("Copied") : t("Copy link")}
              </button>
            )
          ) : (
            <button
              type="button"
              className={primaryButton}
              disabled={busy || !hosted}
              onClick={() => void create()}
            >
              {t("Create link")}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
