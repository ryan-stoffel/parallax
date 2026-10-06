import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import type { Host } from "../hosts";
import { IconButton, shortcut } from "../ui";
import { field, primaryButton } from "./parts";

/**
 * The destination Add host saves for a host, user, and port: `host`, `user@host`, or
 * `ssh://[user@]host:port` when the port isn't 22. An IPv6 address with a port goes in brackets.
 * The main process still checks it (`checkHost`).
 */
export function destinationOf(host: string, user: string, port: string): string {
  const h = host.trim();
  const u = user.trim();
  const p = port.trim();
  if (!p || p === "22") return u ? `${u}@${h}` : h;
  const address = h.includes(":") ? `[${h}]` : h;
  return `ssh://${u ? `${u}@` : ""}${address}:${p}`;
}

/** A saved destination back in Add host's fields, for Edit. */
export function fieldsOf(destination: string): { host: string; user: string; port: string } {
  const url = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/.exec(destination);
  if (url) return { user: url[1] ?? "", host: url[2]!.replace(/^\[|\]$/g, ""), port: url[3] ?? "" };
  const at = destination.lastIndexOf("@");
  return at > 0
    ? { user: destination.slice(0, at), host: destination.slice(at + 1), port: "" }
    : { user: "", host: destination, port: "" };
}

/** Why Port can't be used, or undefined when it's empty or 1 to 65535. */
function portError(port: string): string | undefined {
  const p = port.trim();
  if (!p) return undefined;
  const n = Number(p);
  return /^\d{1,5}$/.test(p) && n >= 1 && n <= 65535
    ? undefined
    : "Port is a number from 1 to 65535.";
}

/**
 * Add host (PLX-580), a modal dialog open while it's mounted: an SSH host or alias, with the
 * hosts ssh already knows suggested as you type (click, arrow keys and Enter, or Mod+1 to 9);
 * then the username and port; then Add computer. With `host`, it edits that host, and asks for
 * its name too. `onDone` runs once it's saved or closed.
 */
export function SshHostDialog({ host, onDone }: { host?: Host; onDone: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const hostField = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();
  const initial = host?.destination ? fieldsOf(host.destination) : undefined;
  const [target, setTarget] = useState(initial?.host ?? "");
  const [user, setUser] = useState(initial?.user ?? "");
  const [port, setPort] = useState(initial?.port ?? "");
  const [name, setName] = useState(host?.name ?? "");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // showModal focuses the first control, Close; the host field is where typing goes.
  useEffect(() => {
    dialog.current?.showModal();
    hostField.current?.focus();
  }, []);
  useEffect(() => {
    void window.parallax.sshSuggestions().then(setSuggestions);
  }, []);

  const typed = target.trim().toLowerCase();
  const matches = suggestions
    .filter((s) => s.toLowerCase().includes(typed) && s.toLowerCase() !== typed)
    .slice(0, 9);
  const showing = open && matches.length > 0;

  const pick = (choice: string) => {
    setTarget(choice);
    setOpen(false);
    setActive(0);
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const digit = /^[1-9]$/.test(e.key) && (e.metaKey || e.ctrlKey) ? Number(e.key) : 0;
    if (showing && digit && matches[digit - 1]) {
      // Mod+1 to 9 open sidebar rows elsewhere; here they pick a host.
      e.preventDefault();
      e.stopPropagation();
      return pick(matches[digit - 1]!);
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (showing ? (a + 1) % matches.length : 0));
    } else if (e.key === "ArrowUp" && showing) {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" && showing) {
      e.preventDefault();
      pick(matches[active]!);
    } else if (e.key === "Escape" && showing) {
      // Closes the list, not the dialog.
      e.preventDefault();
      setOpen(false);
    }
  };

  const save = async () => {
    const why = !target.trim()
      ? "Enter an SSH host or alias, such as mac-mini or 192.168.1.20."
      : portError(port);
    if (why) return setError(why);
    setSaving(true);
    const failed = await window.parallax.saveHost(
      { name: host ? name : target.trim(), destination: destinationOf(target, user, port) },
      host?.id,
    );
    setSaving(false);
    setError(failed);
    if (!failed) dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onDone}
      className="m-auto w-[36rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        aria-label={host ? `Edit ${host.name}` : "Add host"}
        className="flex flex-col gap-4 px-5 pt-4 pb-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold">
              {host ? `Edit ${host.name}` : "Add a computer over SSH"}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Parallax signs in with your SSH config, keys, and agent, then runs plxd there.
            </p>
          </div>
          <IconButton label="Close" onClick={() => dialog.current?.close()}>
            <X aria-hidden />
          </IconButton>
        </header>

        <label className="relative block text-[12.5px] font-medium">
          SSH host or alias
          <input
            name="host"
            role="combobox"
            aria-expanded={showing}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showing ? `${listId}-${active}` : undefined}
            ref={hostField}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setOpen(true);
              setActive(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={keys}
            placeholder="Search hosts or type an IP address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            className={`${field} font-normal`}
          />
          {showing && (
            <ul
              id={listId}
              role="listbox"
              aria-label="Hosts ssh knows"
              className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-border bg-surface p-1 font-normal shadow-composer"
            >
              {matches.map((choice, i) => (
                <li
                  key={choice}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  // Before the input's blur, which would close the list first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(choice);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex cursor-default items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] ${i === active ? "bg-hover" : ""}`}
                >
                  <span className="truncate font-mono text-[12.5px]">{choice}</span>
                  <span className="text-[12px] text-faint-foreground">
                    {shortcut(String(i + 1))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </label>

        <div className="flex gap-3">
          <label className="flex-1 text-[12.5px] font-medium">
            Username
            <input
              name="user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="From your ssh config"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className={`${field} font-normal`}
            />
          </label>
          <label className="w-28 text-[12.5px] font-medium">
            Port
            <input
              name="port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              inputMode="numeric"
              className={`${field} font-normal`}
            />
          </label>
        </div>

        {host && (
          <label className="text-[12.5px] font-medium">
            Name
            <input
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={target.trim() || "Mac mini"}
              className={`${field} font-normal`}
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={saving}
          className={`${primaryButton} flex items-center justify-center gap-1.5 py-2 [&_svg]:size-4`}
        >
          {!host && <Plus aria-hidden />}
          {host ? "Save" : "Add computer"}
        </button>
      </form>
    </dialog>
  );
}
