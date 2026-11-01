import { Bot, Check, LoaderCircle, Network, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { Hub, HubAccount, HubService } from "../../protocol/generated/protocol";
import { useConnections } from "../ConnectionStatus";
import { describeError } from "../errors";
import {
  HUB_DOCS,
  HUB_GUIDE,
  refreshHubAccounts,
  removeHub,
  removeHubAccount,
  saveHub,
  setHubAccountEnabled,
  settingsOf,
} from "../hubs";
import type { Host } from "../hosts";
import { ClaudeLogo, OpenAILogo } from "../logos";
import { slug, unique } from "../providers";
import { IconButton } from "../ui";
import { notify } from "../notifications";
import { PlanBadge } from "../PlanBadge";
import { LimitLines } from "../Usage";
import {
  ConfirmRemove,
  field,
  primaryButton,
  quietButton,
  Row,
  rowField,
  Section,
  StatusDot,
  Switch,
} from "./parts";

// Settings > Providers > Hubs (0089): the Add hub dialog, the Hubs section, and a hub's page.

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
 * checked. Add saves it on each under one id and calls `onAdded` with it; after a computer fails,
 * Add again saves it under that id only to the computers it hasn't reached. Closing calls
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

  // The id an earlier try saved the hub under, and the computers it reached, so a retry saves the
  // same hub only to the others.
  const [saved, setSaved] = useState<{ id: string; hosts: string[] }>();

  const add = async () => {
    setSaving(true);
    setError(undefined);
    const targets = chosen.filter((h) => !saved?.hosts.includes(h.id));
    // One id on every computer, free on each.
    const id =
      saved?.id ??
      unique(
        slug(name).slice(0, 40),
        (
          await Promise.all(
            targets.map(async (h) => {
              const answer = await window.parallax.request(h.id, "hubs/list", { refresh: false });
              return "result" in answer ? answer.result.hubs.map((hub) => hub.id) : [];
            }),
          )
        ).flat(),
        "-",
      );
    const hub = {
      id,
      name: name.trim(),
      url: url.trim(),
      enabled: true,
      accessKey: accessKey.trim(),
      ...(managementKey.trim() && { managementKey: managementKey.trim() }),
    };
    const problems = await Promise.all(targets.map((h) => saveHub(h.id, hub)));
    const failures = problems.flatMap((problem, i) =>
      problem ? [`${targets[i]!.name}: ${problem}`] : [],
    );
    const reached = targets.filter((_, i) => !problems[i]).map((h) => h.id);
    setSaved({ id, hosts: [...(saved?.hosts ?? []), ...reached] });
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

/**
 * One of a hub's accounts: its email or id, its plan, and its limits, or why they're missing.
 * With `hubAccounts`, a switch turns it on or off on the hub, and Remove deletes it after a
 * confirm.
 */
function AccountRow({
  account,
  hostId,
  hub,
  manage,
}: {
  account: HubAccount;
  hostId: string;
  hub: string;
  manage: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const name = account.email ?? account.id;
  const change = async (call: () => Promise<string | undefined>) => {
    setBusy(true);
    const failed = await call();
    setBusy(false);
    setProblem(failed);
    if (!failed) setConfirming(false);
  };
  return (
    <div className="flex items-start gap-3 border-border px-4 py-3 not-last:border-b">
      <AccountLogo provider={account.provider} />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-body font-medium">
          <span className="truncate">{name}</span>
          {account.plan && <PlanBadge kind={account.provider} plan={account.plan} />}
          {account.disabled && !manage && (
            <span className="shrink-0 text-meta text-faint-foreground">Off on the hub</span>
          )}
        </span>
        <LimitLines limits={account.limits} />
        {(problem ?? account.problem) && (
          <span className="mt-1 block text-meta text-danger">{problem ?? account.problem}</span>
        )}
      </div>
      {manage &&
        (confirming ? (
          <div className="flex shrink-0 items-center gap-2 text-body text-muted-foreground">
            <span>Remove it from the hub?</span>
            <ConfirmRemove
              disabled={busy}
              onRemove={() => void change(() => removeHubAccount(hostId, hub, account.id))}
              onCancel={() => setConfirming(false)}
            />
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Switch
              label={`Use ${name}`}
              checked={!account.disabled}
              disabled={busy}
              onChange={(on) =>
                void change(() => setHubAccountEnabled(hostId, hub, account.id, on))
              }
            />
            <IconButton label={`Remove ${name}`} onClick={() => setConfirming(true)}>
              <Trash2 aria-hidden />
            </IconButton>
          </div>
        ))}
    </div>
  );
}

/** How often a waiting sign-in asks the hub where it is. */
const SIGN_IN_POLL_MS = 2000;

/** Where Add account is: choosing a service, then the sign-in's steps. */
type SignInStep =
  | { step: "choose" }
  | { step: "starting"; service: HubService }
  | { step: "waiting"; service: HubService; state: string }
  | { step: "done"; service: HubService }
  | { step: "cancelled"; service: HubService }
  | { step: "failed"; service: HubService; problem: string };

const serviceName = (service: HubService) => (service === "claude" ? "Claude" : "ChatGPT");

/**
 * Add account, the top row of a hub's accounts while it's open: Claude or Codex, then the
 * sign-in page in the system browser. A browser on the hub's computer comes back through the
 * hub's own callback forwarder; elsewhere its page doesn't load, and its address is pasted here.
 * It asks the hub every 2 seconds until the sign-in is done or failed, then lists the accounts
 * again. `onClose` ends it.
 */
function AddAccount({
  hostId,
  hub,
  onClose,
}: {
  hostId: string;
  hub: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<SignInStep>({ step: "choose" });
  const [address, setAddress] = useState("");
  const [addressProblem, setAddressProblem] = useState<string>();
  const [sending, setSending] = useState(false);
  const fail = (service: HubService, problem: string) =>
    setStep({ step: "failed", service, problem });

  const start = async (service: HubService) => {
    setStep({ step: "starting", service });
    setAddress("");
    setAddressProblem(undefined);
    const answer = await window.parallax.request(hostId, "hubs/accounts/signIn", { hub, service });
    if ("error" in answer) return fail(service, describeError(answer.error));
    setStep({ step: "waiting", service, state: answer.result.state });
    // The sign-in page opens here even for an SSH host, whose browser is this computer's.
    window.open(answer.result.url, "_blank");
  };

  // While it waits, ask the hub where the sign-in is.
  const waiting = step.step === "waiting" ? step : undefined;
  const service = waiting?.service;
  const state = waiting?.state;
  useEffect(() => {
    if (!service || !state) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const answer = await window.parallax.request(hostId, "hubs/accounts/status", { hub, state });
      if (stopped) return;
      if ("error" in answer)
        return setStep({ step: "failed", service, problem: describeError(answer.error) });
      const { status, problem } = answer.result;
      if (status === "waiting") return;
      if (status === "failed")
        return setStep({
          step: "failed",
          service,
          problem: problem ?? "The sign-in didn't finish.",
        });
      setStep({ step: status, service });
      if (status === "done") void refreshHubAccounts(hostId);
    }, SIGN_IN_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [hostId, hub, service, state]);

  const cancel = async () => {
    if (!waiting) return onClose();
    const { service, state } = waiting;
    const answer = await window.parallax.request(hostId, "hubs/accounts/cancel", { hub, state });
    if ("error" in answer) return fail(service, describeError(answer.error));
    const { status, problem } = answer.result;
    // The hub won't cancel while it saves the account, so it keeps waiting, and so does this.
    if (status === "waiting") return;
    if (status === "failed") return fail(service, problem ?? "The sign-in didn't finish.");
    if (status === "done") void refreshHubAccounts(hostId);
    setStep({ step: status, service });
  };

  // The address the browser ended on, checked here so a mistake reads plainly.
  const send = async () => {
    if (!waiting) return;
    let pasted: URL;
    try {
      pasted = new URL(address.trim());
    } catch {
      return setAddressProblem("That isn't a web address.");
    }
    if (pasted.searchParams.get("state") !== waiting.state)
      return setAddressProblem("That address is from another sign-in.");
    if (!pasted.searchParams.get("code") && !pasted.searchParams.get("error"))
      return setAddressProblem("That address has no sign-in code. Copy the whole address.");
    setSending(true);
    setAddressProblem(undefined);
    const answer = await window.parallax.request(hostId, "hubs/accounts/callback", {
      hub,
      state: waiting.state,
      redirectUrl: address.trim(),
    });
    setSending(false);
    if ("error" in answer) setAddressProblem(describeError(answer.error));
  };

  const close = (
    <button type="button" onClick={onClose} className={quietButton}>
      Close
    </button>
  );
  const spinner = <LoaderCircle aria-hidden className="size-3.5 animate-spin" />;
  if (step.step === "choose")
    return (
      <Row title="Add an account" description="Sign in in your browser. The hub keeps the account.">
        <button
          type="button"
          onClick={() => void start("claude")}
          className={`${quietButton} flex items-center gap-1.5`}
        >
          <ClaudeLogo aria-hidden className="size-3.5" />
          Claude
        </button>
        <button
          type="button"
          onClick={() => void start("codex")}
          className={`${quietButton} flex items-center gap-1.5`}
        >
          <OpenAILogo aria-hidden className="size-3.5" />
          Codex
        </button>
        <button type="button" onClick={onClose} className={quietButton}>
          Cancel
        </button>
      </Row>
    );
  if (step.step === "starting")
    return (
      <Row
        title={
          <span className="flex items-center gap-1.5">
            {spinner}
            Opening {serviceName(step.service)}'s sign-in…
          </span>
        }
      />
    );
  if (step.step === "waiting")
    return (
      <form
        className="border-border px-4 py-3 not-last:border-b"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void send();
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-body font-medium">
            {spinner}
            Waiting for the browser
          </span>
          <button type="button" onClick={() => void cancel()} className={quietButton}>
            Cancel
          </button>
        </div>
        <span className="block text-meta text-muted-foreground">
          Sign in to {serviceName(step.service)} in the browser. If it ends on a page that won't
          load, paste that page's address here.
        </span>
        <div className="mt-2 flex items-center gap-2">
          <input
            aria-label="Address after signing in"
            placeholder="http://localhost:…"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setAddressProblem(undefined);
            }}
            spellCheck={false}
            autoComplete="off"
            className={`${rowField} flex-1 font-mono`}
          />
          <button type="submit" disabled={!address.trim() || sending} className={primaryButton}>
            Send
          </button>
        </div>
        {addressProblem && (
          <span role="alert" className="mt-1 block text-meta text-danger">
            {addressProblem}
          </span>
        )}
      </form>
    );
  if (step.step === "done")
    return (
      <Row
        title={
          <span className="flex items-center gap-1.5">
            <Check aria-hidden className="size-3.5 text-added" />
            Signed in
          </span>
        }
        description={`The hub added the ${serviceName(step.service)} account.`}
      >
        {close}
      </Row>
    );
  if (step.step === "cancelled") return <Row title="Sign-in cancelled">{close}</Row>;
  return (
    <Row title="Sign-in failed" description={<span className="text-danger">{step.problem}</span>}>
      <button type="button" onClick={() => void start(step.service)} className={quietButton}>
        Try again
      </button>
      {close}
    </Row>
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
 * A hub's page, under its row in HubsSection: its status, the models it serves to
 * Claude Code and Codex, and with a management key its accounts with their plan and limits.
 * Without one, it takes the key. On a plxd with `hubAccounts`, Add account signs one in, and
 * each account can be turned off and on or removed.
 */
export function HubPane({
  id,
  hidden,
  hostId,
  hub,
}: {
  id: string;
  hidden: boolean;
  hostId: string;
  hub: Hub;
}) {
  const [managementKey, setManagementKey] = useState("");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [connection] = useConnections([hostId]);
  const manage =
    hub.hasManagementKey &&
    connection?.status === "connected" &&
    "hubAccounts" in connection.capabilities;
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
      role="region"
      aria-label={hub.name}
      hidden={hidden}
      className="min-w-0 border-t border-border p-5"
    >
      {/* Its row above names it and its address. */}
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
      <Section
        title="Accounts"
        action={
          manage &&
          !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className={`${quietButton} flex items-center gap-1.5 [&_svg]:size-3.5`}
            >
              <Plus aria-hidden />
              Add account
            </button>
          )
        }
      >
        {adding && <AddAccount hostId={hostId} hub={hub.id} onClose={() => setAdding(false)} />}
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
          <Row
            title="No accounts"
            description={
              manage
                ? "Add an account to use it here."
                : "Sign accounts in on the hub to use them here."
            }
          />
        ) : (
          byService.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              hostId={hostId}
              hub={hub.id}
              manage={manage}
            />
          ))
        )}
      </Section>
      <p className="px-1 text-meta text-muted-foreground">
        Sign accounts in only on a hub at home, not a VPS, and use Claude subscriptions only through
        Claude Code. <HubHelp />
      </p>
    </div>
  );
}

