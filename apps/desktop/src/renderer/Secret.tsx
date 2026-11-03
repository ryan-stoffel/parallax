// An agent's request for a secret (`request_secret`, 0063): the private card pinned over the
// composer while it waits, and the line it leaves in the transcript. The value goes from the
// field to plxd's `secret/answer`, which keeps it in the host's keystore, or with `delivery: file`
// in a private file the agent's commands can read (0098). It is never kept in the window's state,
// the transcript, or the log. A pasted or dropped file's value waits in the field, and the state
// holds only what the card shows of it: a name, a line count, and any variable names.
import { TraceIcon, TraceLine, TraceTitle } from "./Trace";
import { FileText, KeyRound, Paperclip, X } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";

import { quietButton } from "./Approval";
import { describeError } from "./errors";
import { notify } from "./notifications";
import type { Item } from "./transcript";
import { IconButton } from "./ui";

type SecretItem = Extract<Item, { kind: "secret" }>;

const fieldClass =
  "w-full rounded-md border border-border bg-background px-2.5 font-mono text-body placeholder:font-sans placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50";

const saveButton =
  "h-7 shrink-0 rounded-md bg-send px-3 text-body font-medium text-send-foreground enabled:hover:opacity-90 disabled:opacity-50";

/** plxd's limit on an answer (`MAX_SECRET_BYTES`). */
const maxSecretBytes = 64 * 1024;

/** A file or a multi-line paste waiting in the field, as the card shows it. */
interface Loaded {
  title: string;
  detail: string;
  variables: string[];
}

// A name, then an empty value, a value quoted whole, or an unquoted one with no quotes in it.
const envLine = /^(?:export )?([A-Za-z_]\w*)=(|"[^"]*"|'[^']*'|[^\s"'=][^"']*)$/;

/**
 * The names of the variables with values in `value`, when the whole of it reads as an env file:
 * two or more of them, and otherwise only empty variables, blank lines, and comments. Otherwise
 * none, so a password, a token with `=` padding, or a quoted value spanning lines shows nothing.
 */
export function envNames(value: string): string[] {
  const lines = value.split(/\r?\n/);
  const matches = lines.map((line) => envLine.exec(line));
  const names = matches.flatMap((match) => (match?.[2] && match[1] ? [match[1]] : []));
  const isEnv =
    names.length >= 2 &&
    lines.every((line, index) => !line.trim() || line.startsWith("#") || matches[index]);
  return isEnv ? names : [];
}

/**
 * The oldest secret request of run `runId` still waiting, as a card with a password field, or for
 * a file a masked field that keeps the newlines of a pasted `.env`, which a password field drops.
 * A file, picked or dropped, or a multi-line paste shows as a summary, listing an env file's
 * variables with their values hidden.
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
  const [loaded, setLoaded] = useState<Loaded>();
  const [dropOver, setDropOver] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const saveControl = useRef<HTMLButtonElement>(null);

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

  /** Puts `text` in the field and shows its summary, with Save focused so Enter still saves. */
  function load(text: string, fileName?: string) {
    if (field.current) field.current.value = text;
    const variables = envNames(text);
    const count = variables.length || text.trimEnd().split("\n").length;
    const noun = variables.length ? "variable" : "line";
    setLoaded({
      title: fileName ?? (variables.length ? "Pasted env file" : "Pasted text"),
      detail: `${count} ${noun}${count === 1 ? "" : "s"}`,
      variables,
    });
    saveControl.current?.focus();
  }

  function unload() {
    if (field.current) field.current.value = "";
    flushSync(() => setLoaded(undefined));
    field.current?.focus();
  }

  async function loadFile(file: File) {
    const refuse = (body: string) =>
      notify({ tone: "error", title: `Couldn't use ${file.name}`, body });
    if (file.size > maxSecretBytes) return refuse("A secret can be up to 64 KB.");
    let text;
    try {
      text = await file.text();
    } catch {
      return refuse("It couldn't be read.");
    }
    // A binary file wouldn't survive being read as text.
    if (!text.trim() || text.includes("\0") || text.includes("\uFFFD"))
      return refuse("Use a text file with something in it.");
    load(text, file.name);
  }

  function pasteLines(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData("text");
    if (!text.trimEnd().includes("\n")) return;
    event.preventDefault();
    load(text);
  }

  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!toFile || off || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropOver(true);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    setDropOver(false);
    const file = event.dataTransfer.files[0];
    if (!toFile || off || !file) return;
    event.preventDefault();
    void loadFile(file);
  }

  return (
    <section aria-labelledby={titleId} className="mb-3">
      <form
        onSubmit={save}
        onDragOver={dragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropOver(false);
        }}
        onDrop={drop}
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
            <>
              {loaded && (
                <div
                  className={`rounded-md border bg-background ${dropOver ? "border-ring" : "border-border"}`}
                >
                  <div className="flex h-8 items-center gap-2 pr-1 pl-2.5 text-body">
                    <FileText aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
                    <span className="min-w-0 truncate">{loaded.title}</span>
                    <span className="shrink-0 text-meta text-muted-foreground">
                      {loaded.detail}
                    </span>
                    <IconButton
                      label="Remove"
                      size="sm"
                      disabled={off}
                      onClick={unload}
                      className="ml-auto"
                    >
                      <X />
                    </IconButton>
                  </div>
                  {loaded.variables.length > 0 && (
                    <ul
                      aria-label="Variables"
                      className="max-h-40 overflow-y-auto border-t border-border py-1 font-mono text-body"
                    >
                      {loaded.variables.map((name, index) => (
                        <li
                          key={index}
                          className="flex items-center justify-between gap-4 px-2.5 py-0.5"
                        >
                          <span className="min-w-0 truncate">{name}</span>
                          <span aria-hidden className="shrink-0 text-faint-foreground">
                            ••••••••
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className={`relative ${loaded ? "hidden" : ""}`}>
                <textarea
                  ref={field}
                  id={inputId}
                  name="secret"
                  rows={1}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={off}
                  onKeyDown={enterSaves}
                  onPaste={pasteLines}
                  placeholder={request.placeholder ?? "Paste the secret, or drop a file"}
                  className={`${fieldClass} ${dropOver ? "border-ring" : ""} block field-sizing-content max-h-40 min-h-8 resize-none py-1.5 pr-9 [-webkit-text-security:disc]`}
                />
                <IconButton
                  label="Attach a file"
                  size="sm"
                  disabled={off}
                  onClick={() => filePicker.current?.click()}
                  className="absolute top-1 right-1"
                >
                  <Paperclip />
                </IconButton>
                <input
                  ref={filePicker}
                  type="file"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void loadFile(file);
                    event.target.value = "";
                  }}
                />
              </div>
            </>
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
          <button
            ref={saveControl}
            type="submit"
            disabled={off}
            title={disabledReason}
            className={saveButton}
          >
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
