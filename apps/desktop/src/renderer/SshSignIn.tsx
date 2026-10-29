import { useState } from "react";

import type { DeviceIcon as DeviceIconName } from "../preload/bridge";
import { DeviceIcon } from "./DeviceIcon";
import { localId } from "./hosts";
import { TerminalView } from "./Terminal";

/** A computer that ran Remote Control sessions to import (PLX-1136). */
export type Device = { name: string; icon: DeviceIconName };

/**
 * Prototype (PLX-1136): the SSH sign-in to `device` that copying its Remote Control sessions waits
 * on, sliding up over the list and leaving its progress in view. Its address starts as the device's name on this network and can be
 * changed. A sign-in that fails stays open to try again or at another address. `onDone` gets
 * nothing once one succeeds, or why the user gave up.
 */
export function SshSignIn({ device, onDone }: { device: Device; onDone: (why?: string) => void }) {
  const [address, setAddress] = useState(`${device.name}.local`);
  const [draft, setDraft] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<string>();
  const declined = `You didn't sign in to ${device.name}.`;
  return (
    <div
      role="dialog"
      aria-label={`Sign in to ${device.name}`}
      className="approval-in absolute inset-x-0 bottom-12 z-10 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-composer"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
          <DeviceIcon icon={device.icon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium">Sign in to {device.name}</p>
          <p className="text-meta text-muted-foreground">
            Parallax copies the session files over SSH. Nothing is installed or changed on{" "}
            {device.name}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDone(declined)}
          className="-my-1 shrink-0 rounded-md px-2.5 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {draft === undefined ? (
        <div className="flex items-center gap-2 text-meta text-faint-foreground">
          <span className={`min-w-0 truncate ${failed ? "text-danger" : "font-mono"}`}>
            {failed ?? `ssh ${address}`}
          </span>
          {failed && (
            <button
              type="button"
              onClick={() => {
                setFailed(undefined);
                setAttempt((n) => n + 1);
              }}
              className="shrink-0 rounded px-1 font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => setDraft(address)}
            className="shrink-0 rounded px-1 font-medium text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            Change
          </button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) setAddress(draft.trim());
            setDraft(undefined);
            setFailed(undefined);
            setAttempt((n) => n + 1);
          }}
        >
          <input
            aria-label={`${device.name}'s address`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="user@host"
            autoFocus
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-meta outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="rounded-md bg-selected px-2.5 py-1 text-meta font-medium hover:bg-hover"
          >
            Connect
          </button>
        </form>
      )}
      {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
      <div className="h-28 rounded-lg border border-border bg-background p-2">
        <TerminalView
          key={attempt}
          id={`ssh-copy-${attempt}`}
          target={{ hostId: localId, sshCopy: { address } }}
          label={`SSH sign-in to ${device.name}`}
          background="--background"
          onEnd={(error, exitCode) => {
            if (!error && exitCode === 0) onDone();
            else setFailed(error ?? `Couldn't sign in to ${device.name} at ${address}.`);
          }}
        />
      </div>
    </div>
  );
}
