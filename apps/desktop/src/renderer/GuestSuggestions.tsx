import { t } from "i18next";
import { ArrowUp, X } from "lucide-react";
import { useId, useState } from "react";

import type { GuestLink } from "../protocol/generated/protocol";
import { setGuestLinks } from "./guestLinks";
import { notify } from "./notifications";
import { popoverBeside } from "./ui";

const action =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5";

/**
 * The messages a thread's guest suggested (0108), as a tab over the composer like the queue's.
 * Each waits in plxd until the owner sends it, as their own turn with the thread's permissions, or
 * dismisses it. So each is shown whole, to be read before it's sent. `compact` shows only how many
 * wait, opening the list above itself, for a place beside other tabs.
 */
export function GuestSuggestions({
  hostId,
  link,
  compact,
}: {
  hostId: string;
  link: GuestLink;
  compact?: boolean;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const suggestions = link.suggestions ?? [];

  async function answer(method: "guest/send" | "guest/dismiss", suggestion: string) {
    setBusy(true);
    const done = await window.parallax.request(hostId, method, { link: link.id, suggestion });
    setBusy(false);
    if ("error" in done)
      return notify({
        tone: "error",
        title: t("Couldn't answer the guest's message"),
        body: done.error.message,
      });
    setGuestLinks(hostId, done.result);
  }

  if (!suggestions.length) return null;
  const list = (
    <section aria-label={t("Messages your guest suggested")} className="text-body">
      <div className="py-2 pr-3.5 pl-4 text-faint-foreground">
        {t("From your guest")}{" "}
        <span className="ml-1 rounded-sm bg-hover px-1.5 text-foreground">
          {suggestions.length}
        </span>
      </div>
      <ol className="max-h-48 overflow-y-auto">
        {suggestions.map((s) => (
          <li key={s.id} className="flex items-start gap-1 border-t border-border px-2.5 py-1.5">
            <span className="min-w-0 flex-1 py-0.5 pl-1.5 break-words whitespace-pre-wrap">
              {s.text}
            </span>
            <button
              type="button"
              className={action}
              disabled={busy}
              aria-label={t("Send")}
              title={t("Send")}
              onClick={() => void answer("guest/send", s.id)}
            >
              <ArrowUp aria-hidden />
            </button>
            <button
              type="button"
              className={action}
              disabled={busy}
              aria-label={t("Dismiss")}
              title={t("Dismiss")}
              onClick={() => void answer("guest/dismiss", s.id)}
            >
              <X aria-hidden />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
  if (!compact) return list;
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        title={t("Messages your guest suggested")}
        className="flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        {t("From your guest")}
        <span className="rounded-sm bg-hover px-1.5 text-foreground tabular-nums">
          {suggestions.length}
        </span>
      </button>
      <div
        id={id}
        popover="auto"
        className={`inset-auto m-0 mb-2 overflow-hidden rounded-xl border border-border bg-surface text-foreground shadow-composer [position-try-fallbacks:flip-block] ${popoverBeside}`}
      >
        {list}
      </div>
    </>
  );
}
