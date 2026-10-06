import { Pencil, Plus, Server } from "lucide-react";
import { useState } from "react";

import type { ConnectionState } from "../../preload/bridge";
import { statusLabel, useConnection } from "../ConnectionStatus";
import { DeviceIcon } from "../DeviceIcon";
import { localId, useHosts, type Host } from "../hosts";
import { IconButton } from "../ui";
import { ConnectSettings } from "./ConnectSettings";
import { SshHostDialog } from "./SshHostDialog";
import {
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
 * Parallax Connect and its devices (0056); then the SSH hosts, which can be added, edited, and
 * removed.
 */
export function ConnectionSettings() {
  const hosts = useHosts();
  const local = hosts.find((h) => h.id === localId)!;
  const remote = hosts.filter((h) => h.destination);
  // The host whose Add host dialog is open: its id, "new", or none.
  const [editing, setEditing] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const remove = async (id: string) => setRemoveError(await window.parallax.removeHost(id));

  return (
    <>
      <PageTitle title="Connections">
        Where your agents run: this computer, your other computers through Parallax Connect, and
        machines you reach over SSH with plxd installed.
      </PageTitle>
      <LocalHost host={local} />
      <ConnectSettings />

      <Section
        title="SSH hosts"
        action={
          <button
            type="button"
            onClick={() => setEditing("new")}
            className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            Add host
          </button>
        }
      >
        {removeError && (
          <p role="alert" className={`${settingRow} text-[12.5px] text-danger`}>
            {removeError}
          </p>
        )}
        {remote.map((h) => (
          <RemoteHost
            key={h.id}
            host={h}
            onEdit={() => setEditing(h.id)}
            onRemove={() => void remove(h.id)}
          />
        ))}
        {editing && (
          <SshHostDialog
            {...(editing !== "new" && { host: remote.find((h) => h.id === editing) })}
            onDone={() => setEditing(undefined)}
          />
        )}
        {!remote.length && (
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
        <DeviceIcon icon={host.icon ?? "laptop"} />
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
