import { useState } from "react";

import type { TerminalTarget } from "../preload/bridge";
import { TerminalView } from "./Terminal";

/**
 * A terminal running a sign-in on a host, in the main process's pty, as the window's terminal
 * `sign-in`: a CLI's own (0004), a provider instance's `login`, or a CLI's install. `onExit` runs
 * when it ends; closing the pane (`onClose`, or unmounting) ends it if it's still running.
 */
export function SignInTerminal({
  target,
  name,
  onExit,
  onClose,
}: {
  /** A CLI's or a provider instance's sign-in, or a CLI's install. */
  target: Exclude<TerminalTarget, { path: string }>;
  /** What signs in, as people know it, such as "Claude Code". */
  name: string;
  onExit: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);

  const done = ended || error !== undefined;
  const install = "install" in target;
  return (
    <div className="flex flex-col gap-2 border-border px-4 py-3 not-last:border-b">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-muted-foreground">
          {install
            ? done
              ? `${name} install ended.`
              : `Installing ${name}…`
            : done
              ? `${name} sign-in ended.`
              : `Signing in to ${name}…`}
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
          key={JSON.stringify(target)}
          id="sign-in"
          target={target}
          label={`${name} ${install ? "install" : "sign-in"} terminal`}
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
