import { useState } from "react";

import type { CliKind } from "../protocol/generated/protocol";
import { TerminalView } from "./Terminal";

/**
 * A terminal running `cli`'s own sign-in on a host (0004), in the main process's pty, as the
 * window's terminal `sign-in`. `onExit` runs when the sign-in ends; closing the pane (`onClose`,
 * or unmounting) ends it if it's still running.
 */
export function SignInTerminal({
  hostId,
  cli,
  name,
  onExit,
  onClose,
}: {
  hostId: string;
  cli: CliKind;
  /** The CLI as people know it, such as "Claude Code". */
  name: string;
  onExit: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);

  const done = ended || error !== undefined;
  return (
    <div className="flex flex-col gap-2 border-border px-4 py-3 not-last:border-b">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-muted-foreground">
          {done ? `${name} sign-in ended.` : `Signing in to ${name}…`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="-my-1 rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          {done ? "Close" : "Cancel"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
      <div className="h-64 rounded-md border border-border bg-surface p-2">
        <TerminalView
          key={`${hostId}/${cli}`}
          id="sign-in"
          target={{ hostId, cli }}
          label={`${name} sign-in terminal`}
          onEnd={(why) => {
            if (why) return setError(why);
            setEnded(true);
            onExit();
          }}
        />
      </div>
    </div>
  );
}
