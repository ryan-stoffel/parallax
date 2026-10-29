import { useState } from "react";

import type { DeviceIcon as DeviceIconName } from "../preload/bridge";
import { DeviceIcon } from "./DeviceIcon";
import { localId } from "./hosts";
import { TerminalView } from "./Terminal";

/** A computer that ran Remote Control sessions to import (PLX-1136). */
export type Device = { name: string; icon: DeviceIconName };

const field =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-body outline-none focus:border-accent";
const quietLink =
  "shrink-0 rounded px-1 font-medium text-muted-foreground hover:bg-hover hover:text-foreground";

/**
 * Prototype (PLX-1136): the SSH sign-in to `device` that copying its Remote Control sessions waits
 * on, sliding up over the list and leaving its progress in view. It asks for the username there,
 * with the computer's address, which starts as its name on this network, then a terminal asks for
 * the password, as ssh does. A sign-in that fails stays open to try again or as someone else.
 * `onDone` gets nothing once one succeeds, or why the user gave up.
 */
export function SshSignIn({ device, onDone }: { device: Device; onDone: (why?: string) => void }) {
  const [user, setUser] = useState("");
  const [host, setHost] = useState(`${device.name}.local`);
  // The username and address being typed, before the terminal starts.
  const [editing, setEditing] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState<string>();
  const address = `${user}@${host}`;
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
          onClick={() => onDone(`You didn't sign in to ${device.name}.`)}
          className="-my-1 shrink-0 rounded-md px-2.5 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {editing ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!user.trim() || !host.trim()) return;
            setUser(user.trim());
            setHost(host.trim());
            setEditing(false);
            setFailed(undefined);
            setAttempt((n) => n + 1);
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-muted-foreground">
            Username on {device.name}
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              autoFocus
              autoComplete="username"
              spellCheck={false}
              className={field}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-meta text-muted-foreground">
            Address
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              spellCheck={false}
              className={`${field} font-mono`}
            />
          </label>
          <button
            type="submit"
            disabled={!user.trim() || !host.trim()}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
          >
            Connect
          </button>
        </form>
      ) : (
        <>
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
                className={quietLink}
              >
                Try again
              </button>
            )}
            <button type="button" onClick={() => setEditing(true)} className={quietLink}>
              Change
            </button>
          </div>
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
                else setFailed(error ?? `Couldn't sign in to ${device.name} as ${address}.`);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
