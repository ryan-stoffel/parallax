import { ArrowUp, Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { changeMessage } from "./MemoryPanel";
import { useCatalog, type Instance, type Model } from "./models";
import { kindOf, logoOf } from "./providers";
import { uuidv7 } from "./uuidv7";

/**
 * The prompt box in miniature, for changing a Project's knowledge in plain words ("we moved off
 * Jest, use Vitest"): a box and Send, with only the model tucked under it. It sends the change to
 * the coordinator, whose rewrite comes back as a proposal (0044), on the model picked, which the
 * coordinator then keeps (`sendModel`); one on another provider moves it there (`sendAccount`).
 * `large` is the full-screen Knowledge view's, wider and taller. Off until the Project has a
 * coordinator.
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
  // With `sendAccount`, the coordinator can move to another provider that runs one.
  const moves = sendModel && "sendAccount" in connection.capabilities;
  const catalog = useCatalog(hostId);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string }>();
  const [picked, setPicked] = useState<Model>();
  const box = useRef<HTMLTextAreaElement>(null);
  const providers = catalog.instances.filter(
    (i) =>
      i.enabled &&
      (i.id === coordinator?.backend || (moves && i.coordinator)) &&
      catalog.models.some((m) => m.provider === i.id),
  );
  const offered = catalog.models.filter((m) => providers.some((i) => i.id === m.provider));
  const model =
    (picked && offered.find((m) => m.id === picked.id && m.provider === picked.provider)) ??
    offered.find((m) => m.provider === coordinator?.backend && m.id === coordinator?.model) ??
    offered.find((m) => m.provider === coordinator?.backend);
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
      ...(moves &&
        model &&
        model.provider !== coordinator.backend && {
          account: { kind: "subscription", backend: model.provider } as const,
        }),
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
          <ModelPick providers={providers} models={offered} value={model} onChange={setPicked} />
        </div>
      )}
    </div>
  );
}

/**
 * A small model picker for a small box: the model's provider and name, opening a short card above
 * it with the providers as a row of logos and the chosen one's models under it, the current one
 * checked. No search: there are a few.
 */
function ModelPick({
  providers,
  models,
  value,
  onChange,
}: {
  providers: readonly Instance[];
  models: readonly Model[];
  value: Model;
  onChange: (model: Model) => void;
}) {
  const id = useId();
  const [tab, setTab] = useState(value.provider);
  const logo = (provider: string) => {
    const instance = providers.find((i) => i.id === provider);
    return instance ? logoOf(instance) : kindOf(provider).Logo;
  };
  const Logo = logo(value.provider);
  const list = models.filter((m) => m.provider === tab);
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
        onBeforeToggle={(e) => {
          if (e.newState === "open") setTab(value.provider);
        }}
        className="inset-auto m-0 mb-1.5 w-56 rounded-xl border border-border bg-surface p-1 text-foreground shadow-composer [position-area:top_span-right] [position-try-fallbacks:flip-block]"
      >
        {providers.length > 1 && (
          <div
            role="tablist"
            aria-label="Provider"
            className="mb-1 flex gap-0.5 border-b border-border px-0.5 pb-1"
          >
            {providers.map((p) => {
              const P = logo(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={p.id === tab}
                  title={p.name}
                  onClick={() => setTab(p.id)}
                  className={`grid size-7 place-items-center rounded-lg [&_svg]:size-3.5 ${p.id === tab ? "bg-selected" : "opacity-60 hover:bg-hover hover:opacity-100"}`}
                >
                  {P ? <P aria-hidden /> : p.name.slice(0, 1)}
                  <span className="sr-only">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}
        <div role="listbox" aria-label="Model">
          {list.map((m) => {
            const on = m.id === value.id && m.provider === value.provider;
            return (
              <button
                key={`${m.provider}/${m.id}`}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => {
                  onChange(m);
                  document.getElementById(id)?.hidePopover();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] hover:bg-hover"
              >
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {m.isNew && <span className="text-[11px] text-accent">New</span>}
                {on && <Check aria-hidden className="size-3.5 text-accent" />}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
