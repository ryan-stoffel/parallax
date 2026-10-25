import { useState } from "react";

import type { TerminalTarget } from "../preload/bridge";
import { notify } from "./notifications";
import { TerminalView } from "./Terminal";

/**
 * A terminal running a sign-in on a host, in this computer's plxd, as the window's terminal
 * `sign-in`: a CLI's own (0004), a provider instance's `login`, a CLI's install, or an SSH host's
 * login (0007). `onExit` runs when it ends; a terminal that fails says why in a notification.
 * Closing the pane (`onClose`, or unmounting) ends it if it's still running.
 */
export function SignInTerminal({
  target,
  name,
  onExit,
  onClose,
}: {
  /** A CLI's, a provider instance's, or an SSH host's sign-in, or a CLI's install. */
  target: Exclude<TerminalTarget, { path: string }>;
  /** What signs in, as people know it, such as "Claude Code". */
  name: string;
  onExit: () => void;
  onClose: () => void;
}) {
  const [ended, setEnded] = useState(false);

  const install = "install" in target;
  return (
    <div className="flex flex-col gap-2 border-border px-4 py-3 not-last:border-b">
      <div className="flex items-center justify-between gap-4">
        <span className="text-body text-muted-foreground">
          {install
            ? ended
              ? `${name} install ended.`
              : `Installing ${name}…`
            : ended
              ? `${name} sign-in ended.`
              : `Signing in to ${name}…`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="-my-1 rounded-md px-2.5 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          {ended ? "Close" : "Cancel"}
        </button>
      </div>
      {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
      <div className="h-64 rounded-md border border-border bg-surface p-2">
        <TerminalView
          key={JSON.stringify(target)}
          id="sign-in"
          target={target}
          label={`${name} ${install ? "install" : "sign-in"} terminal`}
          onEnd={(why) => {
            setEnded(true);
            if (why)
              return notify({
                tone: "error",
                title: install ? `Couldn't install ${name}` : `Couldn't sign in to ${name}`,
                body: why,
              });
            onExit();
          }}
        />
      </div>
    </div>
  );
}
