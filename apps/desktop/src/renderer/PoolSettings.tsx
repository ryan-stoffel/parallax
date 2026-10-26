import { Layers, Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ProviderInfo, ProviderInstance, ProviderKind } from "../protocol/generated/protocol";
import { notify } from "./notifications";
import { accountLabel, kindOf, logoOf, saveProvider, slug, unique } from "./providers";
import { field, quietButton, Row, Switch } from "./settings/parts";
import { instanceStatus } from "./settings/shared";
import { IconButton } from "./ui";

// Account pools (PLX-1033): a provider instance with `members`, other instances of its kind. plxd
// starts each thread on a pool on the member with the most usage left, and the thread stays there.

/** The kinds Parallax offers to pool: those whose subscription lives in a home folder of its own. */
export const poolable = (kind: string) => kind === "claude" || kind === "codex";

/** What a pool's row in Settings > Providers says under its name. */
export const poolStatus = (members: string[]) => `Pool of ${members.length} accounts`;

/** What a pool does, for people. */
const poolBlurb =
  "Each new thread starts on the account with the most usage left, so you can use every account's limits. A thread stays on the account it started on.";

/** A pool's accounts as the walkthrough edits them: existing instances it holds, and new ones. */
export interface PoolDraft {
  name: string;
  existing: string[];
  /** The display names of accounts to add. */
  fresh: string[];
}

/** The instances a pool of `kind` can hold: those of the kind that aren't pools. */
const accountsOf = (list: ProviderInfo[], kind: string) =>
  list.filter((p) => !p.instance.members && p.instance.kind === kind);

/** A temporary label until the account signs in, or the user gives it a label. */
const accountName = (taken: string[]) => unique("Account", taken);

/**
 * A new account of `kind` named `name`, unique among the host's ids: the kind's own id and home while
 * the host has none, else a home folder of its own, such as `~/.codex-account`, which plxd makes, so it
 * signs in apart from the others.
 */
export function newAccount(
  kind: ProviderKind,
  name: string,
  list: ProviderInstance[],
): ProviderInstance {
  const taken = list.map((p) => p.id);
  const defaultHome = !list.some((p) => p.kind === kind && !p.members && !p.home);
  const id = defaultHome && !taken.includes(kind) ? kind : unique(`${kind}-account`, taken, "-");
  return {
    id,
    kind,
    name,
    enabled: true,
    ...(!(defaultHome && id === kind) && { home: `~/.${id}` }),
    args: [],
    env: [],
    models: [],
  };
}

/** The draft the walkthrough opens with for `kind`: every account the host has, and new ones up to two. */
export function poolDraft(kind: ProviderKind, list: ProviderInfo[]): PoolDraft {
  const existing = accountsOf(list, kind).map((p) => p.instance.id);
  const names = list.map((p) => p.instance.name);
  const fresh: string[] = [];
  while (existing.length + fresh.length < 2) fresh.push("");
  return { name: unique(`${kindOf(kind).name} pool`, names), existing, fresh };
}

/** How many accounts `draft` pools. */
export const poolSize = (draft: PoolDraft) => draft.existing.length + draft.fresh.length;

/**
 * Saves `draft`'s new accounts of `kind` on the host, then the pool. Resolves to the pool's id, or
 * to why it couldn't, for people.
 */
export async function createPool(
  hostId: string,
  kind: ProviderKind,
  draft: PoolDraft,
  list: ProviderInfo[],
): Promise<{ id: string } | { error: string; created: string[] }> {
  const instances = list.map((p) => p.instance);
  const created: string[] = [];
  const members = [...draft.existing];
  for (const name of draft.fresh) {
    const account = newAccount(
      kind,
      name.trim() || accountName(instances.map((p) => p.name)),
      instances,
    );
    const failed = await saveProvider(hostId, account);
    if (failed) return { error: `Couldn't add ${account.name}: ${failed}`, created };
    instances.push(account);
    created.push(account.id);
    members.push(account.id);
  }
  const name = draft.name.trim() || `${kindOf(kind).name} pool`;
  const id = unique(
    slug(name),
    instances.map((p) => p.id),
    "-",
  );
  const failed = await saveProvider(hostId, {
    id,
    kind,
    name,
    enabled: true,
    args: [],
    env: [],
    models: [],
    members,
  });
  return failed ? { error: failed, created } : { id };
}

