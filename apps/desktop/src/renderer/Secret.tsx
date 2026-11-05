// An agent's request for a secret (`request_secret`, 0063): the private card pinned over the
// composer while it waits, and the line it leaves in the transcript. The value goes from the
// field to plxd's `secret/answer`, which keeps it in the host's keystore, or with `delivery: file`
// in a private file the agent's commands can read (0098). It is never kept in the window's state,
// the transcript, or the log. The request's `input` picks the view (0099): one masked field, an
// env file's editor, or a file picker. The editor's value waits in its field, and `paintSecret`
// draws it into the DOM beside the field, masked until the user shows it, without going through
// state. A picked file's contents are read only when the user saves.
import { TraceIcon, TraceLine, TraceTitle } from "./Trace";
import { Eye, EyeOff, FileCheck, FileText, FileUp, FolderOpen, KeyRound, Lock } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { approveButton, outlineButton, quietButton } from "./Approval";
import { describeError } from "./errors";
import { notify } from "./notifications";
import { acceptsFile, maxSecretBytes, secretInput, type Item } from "./transcript";
import { IconButton } from "./ui";

type SecretItem = Extract<Item, { kind: "secret" }>;

/** The editor's labelled tools, under its text. */
const editorTool =
  "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-meta text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-50 [&_svg]:size-3.5";

// A name, then an empty value, a value quoted whole, or an unquoted one with no quotes in it.
const envLine = /^((?:export )?[A-Za-z_]\w*)=(|"[^"]*"|'[^']*'|[^\s"'=][^"']*)$/;

/**
 * Whether the whole of `value` reads as an env file: two or more variables with values, and
 * otherwise only empty variables, blank lines, and comments. Only then does a masked value show
 * its names, so a password, a token with `=` padding, or a quoted value spanning lines shows none.
 */
export function isEnvFile(value: string): boolean {
  const lines = value.split(/\r?\n/);
  const matches = lines.map((line) => envLine.exec(line));
  return (
    matches.filter((match) => match?.[2]).length >= 2 &&
    lines.every((line, index) => !line.trim() || line.startsWith("#") || matches[index])
  );
}

function painted(className: string, text: string) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

const masked = (text: string) => "•".repeat(Array.from(text).length);

/** Draws one line of a value, colored as an env file's, with a dot per character it hides. */
function paintLine(line: string, env: boolean, shown: boolean): Node[] {
  const dots = "text-faint-foreground";
  if (line.startsWith("#"))
    return [painted(shown ? "text-[var(--syntax-comment)]" : dots, shown ? line : masked(line))];
  const assignment = envLine.exec(line);
  const [, name = "", value = ""] = assignment ?? [];
  if (assignment && (shown || (env && value)))
    return [
      painted("text-[var(--syntax-title)]", name),
      painted("text-muted-foreground", "="),
      painted(shown ? "text-[var(--syntax-string)]" : dots, shown ? value : masked(value)),
    ];
  return [painted(shown ? "" : dots, shown ? line : masked(line))];
}

/**
 * Draws `value` into `target` under the editor's invisible text, character for character so the
 * caret stays in place: all dots, or for an env file its names and dots, until it's `shown`.
 */
export function paintSecret(target: HTMLElement, value: string, shown: boolean) {
  const env = isEnvFile(value);
  const lines = value
    .split("\n")
    .flatMap((line, index) => [...(index ? ["\n"] : []), ...paintLine(line, env, shown)]);
  target.replaceChildren(...lines, "\n");
}

