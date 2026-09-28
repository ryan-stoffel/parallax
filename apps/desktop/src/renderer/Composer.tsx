import { ArrowUp, GitBranch, Laptop, Server, Square } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ComposerOptions } from "./placeholder";
import { Picker } from "./ui";

export interface ComposerProps {
  hero?: boolean;
  /**
   * A new thread's pickers: model, effort, and permissions in the box, workspace
   * and branch under it. An open run has none, since `agent/send` takes only text.
   */
  newThread?: { localHost: boolean; options: ComposerOptions };
  /** Sends the text. Resolves to an error message, which puts the text back. Absent: Send stays off. */
  onSend?: (text: string) => Promise<string | undefined>;
  /** While set, an empty box shows Stop instead of Send. */
  onStop?: () => void;
  /** Why sending is off right now, shown in place of the box's hint. */
  disabledReason?: string;
  /** What goes under the box for an open run: its footer. */
  footer?: ReactNode;
}

/**
 * The prompt box. Enter sends and Shift+Enter starts a new line. Starting a new
 * thread from it arrives with RYA-15; an open run sends through `onSend`.
 */
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
  const canSend = !!onSend && !disabledReason && text.trim() !== "";
  const showStop = !!onStop && !disabledReason && text.trim() === "";

  const submit = async () => {
    if (!canSend) return;
    setText("");
    setError(undefined);
    const failed = await onSend(text);
    if (failed) {
      setText(text);
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
          {newThread && <NewThreadPickers options={newThread.options} />}
          {showStop ? (
            <button
              type="button"
              aria-label="Stop"
              onClick={onStop}
              className="ml-auto grid size-8 place-items-center rounded-full bg-primary text-primary-foreground"
            >
              <Square className="size-3 fill-current" />
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
      {newThread ? <WorkspaceBar {...newThread} /> : footer}
    </div>
  );
}

function NewThreadPickers({ options }: { options: ComposerOptions }) {
  const [model, setModel] = useState("Opus 5.5");
  const [effort, setEffort] = useState("High effort");
  const [permission, setPermission] = useState("Ask before edits");
  return (
    <>
      <Picker label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
        {options.models.map((group) => (
          <optgroup key={group.provider} label={group.provider}>
            {group.models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </optgroup>
        ))}
      </Picker>
      <Picker label="Effort" value={effort} onChange={(e) => setEffort(e.target.value)}>
        {options.efforts.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </Picker>
      <Picker
        label="Permissions"
        value={permission}
        onChange={(e) => setPermission(e.target.value)}
      >
        {options.permissions.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </Picker>
    </>
  );
}

function WorkspaceBar({ localHost, options }: { localHost: boolean; options: ComposerOptions }) {
  const [workspace, setWorkspace] = useState("local");
  const [branch, setBranch] = useState("main");
  return (
    <div className="flex items-center gap-0.5 px-2 pt-2">
      <Picker
        label="Workspace"
        icon={localHost ? <Laptop /> : <Server />}
        value={workspace}
        onChange={(e) => setWorkspace(e.target.value)}
      >
        <option value="local">Local checkout</option>
        <option value="worktree">New worktree</option>
      </Picker>
      <Picker
        label="Branch"
        icon={<GitBranch />}
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
      >
        {options.branches.map((b) => (
          <option key={b}>{b}</option>
        ))}
      </Picker>
    </div>
  );
}