/**
 * Settings > Providers' Hubs, under the providers card as T3 Code lists its usage providers: a
 * heading with Add hub, then a card with a row per hub that turns it on or off, opens its page
 * (HubPane) under the row, or removes it after asking in place. `open` is the hub whose page shows;
 * the others stay mounted but hidden, so a sign-in on one outlives opening another. `error` is
 * why the hubs couldn't be listed.
 */
export function HubsSection({
  id,
  hostId,
  hubs,
  error,
  open,
  onOpen,
  onAdd,
}: {
  id: string;
  hostId: string;
  hubs: Hub[] | undefined;
  error?: string;
  open: string | undefined;
  onOpen: (hub: string | undefined) => void;
  onAdd: () => void;
}) {
  const pages = useId();
  // The hub Remove is asking about, until it's removed or Cancel.
  const [confirming, setConfirming] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const toggle = async (hub: Hub, enabled: boolean) => {
    const failed = await saveHub(hostId, { ...settingsOf(hub), enabled });
    if (failed) notify({ tone: "error", title: `Couldn't save ${hub.name}`, body: failed });
  };
  const remove = async (hub: Hub) => {
    setRemoving(true);
    const failed = await removeHub(hostId, hub.id);
    setRemoving(false);
    setConfirming(undefined);
    if (failed) notify({ tone: "error", title: `Couldn't remove ${hub.name}`, body: failed });
  };
  return (
    <section id={id} data-setting="hubs" aria-labelledby={`${id}-title`} className="mt-10">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-4 px-1">
        <h2 id={`${id}-title`} className="text-reading font-semibold">
          Hubs
        </h2>
        <button
          type="button"
          onClick={onAdd}
          className={`${quietButton} flex items-center gap-1.5 border border-border [&_svg]:size-3.5`}
        >
          <Plus aria-hidden />
          Add hub
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        {!hubs?.length ? (
          <p className="px-4 py-3.5 text-body text-muted-foreground">
            {hubs
              ? "Run Claude Code and Codex through one CLIProxyAPI hub that keeps every account signed in. "
              : error
                ? `Couldn't list this host's hubs. ${error}`
                : "Checking…"}
            {hubs && <HubHelp />}
          </p>
        ) : (
          hubs.map((hub) => {
            const shown = hub.id === open;
            const failing = hub.enabled && !hub.reachable;
            return (
              <div key={hub.id} className="not-last:border-b not-last:border-border">
                <div className="flex items-center gap-3 px-4 py-3.5">
                  <HubLogo
                    aria-hidden
                    className={`size-4 shrink-0 ${hub.enabled ? "" : "opacity-60"}`}
                  />
                  <div className={`min-w-0 flex-1 ${hub.enabled ? "" : "opacity-60"}`}>
                    <p className="flex items-baseline gap-2">
                      <span className="truncate text-body font-medium">{hub.name}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground">
                        {failing && <StatusDot tone="error" />}
                        {hubStatus(hub)}
                      </span>
                    </p>
                    <p className="truncate font-mono text-meta text-muted-foreground">{hub.url}</p>
                  </div>
                  {confirming === hub.id ? (
                    <div className="flex shrink-0 items-center gap-2 text-body text-muted-foreground">
                      <span>Remove {hub.name}?</span>
                      <ConfirmRemove
                        disabled={removing}
                        onRemove={() => void remove(hub)}
                        onCancel={() => setConfirming(undefined)}
                      />
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-expanded={shown}
                        aria-controls={`${pages}-${hub.id}`}
                        aria-label={`${shown ? "Close" : "Manage"} ${hub.name}`}
                        onClick={() => onOpen(shown ? undefined : hub.id)}
                        className={quietButton}
                      >
                        {shown ? "Close" : "Manage"}
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${hub.name}`}
                        onClick={() => setConfirming(hub.id)}
                        className={quietButton}
                      >
                        Remove
                      </button>
                      <span className="ml-2">
                        <Switch
                          label={`Use ${hub.name}`}
                          checked={hub.enabled}
                          onChange={(next) => void toggle(hub, next)}
                        />
                      </span>
                    </div>
                  )}
                </div>
                <HubPane id={`${pages}-${hub.id}`} hidden={!shown} hostId={hostId} hub={hub} />
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
