import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { ProviderInfo } from "../protocol/generated/protocol";
import { notify } from "./notifications";
import { kindOf, logoOf, saveProvider, slug, unique } from "./providers";
import { field, primaryButton, quietButton, Row, Switch } from "./settings/parts";
import { instanceStatus } from "./settings/shared";
import { IconButton } from "./ui";

// Account pools (PLX-1033): a provider instance with `members`, other instances of its kind. plxd
// starts each thread on a pool on the member with the most usage left, and the thread stays there.

/** What a pool's row in Settings > Providers says under its name. */
export const poolStatus = (members: string[]) => `Pool · ${members.length} accounts`;

/** The instances a pool of `kind` can hold: those of the kind that aren't pools. */
const candidates = (list: ProviderInfo[], kind?: string) =>
  list.filter((p) => !p.instance.members && (kind === undefined || p.instance.kind === kind));

/** One instance a pool can hold, with a switch that puts it in or takes it out. */
function MemberRow({
  info,
  checked,
  disabled,
  onChange,
}: {
  info: ProviderInfo;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const Logo = logoOf(info.instance);
  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          <Logo aria-hidden className="size-4 shrink-0" />
          {info.instance.name}
        </span>
      }
      description={info.instance.enabled ? instanceStatus(info) : "Off"}
    >
      <Switch
        label={`Pool ${info.instance.name}`}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </Row>
  );
}

/**
 * New pool, a native modal <dialog> open while it's mounted: a name and two or more instances of
 * one kind. The first one picked sets the kind. Create saves the pool on the host and calls
 * `onAdded` with its id; closing calls `onClose`.
 */
export function NewPoolDialog({
  hostId,
  list,
  onAdded,
  onClose,
}: {
  hostId: string;
  list: ProviderInfo[];
  onAdded: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [members, setMembers] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);

  const kind = list.find((p) => p.instance.id === members[0])?.instance.kind;
  const fallback = kind ? `${kindOf(kind).name} pool` : "Pool";
  const shown = candidates(list);
  const create = async () => {
    if (!kind || members.length < 2) return;
    const display = name.trim() || fallback;
    const id = unique(
      slug(display),
      list.map((p) => p.instance.id),
      "-",
    );
    setSaving(true);
    const failed = await saveProvider(hostId, {
      id,
      kind,
      name: display,
      enabled: true,
      args: [],
      env: [],
      models: [],
      members,
    });
    setSaving(false);
    if (failed) return setError(failed);
    onAdded(id);
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[34rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        className="flex max-h-[85vh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1">
            <h2 id={titleId} className="text-reading font-semibold">
              New pool
            </h2>
            <p className="mt-0.5 text-body text-muted-foreground">
              Pool accounts of one provider. Each new thread starts on the account with the most
              usage left.
            </p>
          </div>
          <IconButton label="Close" onClick={() => dialog.current?.close()}>
            <X />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <label className="text-body text-muted-foreground">
            Display name
            <input
              autoFocus
              maxLength={64}
              value={name}
              placeholder={fallback}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className={field}
            />
          </label>
          <p className="mt-4 mb-2 text-body text-muted-foreground">Accounts</p>
          <div className="rounded-xl border border-border">
            {shown.map((info) => (
              <MemberRow
                key={info.instance.id}
                info={info}
                checked={members.includes(info.instance.id)}
                // Another kind can't join once the first pick sets it.
                disabled={kind !== undefined && info.instance.kind !== kind}
                onChange={(on) =>
                  setMembers(
                    on
                      ? [...members, info.instance.id]
                      : members.filter((m) => m !== info.instance.id),
                  )
                }
              />
            ))}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-body text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={() => dialog.current?.close()} className={quietButton}>
            Cancel
          </button>
          <button type="submit" disabled={members.length < 2 || saving} className={primaryButton}>
            {saving ? "Creating…" : "Create pool"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * A pool's pane in Settings > Providers, `hidden` unless its tab is chosen: its display name, and
 * its accounts, which the instances of its kind join or leave. A pool keeps two or more.
 */
export function PoolPane({
  id,
  tabId,
  hidden,
  hostId,
  info,
  list,
  nameField,
}: {
  id: string;
  tabId: string;
  hidden: boolean;
  hostId: string;
  info: ProviderInfo;
  list: ProviderInfo[];
  /** The field that edits its display name, as every instance's pane has. */
  nameField: (save: (name: string) => void) => ReactNode;
}) {
  const { instance } = info;
  const members = instance.members ?? [];
  const Logo = logoOf(instance);
  const save = async (change: { name?: string; members?: string[] }) => {
    const failed = await saveProvider(hostId, { ...instance, ...change });
    if (failed)
      notify({
        tone: "error",
        title: `Couldn't save ${instance.name}`,
        body: failed,
      });
  };
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={tabId}
      hidden={hidden}
      className="min-w-0 p-5 @3xl:overflow-y-auto"
    >
      <div className="mb-6 flex items-center gap-3 px-1">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <Logo className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-reading font-semibold">{instance.name}</h2>
          <p className="truncate text-body text-muted-foreground">
            {kindOf(instance.kind).name} · {members.length} accounts
          </p>
        </div>
      </div>
      <section aria-label="Pool" className="mb-8">
        <div className="rounded-xl border border-border bg-surface">
          <Row title="Display name" description="How threads and model menus name it.">
            {nameField((name) => void save({ name }))}
          </Row>
        </div>
      </section>
      <section aria-label="Accounts" className="mb-8">
        <div className="mb-2 px-1">
          <h2 className="text-reading font-semibold">Accounts</h2>
          <p className="text-body text-muted-foreground">
            A new thread starts on the account with the most usage left, and stays on it.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface">
          {candidates(list, instance.kind).map((member) => {
            const id = member.instance.id;
            const inPool = members.includes(id);
            return (
              <MemberRow
                key={id}
                info={member}
                checked={inPool}
                disabled={inPool && members.length <= 2}
                onChange={(on) =>
                  void save({
                    members: on ? [...members, id] : members.filter((m) => m !== id),
                  })
                }
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