/**
 * The oldest secret request of run `runId` still waiting, as a card with the input it asks for: a
 * password field for one value, a small editor for an env file, which keeps the newlines a password
 * field drops and masks its values until the user shows them, or a file picker that also takes a
 * drop, whose file goes byte for byte. The editor also takes a picked or dropped text file.
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
  const input = secretInput(request);
  const takesFiles = input === "env" || input === "file";
  // A handle: the contents stay on disk until Save.
  const [picked, setPicked] = useState<File>();
  const [fileName, setFileName] = useState<string>();
  const [lineCount, setLineCount] = useState(1);
  const [shown, setShown] = useState(false);
  // Whether there's anything to save: never the value itself.
  const [filled, setFilled] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const paint = useRef<HTMLDivElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  // Only the editor has a textarea, and the single field keeps `filled` itself.
  function repaint() {
    if (!field.current) return;
    const { value } = field.current;
    if (paint.current) paintSecret(paint.current, value, shown);
    setLineCount(value.split("\n").length);
    setFilled(!!value.trim());
  }
  useLayoutEffect(repaint, [shown]);

  async function send(
    answer:
      | { type: "save"; secret: string }
      | { type: "saveBytes"; base64: string }
      | { type: "decline" },
  ) {
    const saving = answer.type !== "decline";
    setBusy(saving ? "save" : "decline");
    const reply = await window.parallax.request(hostId, "secret/answer", {
      runId,
      requestId: request.requestId,
      answer,
    });
    // On success the card goes once plxd logs the answer.
    if ("error" in reply) {
      notify({
        tone: "error",
        title: saving ? "Couldn't save the secret" : "Couldn't decline the secret",
        body: describeError(reply.error),
      });
      setBusy(undefined);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (input === "file") {
      if (picked) void savePicked(picked);
      return;
    }
    const field = event.currentTarget.elements.namedItem("secret") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const value = field?.value ?? "";
    if (!value.trim()) return;
    void send({ type: "save", secret: value });
  }

  /** Sends file `file`'s bytes, which can be binary, such as a .p12's. */
  async function savePicked(file: File) {
    setBusy("save");
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      notify({ tone: "error", title: `Couldn't use ${file.name}`, body: "It couldn't be read." });
      setBusy(undefined);
      return;
    }
    await send({ type: "saveBytes", base64: btoa(String.fromCharCode(...bytes)) });
  }

  /** Takes `file` for a `file` input, if it's what the request asks for. */
  function pick(file: File) {
    const refuse = (body: string) =>
      notify({ tone: "error", title: `Couldn't use ${file.name}`, body });
    if (!acceptsFile(file.name, request.accept)) return refuse(`Choose ${wanted}.`);
    if (!file.size) return refuse("It's empty.");
    if (file.size > maxSecretBytes) return refuse("A secret can be up to 64 KB.");
    setPicked(file);
  }

  // Enter makes a new line, as in any editor.
  function commandEnterSaves(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  async function loadFile(file: File) {
    const refuse = (body: string) =>
      notify({ tone: "error", title: `Couldn't use ${file.name}`, body });
    if (file.size > maxSecretBytes) return refuse("A secret can be up to 64 KB.");
    let text;
    try {
      // This drops a leading BOM, which would otherwise break the first variable for shells and dotenv.
      text = await file.text();
    } catch {
      return refuse("It couldn't be read.");
    }
    // A binary file wouldn't survive being read as text.
    if (!text.trim() || text.includes("\0") || text.includes("\uFFFD"))
      return refuse("Use a text file with something in it.");
    if (field.current) field.current.value = text;
    setFileName(file.name);
    repaint();
    field.current?.focus();
  }

  function dragOver(event: DragEvent<HTMLFormElement>) {
    if (!takesFiles || off || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropOver(true);
  }

  function drop(event: DragEvent<HTMLFormElement>) {
    setDropOver(false);
    const file = event.dataTransfer.files[0];
    if (!takesFiles || off || !file) return;
    event.preventDefault();
    if (input === "file") pick(file);
    else void loadFile(file);
  }

  const wanted = request.accept?.length ? `a ${request.accept.join(" or ")} file` : "a file";
  const picker = (
    <input
      ref={filePicker}
      type="file"
      hidden
      accept={input === "file" ? request.accept?.join(",") : undefined}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) {
          if (input === "file") pick(file);
          else void loadFile(file);
        }
        event.target.value = "";
      }}
    />
  );

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
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20 ring-inset"
          >
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0 flex-1 pt-px">
            <p id={titleId} className="text-body font-medium break-words">
              {request.label}
            </p>
            <p className="mt-0.5 text-body leading-relaxed text-muted-foreground">
              {request.reason}
            </p>
          </div>
        </div>
        <div className="px-4 pt-3">
          {input !== "file" && (
            <label htmlFor={inputId} className="sr-only">
              {request.label}
            </label>
          )}
          {input === "file" ? (
            <>
              <button
                type="button"
                disabled={off}
                onClick={() => filePicker.current?.click()}
                className={`flex w-full items-center gap-3 rounded-lg border bg-code p-3 text-left transition-colors disabled:opacity-50 ${dropOver ? "border-ring bg-accent/5" : picked ? "border-border enabled:hover:border-foreground/20" : "border-dashed border-foreground/20 enabled:hover:border-foreground/40"}`}
              >
                <span
                  aria-hidden
                  className={`grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-4 ${picked ? "bg-accent/10 text-accent" : "bg-hover text-muted-foreground"}`}
                >
                  {picked ? <FileCheck /> : <FileUp />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium">
                    {dropOver ? "Drop to use this file" : (picked?.name ?? `Drop ${wanted} here`)}
                  </span>
                  <span className="block text-meta text-muted-foreground">
                    {picked ? "Ready to save" : "Up to 64 KB"}
                  </span>
                </span>
                <span className={`${outlineButton} flex items-center`}>
                  {picked ? "Replace" : "Choose file"}
                </span>
              </button>
              {picker}
            </>
          ) : input === "env" ? (
            <div
              className={`overflow-hidden rounded-lg border bg-code focus-within:border-ring ${dropOver ? "border-ring" : "border-border"}`}
            >
              <div className="flex max-h-64 min-h-32 overflow-auto font-mono text-body">
                <div
                  aria-hidden
                  className="sticky left-0 z-10 shrink-0 bg-code py-2 pr-3 pl-3 text-right text-faint-foreground select-none"
                >
                  {Array.from({ length: lineCount }, (_, index) => (
                    <div key={index}>{index + 1}</div>
                  ))}
                </div>
                <div className="grid min-w-fit flex-1">
                  <div
                    ref={paint}
                    aria-hidden
                    data-testid="secret-paint"
                    className="[grid-area:1/1] py-2 pr-3 whitespace-pre"
                  />
                  <textarea
                    ref={field}
                    id={inputId}
                    name="secret"
                    wrap="off"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={off}
                    onInput={repaint}
                    onKeyDown={commandEnterSaves}
                    placeholder={request.placeholder ?? "Paste your .env, or drop the file here"}
                    className={`relative block field-sizing-content min-w-full resize-none overflow-hidden bg-transparent py-2 pr-3 whitespace-pre text-transparent caret-foreground [grid-area:1/1] placeholder:font-sans placeholder:text-faint-foreground focus-visible:outline-none disabled:opacity-50 ${shown ? "" : "[-webkit-text-security:disc]"}`}
                  />
                </div>
              </div>
              <div className="flex h-8 items-center gap-1 border-t border-border pr-1 pl-3">
                <span className="mr-auto flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
                  {fileName && (
                    <>
                      <FileText aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
                      <span className="truncate">{fileName}</span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  aria-pressed={shown}
                  onClick={() => setShown(!shown)}
                  className={editorTool}
                >
                  {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                  {shown ? "Hide values" : "Show values"}
                </button>
                <button
                  type="button"
                  disabled={off}
                  onClick={() => filePicker.current?.click()}
                  className={editorTool}
                >
                  <FolderOpen aria-hidden />
                  Open a file
                </button>
                {picker}
              </div>
            </div>
          ) : (
            <div className="relative">
              <input
                id={inputId}
                name="secret"
                type={shown ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                disabled={off}
                onInput={(event) => setFilled(!!event.currentTarget.value.trim())}
                placeholder={request.placeholder ?? "Paste the secret"}
                className="h-9 w-full rounded-md border border-border bg-code pr-9 pl-3 font-mono text-body placeholder:font-sans placeholder:text-faint-foreground focus-visible:border-ring focus-visible:outline-none disabled:opacity-50"
              />
              <div className="absolute inset-y-0 right-1 flex items-center">
                <IconButton
                  label={shown ? "Hide the value" : "Show the value"}
                  size="sm"
                  aria-pressed={shown}
                  onClick={() => setShown(!shown)}
                >
                  {shown ? <EyeOff /> : <Eye />}
                </IconButton>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 px-4 pt-3 pb-3">
          <p className="mr-auto flex min-w-0 items-start gap-1.5 text-meta text-muted-foreground">
            <Lock aria-hidden className="mt-0.5 size-3 shrink-0 text-faint-foreground" />
            {request.delivery === "file"
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
            type="submit"
            disabled={off || !(input === "file" ? picked : filled)}
            title={disabledReason}
            className={approveButton}
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
