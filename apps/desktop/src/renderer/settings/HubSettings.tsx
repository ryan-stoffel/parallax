import { Bot, Network, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { Hub, HubAccount } from "../../protocol/generated/protocol";
import { useConnections } from "../ConnectionStatus";
import { HUB_DOCS, HUB_GUIDE, saveHub, settingsOf } from "../hubs";
import type { Host } from "../hosts";
import { ClaudeLogo, OpenAILogo } from "../logos";
import { slug, unique } from "../providers";
import { Redacted } from "../Redacted";
import { IconButton } from "../ui";
import { LimitLines } from "../Usage";
import { field, primaryButton, quietButton, Row, rowField, Section, StatusDot } from "./parts";

// Settings > Providers > Hubs (0089): the Add hub dialog, and a hub's page.

const link = "text-accent hover:underline";

/** CLIProxyAPI's docs and Theo's setup guide, as links. */
export function HubHelp() {
  return (
    <span className="flex gap-3">
      <a href={HUB_DOCS} target="_blank" rel="noreferrer" className={link}>
        CLIProxyAPI docs
      </a>
      <a href={HUB_GUIDE} target="_blank" rel="noreferrer" className={link}>
        Theo's setup guide
      </a>
    </span>
  );
}

/** A hub's mark. */
export const HubLogo = Network;

/** A hub's state in a few words: "Connected · 12 models", or why it isn't. */
export function hubStatus(hub: Hub): string {
  if (!hub.enabled) return "Off";
  if (!hub.reachable) return hub.problem ?? "Not connected";
  const models = hub.claudeModels.length + hub.codexModels.length;
  return `Connected · ${models} ${models === 1 ? "model" : "models"}`;
}

/** The hosts among `hosts` that are connected to a plxd with `hubs`. */
function useHubHosts(hosts: Host[]): Host[] {
  const states = useConnections(hosts.map((h) => h.id));
  return hosts.filter((_, i) => {
    const state = states[i];
    return state?.status === "connected" && "hubs" in state.capabilities;
  });
}

/**
 * Add hub, a native modal <dialog> open while it's mounted: the hub's name, URL, access key, and
 * optional management key, and the computers to add it to, each connected one with `hubs`, all
 * checked. Add saves it on each under one id and calls `onAdded` with it; closing calls
 * `onClose`.
 */
export function AddHubDialog({
  hosts,
  onAdded,
  onClose,
}: {
  hosts: Host[];
  onAdded: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [name, setName] = useState("Home hub");
  const [url, setUrl] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [managementKey, setManagementKey] = useState("");
  // Computers left out, so a computer that connects while it's open is in.
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  const eligible = useHubHosts(hosts);
  const chosen = eligible.filter((h) => !skipped.includes(h.id));

  const add = async () => {
    setSaving(true);
    setError(undefined);
    // One id on every computer, free on each.
    const lists = await Promise.all(
      chosen.map(async (h) => {
        const answer = await window.parallax.request(h.id, "hubs/list", { refresh: false });
        return "result" in answer ? answer.result.hubs.map((hub) => hub.id) : [];
      }),
    );
    const id = unique(slug(name).slice(0, 40), lists.flat(), "-");
    const hub = {
      id,
      name: name.trim(),
      url: url.trim(),
      enabled: true,
      accessKey: accessKey.trim(),
      ...(managementKey.trim() && { managementKey: managementKey.trim() }),
    };
    const failures = (await Promise.all(chosen.map((h) => saveHub(h.id, hub)))).flatMap(
      (problem, i) => (problem ? [`${chosen[i]!.name}: ${problem}`] : []),
    );
    setSaving(false);
    if (failures.length) return setError(failures.join("\n"));
    onAdded(id);
    dialog.current?.close();
  };

  const close = () => dialog.current?.close();
  const ready = name.trim() && /^https?:\/\/\S+$/.test(url.trim()) && accessKey.trim();
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[32rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        className="flex max-h-[85vh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && chosen.length) void add();
        }}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1">
            <h2 id={titleId} className="text-reading font-semibold">
              Add hub
            </h2>
            <p className="mt-0.5 text-body text-muted-foreground">
              Run Claude Code and Codex through a CLIProxyAPI hub that keeps your accounts signed
              in.
            </p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-border px-5 py-4">
          <label className="text-body text-muted-foreground">
            Name
            <input
              autoFocus
              required
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              className={field}
            />
          </label>
          <label className="text-body text-muted-foreground">
            URL
            <input
              type="url"
              required
              placeholder="https://hub.example.ts.net:8317"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              className={`${field} font-mono`}
            />
          </label>
          <label className="text-body text-muted-foreground">
            Access key
            <input
              type="password"
              required
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              autoComplete="off"
              className={field}
            />
            <span className="mt-1 block text-faint-foreground">
              One of the hub's api-keys. Kept in each computer's keychain.
            </span>
          </label>
          <label className="text-body text-muted-foreground">
            Management key
            <input
              type="password"
              placeholder="Optional"
              value={managementKey}
              onChange={(e) => setManagementKey(e.target.value)}
              autoComplete="off"
              className={field}
            />
            <span className="mt-1 block text-faint-foreground">
              Shows the hub's accounts and their limits.
            </span>
          </label>
          <fieldset className="text-body text-muted-foreground">
            <legend>Computers</legend>
            {eligible.length === 0 ? (
              <p className="mt-1 text-faint-foreground">
                No connected computer can use hubs yet. Update plxd on it first.
              </p>
            ) : (
              <div className="mt-1 flex flex-col gap-1.5">
                {eligible.map((h) => (
                  <label key={h.id} className="flex items-center gap-2 text-foreground">
                    <input
                      type="checkbox"
                      checked={!skipped.includes(h.id)}
                      onChange={(e) =>
                        setSkipped(
                          e.target.checked
                            ? skipped.filter((id) => id !== h.id)
                            : [...skipped, h.id],
                        )
                      }
                      className="accent-(--accent)"
                    />
                    {h.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <p className="text-meta text-muted-foreground">
            New to hubs? <HubHelp />
          </p>
          {error && (
            <p role="alert" className="text-body whitespace-pre-line text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={close} className={quietButton}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ready || chosen.length === 0 || saving}
            className={primaryButton}
          >
            {saving
              ? "Adding…"
              : chosen.length > 1
                ? `Add to ${chosen.length} computers`
                : "Add hub"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** An account's service mark: Claude's, OpenAI's for Codex, or a generic one. */
function AccountLogo({ provider }: { provider: string }) {
  const Logo = provider === "claude" ? ClaudeLogo : provider === "codex" ? OpenAILogo : Bot;
  return <Logo aria-hidden className="mt-0.5 size-3.5 shrink-0" />;
}

/** "pro" as "Pro", "chatgpt_plus" as "Chatgpt Plus". */
const planName = (plan: string) =>
  plan.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** One of a hub's accounts: its email or id, its plan, and its limits, or why they're missing. */
function AccountRow({ account }: { account: HubAccount }) {
  return (
    <div className="flex items-start gap-3 border-border px-4 py-3 not-last:border-b">
      <AccountLogo provider={account.provider} />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-body font-medium">
          <span className="truncate">
            <Redacted text={account.email ?? account.id} />
          </span>
          {account.plan && (
            <span className="shrink-0 rounded-sm bg-hover px-1.5 text-caption font-medium text-muted-foreground">
              {planName(account.plan)}
            </span>
          )}
          {account.disabled && (
            <span className="shrink-0 text-meta text-faint-foreground">Off on the hub</span>
          )}
        </span>
        <LimitLines limits={account.limits} />
        {account.problem && (
          <span className="mt-1 block text-meta text-danger">{account.problem}</span>
        )}
      </div>
    </div>
  );
}

/** A hub's models for one agent, as a wrapped list of ids. */
function ModelRow({ title, models }: { title: string; models: Hub["claudeModels"] }) {
  return (
    <Row
      title={title}
      description={
        models.length ? (
          <span className="mt-1 flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span
                key={m.id}
                className="rounded-sm bg-hover px-1.5 font-mono text-caption text-muted-foreground"
              >
                {m.id}
              </span>
            ))}
          </span>
        ) : (
          "None"
        )
      }
    />
  );
}

/**
 * A hub's page, `hidden` unless its tab is chosen: its status and URL, the models it serves to
 * Claude Code and Codex, and with a management key its accounts with their plan and limits.
 * Without one, it takes the key.
 */
export function HubPane({
  id,
  tabId,
  hidden,
  hostId,
  hub,
}: {
  id: string;
  tabId: string;
  hidden: boolean;
  hostId: string;
  hub: Hub;
}) {
  const [managementKey, setManagementKey] = useState("");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const tone = !hub.enabled ? "off" : hub.reachable ? "on" : "error";
  const byService = useMemo(
    () => [...hub.accounts].sort((a, b) => a.provider.localeCompare(b.provider)),
    [hub.accounts],
  );
  const keep = async (key: string) => {
    setSaving(true);
    const failed = await saveHub(hostId, { ...settingsOf(hub), managementKey: key });
    setSaving(false);
    setProblem(failed);
    if (!failed) setManagementKey("");
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
          <HubLogo className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-reading font-semibold">{hub.name}</h2>
          <p className="truncate font-mono text-body text-muted-foreground">{hub.url}</p>
        </div>
      </div>
      <Section title="Hub">
        <Row
          title="Status"
          description={
            <span className="flex items-center gap-1.5">
              <StatusDot tone={tone} />
              <span className="min-w-0">{hubStatus(hub)}</span>
            </span>
          }
        />
        <Row
          title="Runs"
          description="Claude Code and Codex threads on its models, with your own settings otherwise."
        />
      </Section>
      <Section title="Models">
        <ModelRow title="Claude Code" models={hub.claudeModels} />
        <ModelRow title="Codex" models={hub.codexModels} />
      </Section>
      <Section title="Accounts">
        {!hub.hasManagementKey ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (managementKey.trim()) void keep(managementKey.trim());
            }}
          >
            <Row
              title="Management key"
              description={problem ?? "Add it to see the hub's accounts and their limits."}
            >
              <input
                type="password"
                aria-label="Management key"
                value={managementKey}
                onChange={(e) => setManagementKey(e.target.value)}
                autoComplete="off"
                className={rowField}
              />
              <button
                type="submit"
                disabled={!managementKey.trim() || saving}
                className={primaryButton}
              >
                Save
              </button>
            </Row>
          </form>
        ) : hub.accountsProblem ? (
          <Row title="Couldn't list accounts" description={hub.accountsProblem} />
        ) : byService.length === 0 ? (
          <Row title="No accounts" description="Sign accounts in on the hub to use them here." />
        ) : (
          byService.map((account) => <AccountRow key={account.id} account={account} />)
        )}
      </Section>
      <p className="px-1 text-meta text-muted-foreground">
        Set up and sign in accounts on the hub: <HubHelp />
      </p>
    </div>
  );
}
