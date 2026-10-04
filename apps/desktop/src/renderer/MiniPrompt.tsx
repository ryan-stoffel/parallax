import { ArrowUp, Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { changeMessage } from "./MemoryPanel";
import { useCatalog, type Model } from "./models";
import { kindOf, logoOf } from "./providers";
import { uuidv7 } from "./uuidv7";

/**
 * The prompt box in miniature, for changing a Project's knowledge in plain words ("we moved off
 * Jest, use Vitest"): a box and Send, with only the model tucked under it. It sends the change to
 * the coordinator, whose rewrite comes back as a proposal (0044), on the model picked, which the
 * coordinator then keeps (`sendModel`). `large` is the full-screen Knowledge view's, wider and
 * taller. Off until the Project has a coordinator.
 */
export function MiniPrompt({
  hostId,
  coordinator,
  large,
}: {
  hostId: string;
  coordinator?: AgentRun;
  large?: boolean;
}) {
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const sendModel = connected && "sendModel" in connection.capabilities;
  const catalog = useCatalog(hostId);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string }>();
  const [picked, setPicked] = useState<Model>();
  const box = useRef<HTMLTextAreaElement>(null);
  // Only the coordinator's own provider: moving it to another is the chat's job.
  const instance = catalog.instances.find((i) => i.id === coordinator?.backend);
  const Logo = instance ? logoOf(instance) : kindOf(coordinator?.backend ?? "claude").Logo;
  const own = catalog.models.filter((m) => m.provider === coordinator?.backend);
  const model =
    (picked && own.find((m) => m.id === picked.id)) ??
    own.find((m) => m.id === coordinator?.model) ??
    own[0];
  const off = !coordinator || !connected;
  const canSend = !off && !busy && text.trim() !== "";

  const send = async () => {
    if (!canSend || !coordinator) return;
    setBusy(true);
    setNote(undefined);
    const answer = await window.parallax.request(hostId, "agent/send", {
      runId: coordinator.id,
      turnId: uuidv7(),
      text: changeMessage(text.trim()),
      ...(sendModel && model && model.id !== coordinator.model && { model: model.id }),
    });
    setBusy(false);
    if ("error" in answer) return setNote({ error: true, text: describeError(answer.error) });
    setText("");
    setNote({ error: false, text: "Sent. The coordinator's rewrite shows up as a proposal." });
    box.current?.focus();
  };

  return (
    <div className={large ? "mx-auto w-full max-w-2xl px-6 pb-6" : "px-3 pb-3"}>
      {note && (
        <p
          role={note.error ? "alert" : "status"}
          className={`px-3 pb-1.5 text-[12px] ${note.error ? "text-danger" : "text-muted-foreground"}`}
        >
          {note.text}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className={`relative z-10 flex items-end gap-2 border border-border bg-surface shadow-composer transition-colors focus-within:border-foreground/20 ${large ? "rounded-3xl py-2.5 pr-2.5 pl-5" : "rounded-[1.25rem] py-1.5 pr-1.5 pl-3.5"}`}
      >
        <textarea
          ref={box}
          aria-label="Change knowledge"
          placeholder={
            coordinator
              ? large
                ? "Tell the Project what changed, what to remember, or what to forget"
                : "Change what it knows, in plain words"
              : "Start the coordinator to change what it knows"
          }
          rows={large ? 2 : 1}
          value={text}
          disabled={off || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void send();
          }}
          className={`field-sizing-content max-h-40 min-w-0 flex-1 resize-none bg-transparent placeholder:text-faint-foreground focus-visible:outline-none disabled:opacity-60 ${large ? "py-1.5 text-[15px] leading-relaxed" : "py-1 text-[13px] leading-snug"}`}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!canSend}
          className={`grid shrink-0 place-items-center rounded-full bg-send text-send-foreground disabled:opacity-25 ${large ? "size-9" : "size-7"}`}
        >
          {busy ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <ArrowUp className={large ? "size-4.5" : "size-3.5"} />
          )}
        </button>
      </form>
      {model && (
        // Tucked under the box, as the composer's tab is.
        <div
          className={`-mt-4 flex items-center rounded-b-2xl border border-t-0 border-border bg-surface pt-4 pb-0.5 ${large ? "mx-6 px-2" : "mx-4 px-1"}`}
        >
          <ModelPick models={own} value={model} onChange={setPicked} Logo={Logo} />
        </div>
      )}
    </div>
  );
}

/**
 * A small model picker for a small box: the model's name, opening a short list of the provider's
 * models above it, the chosen one checked. No search or provider rail: there are a few.
 */
function ModelPick({
  models,
  value,
  onChange,
  Logo,
}: {
  models: readonly Model[];
  value: Model;
  onChange: (model: Model) => void;
  Logo?: ReturnType<typeof logoOf>;
}) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="listbox"
        aria-label={`Model: ${value.name}`}
        className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3"
      >
        {Logo && <Logo aria-hidden />}
        {value.name.replace(/^Claude /, "")}
        <ChevronDown aria-hidden className="text-faint-foreground" />
      </button>
      <div
        id={id}
        popover="auto"
        role="listbox"
        aria-label="Model"
        className="inset-auto m-0 mb-1.5 w-52 rounded-xl border border-border bg-surface p-1 text-foreground shadow-composer [position-area:top_span-right] [position-try-fallbacks:flip-block]"
      >
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={m.id === value.id}
            onClick={() => {
              onChange(m);
              document.getElementById(id)?.hidePopover();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-hover"
          >
            <span className="min-w-0 flex-1 truncate">{m.name}</span>
            {m.isNew && (
              <span className="font-mono text-[10px] tracking-wide text-accent uppercase">new</span>
            )}
            {m.id === value.id && <Check aria-hidden className="size-3.5 text-accent" />}
          </button>
        ))}
      </div>
    </>
  );
}
