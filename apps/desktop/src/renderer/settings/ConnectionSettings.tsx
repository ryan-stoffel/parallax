import { Laptop, Pencil, Plus, Server } from "lucide-react";
import { useState } from "react";

import type { ConnectionState } from "../../preload/bridge";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { localId, useHosts, type Host } from "../hosts";
import { IconButton } from "../ui";
import {
  field,
  PageTitle,
  primaryButton,
  quietButton,
  Row,
  Section,
  settingRow,
  StatusDot,
} from "./parts";

const tone = (state?: ConnectionState) =>
  state?.status === "connected" ? "on" : state?.status === "failed" ? "warn" : "off";

/**
 * Settings > Connections: this computer, renamable, with its plxd and the app's version; then
 * the SSH hosts, which can be added, edited, and removed.
 */
export function ConnectionSettings() {
  const hosts = useHosts();
  const local = hosts.find((h) => h.id === localId)!;
  const remote = hosts.filter((h) => h.destination);
  // The host whose form is open: its id, "new", or none.
  const [editing, setEditing] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const remove = async (id: string) => setRemoveError(await window.parallax.removeHost(id));

  return (
    <>
      <PageTitle title="Connections">
        Where your agents run: this computer, and machines you reach over SSH with plxd installed.
      </PageTitle>
      <LocalHost host={local} />

      <Section
        title="SSH hosts"
        action={
          editing !== "new" && (
            <button
              type="button"
              onClick={() => setEditing("new")}
              className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
            >
              <Plus aria-hidden />
              Add host
            </button>
          )
        }
      >
        {removeError && (
          <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
            {removeError}
          </p>
        )}
        {remote.map((h) =>
          editing === h.id ? (
            <HostForm key={h.id} host={h} onDone={() => setEditing(undefined)} />
          ) : (
            <RemoteHost
              key={h.id}
              host={h}
              onEdit={() => setEditing(h.id)}
              onRemove={() => void remove(h.id)}
            />
          ),
        )}
        {editing === "new" && <HostForm onDone={() => setEditing(undefined)} />}
        {!remote.length && editing !== "new" && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Server aria-hidden className="size-6 text-faint-foreground" />
            <p className="text-[13px] font-medium">No SSH hosts yet</p>
            <p className="max-w-sm text-[12.5px] text-muted-foreground">
              Add a machine you reach over SSH, such as a Mac mini with plxd installed, to run
              agents there.
            </p>
          </div>
        )}
      </Section>
    </>
  );
}

/** This computer: its name, which Rename edits in place, and its plxd. */
function LocalHost({ host }: { host: Host }) {
  const state = useConnection(host.id);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string>();
  const rename = async (name: string) => {
    const failed = await window.parallax.renameLocal(name);
    setError(failed);
    if (!failed) setRenaming(false);
  };

  return (
    <section aria-label="This computer" className="mb-8">
      <div className="mb-2 flex min-h-7 items-center gap-2 text-[13px] text-muted-foreground [&_svg]:size-4">
        <Laptop aria-hidden />
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void rename(new FormData(e.currentTarget).get("name") as string);
            }}
          >
            <input
              name="name"
              aria-label="Computer name"
              defaultValue={host.name}
              autoFocus
              maxLength={64}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
              className="w-48 rounded-md border border-border bg-background px-2 py-0.5 text-[13px] text-foreground"
            />
            <button type="submit" className={primaryButton}>
              Save
            </button>
            <button type="button" className={quietButton} onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="font-medium text-foreground">{host.name}</span>
            <IconButton label="Rename this computer" onClick={() => setRenaming(true)}>
              <Pencil aria-hidden />
            </IconButton>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="rounded-xl border border-border bg-surface">
        <Row
          title="Local plxd"
          description="Runs agents on this computer. Parallax starts it and keeps it connected."
        >
          <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <StatusDot tone={tone(state)} />
            {state ? statusLabel(state) : "Connecting…"}
            {state?.status === "connected" && (
              <span className="font-mono text-[12px]">· {state.plxd}</span>
            )}
          </span>
        </Row>
      </div>
    </section>
  );
}

/** A saved SSH host: its connection, destination, and Edit and Remove. */
function RemoteHost({
  host,
  onEdit,
  onRemove,
}: {
  host: Host;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const state = useConnection(host.id);
  return (
    <div className={settingRow}>
      <div className="min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <StatusDot tone={tone(state)} />
          <span className="truncate">{host.name}</span>
        </span>
        <span className="block truncate text-[12.5px] text-muted-foreground">
          <span className="font-mono">{host.destination}</span>
          {state && ` · ${statusLabel(state)}`}
          {state?.status === "connected" && ` · plxd ${state.plxd}`}
        </span>
      </div>
      <div className="flex shrink-0 gap-1">
        <button type="button" className={quietButton} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className={quietButton} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

/** Adds a host, or edits `host`. `onDone` runs once it's saved or cancelled. */
function HostForm({ host, onDone }: { host?: Host; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const save = async (form: HTMLFormElement) => {
    // Text inputs' values are strings.
    const data = new FormData(form);
    setSaving(true);
    const input = {
      name: data.get("name") as string,
      destination: data.get("destination") as string,
    };
    const failed = await window.parallax.saveHost(input, host?.id);
    setSaving(false);
    if (failed) setError(failed);
    else onDone();
  };

  return (
    <form
      aria-label={host ? `Edit ${host.name}` : "Add host"}
      onSubmit={(e) => {
        e.preventDefault();
        void save(e.currentTarget);
      }}
      className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
    >
      <label className="text-[12.5px] text-muted-foreground">
        Name
        <input name="name" defaultValue={host?.name} placeholder="Mac mini" className={field} />
      </label>
      <label className="text-[12.5px] text-muted-foreground">
        SSH destination
        <input
          name="destination"
          required
          defaultValue={host?.destination}
          placeholder="mac-mini, or me@192.168.1.20"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={field}
        />
        <span className="mt-1 block text-faint-foreground">
          Anything ssh accepts. Parallax uses your ssh config and keys.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={quietButton}>
          Cancel
        </button>
        <button type="submit" disabled={saving} className={primaryButton}>
          {host ? "Save" : "Add host"}
        </button>
      </div>
    </form>
  );
}
