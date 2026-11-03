// An agent's request for a secret (`request_secret`, 0063): the private card pinned over the
// composer while it waits, and the line it leaves in the transcript. The value goes from the
// field to plxd's `secret/answer`, which keeps it in the host's keystore, or with `delivery: file`
// in a private file the agent's commands can read (0098). It is never kept in the window's state,
// the transcript, or the log: the state holds only `maskedLines`, its dots and any variable names.
import { TraceIcon, TraceLine, TraceTitle } from "./Trace";
import { KeyRound } from "lucide-react";
import {
  Fragment,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import { quietButton } from "./Approval";
import { describeError } from "./errors";
import { notify } from "./notifications";
import type { Item } from "./transcript";

type SecretItem = Extract<Item, { kind: "secret" }>;

const fieldClass =
  "w-full rounded-md border border-border bg-background px-2.5 font-mono text-body placeholder:font-sans placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50";

/** What the file field and the mask over it share, so each masked character sits on its own. */
const fileFieldText =
  "whitespace-pre-wrap break-all border px-2.5 py-1.5 font-mono text-body [scrollbar-gutter:stable]";

const saveButton =
  "h-7 shrink-0 rounded-md bg-send px-3 text-body font-medium text-send-foreground enabled:hover:opacity-90 disabled:opacity-50";

/** A line of a masked value: the part safe to show, then a dot for each other character. */
interface MaskedLine {
  name: string;
  dots: string;
}

const envAssignment = /^(?:export )?[A-Za-z_][A-Za-z0-9_]*=(?!=)/;

/**
 * Masks `value` a line at a time, keeping each `NAME=` only when the whole value reads as an env
 * file: two or more assignments, and otherwise only blank lines and comments. A password, a token
 * with `=` padding, or a private key then stays fully masked. Comments are masked, since they can
 * hold an old value.
 */
export function maskedLines(value: string): MaskedLine[] {
  const lines = value.split("\n").map((line) => line.replace(/\r$/, ""));
  const assignments = lines.filter((line) => envAssignment.test(line)).length;
  const isEnv =
    assignments >= 2 &&
    lines.every((line) => !line.trim() || line.startsWith("#") || envAssignment.test(line));
  return lines.map((line) => {
    const name = (isEnv && envAssignment.exec(line)?.[0]) || "";
    return { name, dots: "•".repeat(Array.from(line.slice(name.length)).length) };
  });
}

/**
 * The oldest secret request of run `runId` still waiting, as a card with a password field, or for
 * a file a masked field that keeps the newlines of a pasted `.env`, which a password field drops.
 * The file field's own text is invisible, and `maskedLines` draws over it character for character.
 */
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
  const off = !!disabledReason || !!busy;
  const toFile = request.delivery === "file";
  const [masked, setMasked] = useState<MaskedLine[]>([]);
  const mask = useRef<HTMLDivElement>(null);

  async function send(answer: { type: "save"; secret: string } | { type: "decline" }) {
    setBusy(answer.type);
    const reply = await window.parallax.request(hostId, "secret/answer", {
      runId,
      requestId: request.requestId,
      answer,
    });
    // On success the card goes once plxd logs the answer.
    if ("error" in reply) {
      notify({
        tone: "error",
        title: answer.type === "save" ? "Couldn't save the secret" : "Couldn't decline the secret",
        body: describeError(reply.error),
      });
      setBusy(undefined);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("secret") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const value = field?.value ?? "";
    if (!value.trim()) return;
    void send({ type: "save", secret: value });
  }

  function enterSaves(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function scrollMask(event: UIEvent<HTMLTextAreaElement>) {
    if (mask.current) mask.current.scrollTop = event.currentTarget.scrollTop;
  }

  return (
    <section aria-labelledby={titleId} className="mb-3">
      <form
        onSubmit={save}
        autoComplete="off"
        className="flex flex-col rounded-xl border border-border bg-surface"
      >
        <div className="flex items-center gap-2 px-4 pt-3 text-body">
          <KeyRound aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
          <span id={titleId} className="min-w-0 truncate font-medium">
            {request.label}
          </span>
          <span className="ml-auto shrink-0 pl-2 text-meta text-muted-foreground">
            The agent asks for a secret
          </span>
        </div>
        <p className="px-4 pt-1.5 text-body leading-relaxed text-muted-foreground">
          {request.reason}
        </p>
        <div className="px-4 pt-2.5">
          <label htmlFor={inputId} className="sr-only">
            {request.label}
          </label>
          {toFile ? (
            <div className="relative">
              <div
                ref={mask}
                aria-hidden
                data-testid="secret-mask"
                className={`${fileFieldText} absolute inset-0 overflow-hidden rounded-md border-transparent bg-background text-muted-foreground`}
              >
                {masked.map((line, index) => (
                  <Fragment key={index}>
                    {index > 0 && "\n"}
                    <span className="text-foreground">{line.name}</span>
                    {line.dots}
                  </Fragment>
                ))}
                {"\n"}
              </div>
              <textarea
                id={inputId}
                name="secret"
                rows={1}
                autoComplete="off"
                spellCheck={false}
                disabled={off}
                onInput={(event) => setMasked(maskedLines(event.currentTarget.value))}
                onKeyDown={enterSaves}
                onScroll={scrollMask}
                placeholder={request.placeholder ?? "Paste the secret"}
                className={`${fieldClass} ${fileFieldText} relative block field-sizing-content max-h-48 min-h-8 resize-none bg-transparent text-transparent caret-foreground [-webkit-text-security:disc]`}
              />
            </div>
          ) : (
            <input
              id={inputId}
              name="secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={off}
              placeholder={request.placeholder ?? "Paste the secret"}
              className={`${fieldClass} h-8`}
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-3">
          <p className="mr-auto text-meta text-faint-foreground">
            {toFile
              ? "Kept out of chat, in a private file this agent's commands can read for 24 hours."
              : "Kept in this host's keychain. The agent gets a one-time reference, never the value."}
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
    <TraceLine>
      <TraceIcon>
        <KeyRound />
      </TraceIcon>
      <TraceTitle className="shrink-0">
        {secret.status ? (outcomes[secret.status] ?? "Ended") : "Waiting for you"}
      </TraceTitle>
      <span className="truncate text-faint-foreground">{secret.request.label}</span>
    </TraceLine>
  );
}
