// An agent's request for a secret (`request_secret`, 0063): the private card pinned over the
// composer while it waits, and the line it leaves in the transcript. The value goes from the
// password field to plxd's `secret/answer`, which keeps it in the host's keystore. It is never
// kept in the window's state, the transcript, or the log.
import { KeyRound } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { quietButton } from "./Approval";
import { describeError } from "./errors";
import type { Item } from "./transcript";

type SecretItem = Extract<Item, { kind: "secret" }>;

const saveButton =
  "h-7 shrink-0 rounded-md bg-send px-3 text-[12.5px] font-medium text-send-foreground enabled:hover:opacity-90 disabled:opacity-50";

/** The oldest secret request of run `runId` still waiting, as a card with a password field. */
export function SecretCard({
  hostId,
  runId,
  secret,
  disabledReason,
}: {
  hostId: string;
  runId: string;
  secret: SecretItem;
  disabledReason?: string;
}) {
  const { request } = secret;
  const titleId = useId();
  const inputId = useId();
  const [busy, setBusy] = useState<"save" | "decline">();
  const [error, setError] = useState<string>();
  const off = !!disabledReason || !!busy;

  async function send(answer: { type: "save"; secret: string } | { type: "decline" }) {
    setBusy(answer.type);
    setError(undefined);
    const reply = await window.parallax.request(hostId, "secret/answer", {
      runId,
      requestId: request.requestId,
      answer,
    });
    // On success the card goes once plxd logs the answer.
    if ("error" in reply) {
      setError(describeError(reply.error));
      setBusy(undefined);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("secret") as HTMLInputElement | null;
    const value = field?.value ?? "";
    if (!value.trim()) return;
    void send({ type: "save", secret: value });
  }

  return (
    <section aria-labelledby={titleId} className="mb-3">
      <form
        onSubmit={save}
        autoComplete="off"
        className="flex flex-col rounded-xl border border-border bg-surface"
      >
        <div className="flex items-center gap-2 px-4 pt-3 text-[13px]">
          <KeyRound aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
          <span id={titleId} className="min-w-0 truncate font-medium">
            {request.label}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-[12px] text-muted-foreground">
            The agent asks for a secret
          </span>
        </div>
        <p className="px-4 pt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {request.reason}
        </p>
        <div className="px-4 pt-2.5">
          <label htmlFor={inputId} className="sr-only">
            {request.label}
          </label>
          <input
            id={inputId}
            name="secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={off}
            placeholder={request.placeholder ?? "Paste the secret"}
            className="h-8 w-full rounded-md border border-border bg-background px-2.5 font-mono text-[12.5px] placeholder:font-sans placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50"
          />
        </div>
        {error && (
          <p role="alert" className="px-4 pt-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-3">
          <p className="mr-auto text-[12px] text-faint-foreground">
            Kept in this host's keychain. The agent gets a one-time reference, never the value.
          </p>
          <button
            type="button"
            disabled={off}
            title={disabledReason}
            onClick={() => void send({ type: "decline" })}
            className={quietButton}
          >
            {busy === "decline" ? "Declining…" : "Decline"}
          </button>
          <button type="submit" disabled={off} title={disabledReason} className={saveButton}>
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </section>
  );
}

/** How a secret request ended, by its status. */
const outcomes: Record<string, string> = {
  saved: "Saved",
  declined: "Declined",
  cancelled: "Closed",
};

/** A secret request's line in the transcript: what was asked for, and how it ended. */
export function SecretLine({ secret }: { secret: SecretItem }) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
      <KeyRound aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-foreground">
        {secret.status ? (outcomes[secret.status] ?? "Ended") : "Waiting for you"}
      </span>
      <span className="min-w-0 truncate">{secret.request.label}</span>
    </p>
  );
}