/** One account in a pool's list: its logo, name, and state, then `children`. */
function AccountRow({ info, children }: { info: ProviderInfo; children: ReactNode }) {
  const Logo = logoOf(info.instance);
  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          <Logo aria-hidden className="size-4 shrink-0" />
          {accountLabel(info)}
        </span>
      }
      description={info.instance.enabled ? instanceStatus(info) : "Off"}
    >
      {children}
    </Row>
  );
}

/** What a pool does, in a callout, with `children` after it. */
export function PoolExplainer({ children }: { children?: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-body text-muted-foreground">
      <Layers aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
      <p>
        {poolBlurb}
        {children}
      </p>
    </div>
  );
}

/**
 * The walkthrough's accounts of `kind`: the pool's name, the host's accounts of the kind, each
 * with a switch to pool it, and new accounts to add, each signed in on its own after.
 */
export function PoolAccounts({
  kind,
  list,
  draft,
  onChange,
}: {
  kind: ProviderKind;
  list: ProviderInfo[];
  draft: PoolDraft;
  onChange: (draft: PoolDraft) => void;
}) {
  const { Logo } = kindOf(kind);
  return (
    <div className="flex flex-col gap-4">
      <PoolExplainer> Each new account signs in after it's added.</PoolExplainer>
      <label className="text-body text-muted-foreground">
        Pool name
        <input
          required
          maxLength={64}
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          className={field}
        />
        <span className="mt-1 block text-faint-foreground">
          Shown when you choose automatic account selection.
        </span>
      </label>
      <div>
        <p className="mb-2 text-body text-muted-foreground">Accounts</p>
        <p className="mb-3 text-meta text-faint-foreground">
          Your sign-in email identifies each account when the provider shares it. Add a label like
          Personal or Work if you prefer.
        </p>
        <div className="rounded-xl border border-border">
          {accountsOf(list, kind).map((info) => {
            const id = info.instance.id;
            return (
              <AccountRow key={id} info={info}>
                <Switch
                  label={`Pool ${accountLabel(info)}`}
                  checked={draft.existing.includes(id)}
                  onChange={(on) =>
                    onChange({
                      ...draft,
                      existing: on
                        ? [...draft.existing, id]
                        : draft.existing.filter((e) => e !== id),
                    })
                  }
                />
              </AccountRow>
            );
          })}
          {draft.fresh.map((name, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <Logo aria-hidden className="size-4 shrink-0" />
              <input
                aria-label={`New account ${i + 1} label`}
                placeholder={
                  i === 0 ? "Label, e.g. Personal (optional)" : "Label, e.g. Work (optional)"
                }
                maxLength={64}
                value={name}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    fresh: draft.fresh.map((n, j) => (j === i ? e.target.value : n)),
                  })
                }
                spellCheck={false}
                autoComplete="off"
                className={`${field} mt-0 flex-1`}
              />
              <span className="shrink-0 text-meta text-faint-foreground">Sign in next</span>
              <IconButton
                label={`Remove ${name || `new account ${i + 1}`}`}
                onClick={() => onChange({ ...draft, fresh: draft.fresh.filter((_, j) => j !== i) })}
              >
                <X aria-hidden />
              </IconButton>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => onChange({ ...draft, fresh: [...draft.fresh, ""] })}
          className={`${quietButton} mt-1.5 -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <Plus aria-hidden />
          Add account
        </button>
        {poolSize(draft) < 2 && (
          <p className="mt-1 text-body text-faint-foreground">A pool needs two or more accounts.</p>
        )}
      </div>
    </div>
  );
}

/**
 * A pool's pane in Settings > Providers, `hidden` unless its tab is chosen: what it does, its
 * display name, and its accounts, which the instances of its kind join or leave. A pooled account
 * that isn't signed in offers Sign in, which opens its own pane and its sign-in with `onOpen`. Add
 * account adds a new account of the kind to the pool and opens it the same way. A pool keeps two or more.
 */
export function PoolPane({
  id,
  tabId,
  hidden,
  hostId,
  info,
  list,
  nameField,
  onOpen,
}: {
  id: string;
  tabId: string;
  hidden: boolean;
  hostId: string;
  info: ProviderInfo;
  list: ProviderInfo[];
  /** The field that edits its display name, as every instance's pane has. */
  nameField: (save: (name: string) => void) => ReactNode;
  onOpen: (id: string) => void;
}) {
  const { instance } = info;
  const members = instance.members ?? [];
  const Logo = logoOf(instance);
  const [pendingAccount, setPendingAccount] = useState<ProviderInstance>();
  const [adding, setAdding] = useState(false);
  const save = async (change: Partial<ProviderInstance>) => {
    const failed = await saveProvider(hostId, { ...instance, ...change });
    if (failed) notify({ tone: "error", title: `Couldn't save ${instance.name}`, body: failed });
    return !failed;
  };
  const addAccount = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const account =
        pendingAccount ??
        newAccount(
          instance.kind,
          accountName(list.map((p) => p.instance.name)),
          list.map((p) => p.instance),
        );
      if (!pendingAccount) {
        const failed = await saveProvider(hostId, account);
        if (failed)
          return notify({ tone: "error", title: `Couldn't add ${account.name}`, body: failed });
        setPendingAccount(account);
      }
      if (await save({ members: [...new Set([...members, account.id])] })) {
        setPendingAccount(undefined);
        if (info.installed) onOpen(account.id);
      }
    } finally {
      setAdding(false);
    }
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
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <Logo className="size-5" />
          <Layers
            aria-hidden
            className="absolute -right-1.5 -bottom-1.5 size-4 rounded-sm border border-border bg-surface p-0.5 text-accent"
          />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-reading font-semibold">{instance.name}</h2>
          <p className="truncate text-body text-muted-foreground">
            Pool of {members.length} {kindOf(instance.kind).name} accounts
          </p>
        </div>
      </div>
      <div className="mb-8">
        <PoolExplainer />
      </div>
      <section aria-label="Pool" className="mb-8">
        <div className="rounded-xl border border-border bg-surface">
          <Row title="Display name" description="How the model picker names it.">
            {nameField((name) => void save({ name }))}
          </Row>
        </div>
      </section>
      <section aria-label="Accounts" className="mb-8">
        <div className="mb-2 flex min-h-7 items-center justify-between gap-4 px-1">
          <h2 className="text-reading font-semibold">Accounts</h2>
          <button
            type="button"
            disabled={adding}
            onClick={() => void addAccount()}
            className={`${quietButton} flex items-center gap-1 [&_svg]:size-3.5`}
          >
            <Plus aria-hidden />
            {adding ? "Adding…" : pendingAccount ? "Retry adding account" : "Add account"}
          </button>
        </div>
        <div className="rounded-xl border border-border bg-surface">
          {accountsOf(list, instance.kind).map((member) => {
            const memberId = member.instance.id;
            const inPool = members.includes(memberId);
            return (
              <AccountRow key={memberId} info={member}>
                {inPool && member.installed && member.signedIn !== true && (
                  <button
                    type="button"
                    onClick={() => onOpen(memberId)}
                    className={`${quietButton} border border-border`}
                  >
                    Sign in
                  </button>
                )}
                <Switch
                  label={`Pool ${member.instance.name}`}
                  checked={inPool}
                  disabled={inPool && members.length <= 2}
                  onChange={(on) =>
                    void save({
                      members: on ? [...members, memberId] : members.filter((m) => m !== memberId),
                    })
                  }
                />
              </AccountRow>
            );
          })}
        </div>
      </section>
    </div>
  );
}
