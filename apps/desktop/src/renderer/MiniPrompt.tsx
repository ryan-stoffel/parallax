import { ArrowUp, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { changeMessage } from "./MemoryPanel";
import { ModelMenu } from "./ModelMenu";
import { useCatalog, type Model, type Provider } from "./models";
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
  const unavailable: Partial<Record<Provider, string>> = {};
  for (const i of catalog.instances)
    if (i.id !== coordinator?.backend)
      unavailable[i.id] = "The coordinator changes provider from its chat.";
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
          className={`-mt-4 flex items-center rounded-b-2xl border border-t-0 border-border bg-surface pt-4 pb-0.5 ${large ? "mx-6 px-2" : "mx-4 px-1 [&_button]:text-[12px]"}`}
        >
          <ModelMenu
            catalog={catalog}
            unavailable={unavailable}
            value={model}
            onChange={setPicked}
          />
        </div>
      )}
    </div>
  );
}
