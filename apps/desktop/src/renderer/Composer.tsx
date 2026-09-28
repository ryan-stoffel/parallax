import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useState, type ReactNode } from "react";

export interface ComposerProps {
  hero?: boolean;
  /** Whether it starts a new thread, which only changes its hint. */
  newThread?: boolean;
  /**
   * Sends the text. Resolves to an error message, which puts the text back; `""` puts it back
   * with no message. Absent: Send stays off.
   */
  onSend?: (text: string) => Promise<string | undefined>;
  /**
   * While set, an empty box shows Stop instead of Send. Resolves to an error message.
   * Stop stays pending until the caller drops `onStop`, when the run stops.
   */
  onStop?: () => Promise<string | undefined>;
  /** Why sending is off right now, shown in place of the box's hint. */
  disabledReason?: string;
  /** What goes under the box: an open run's footer, or a new thread's repository picker. */
  footer?: ReactNode;
}

/** The prompt box. Enter sends and Shift+Enter starts a new line. */
export function Composer({
  hero = false,
  newThread,
  onSend,
  onStop,
  disabledReason,
  footer,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  // The run stopped (or never ran), so a later run's Stop starts fresh.
  if (stopping && !onStop) setStopping(false);
  const canSend = !!onSend && !disabledReason && text.trim() !== "";
  const showStop = !!onStop && !disabledReason && text.trim() === "";

  const submit = async () => {
    if (!canSend) return;
    setText("");
    setError(undefined);
    const failed = await onSend(text);
    if (failed !== undefined) {
      // Put it back ahead of anything typed while it was in flight.
      setText((typed) => (typed ? `${text}\n\n${typed}` : text));
      setError(failed);
    }
  };

  const stop = async () => {
    setStopping(true);
    setError(undefined);
    const failed = await onStop?.();
    if (failed) {
      setStopping(false);
      setError(failed);
    }
  };

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-2xl border border-border bg-surface shadow-composer focus-within:border-ring/50"
      >
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          id="composer-input"
          rows={hero ? 3 : 2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }}
          placeholder={
            disabledReason ??
            (newThread ? "Ask for a change, or describe a task" : "Send a message")
          }
          className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-relaxed placeholder:text-faint-foreground focus-visible:outline-none"
        />
        <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
          {showStop ? (
            <button
              type="button"
              aria-label={stopping ? "Stopping" : "Stop"}
              disabled={stopping}
              onClick={() => void stop()}
              className="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
            >
              {stopping ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!canSend}
              className="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-25"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="px-2 pt-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {footer}
    </div>
  );
}
