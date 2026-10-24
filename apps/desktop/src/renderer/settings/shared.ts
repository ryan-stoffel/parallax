// The pure parts of Settings, which the mobile app's Settings shares: how a provider, an account,
// a schedule, a script, and GitHub read for people, and the accounts a thread can run on.

import type { RpcError } from "../../preload/bridge";
import {
  ErrorCodes,
  type AccountChoice,
  type GithubStatus,
  type ImportSource,
  type Provider,
  type ProviderInfo,
  type RepoScript,
  type Schedule,
} from "../../protocol/generated/protocol";
import { describeError } from "../errors";

/**
 * The vendor CLIs plxd detects (0004), by `CliKind`: where each says how to install it, and the
 * provider its API keys are for. Not Cursor's: 0004 rules out `CURSOR_API_KEY` as a fallback.
 */
export const cliInfo: Record<string, { name: string; install: string; keyProvider?: Provider }> = {
  claude: {
    name: "Claude Code",
    install: "https://code.claude.com/docs/en/setup",
    keyProvider: "anthropic",
  },
  codex: {
    name: "Codex",
    install: "https://learn.chatgpt.com/docs/codex/cli",
    keyProvider: "openai",
  },
  cursor: {
    name: "Cursor",
    install: "https://cursor.com/docs/cli/installation",
  },
};

export const providerNames: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/**
 * A failed accounts request, for people. A plxd without these methods is too old. A keychain
 * failure shows plxd's message, which names the fix on that host's OS.
 */
export function accountsError(error: RpcError): string {
  if (error.code === ErrorCodes.MethodNotFound)
    return "Update plxd on this host to manage its accounts here.";
  if (error.data?.kind === "keychainUnavailable")
    return `This host's keychain isn't available: ${error.message}.`;
  return describeError(error);
}

/** A plan a CLI reports in lowercase ("max") capitalized; an email as it is. */
export const capitalized = (text: string) =>
  text.includes("@") ? text : text.charAt(0).toUpperCase() + text.slice(1);

/**
 * An instance's state, as its list row says it: "Authenticated · Max", or "Authenticated" when the
 * agent gives an email rather than a plan, or what it needs, from plxd's note, such as
 * "Not authenticated · Add your API key".
 */
export function instanceStatus(info: ProviderInfo): string {
  const why = info.note ? ` · ${info.note}` : "";
  // plxd's note only names the missing program, which the pane says.
  if (!info.installed) return "Not installed";
  if (info.signedIn === false) return `Not authenticated${why}`;
  if (info.signedIn !== true) return info.note ?? "Ready";
  return info.account && !info.account.includes("@")
    ? `Authenticated · ${capitalized(info.account)}`
    : "Authenticated";
}

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A trigger in a few words, as T3 Code's `scheduleLabel`: "Every 60 min", "Weekdays at 09:00". */
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => weekdayNames[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/** When a task runs next, from `now`: "in 5m", "in 3h", "in 2d". */
export function nextLabel(at: string, now = Date.now()): string {
  const minutes = Math.ceil((new Date(at).getTime() - now) / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** A script's roles in a few words, as T3 Code's `projectScriptMenuLabel` names them. */
export function scriptRoles(script: RepoScript): string {
  const roles = [
    ...(script.runOnWorktreeCreate
      ? [script.async === false ? "setup, holds the agent" : "setup"]
      : []),
    ...(script.runOnSettle ? ["on settle"] : []),
  ];
  return roles.join(", ");
}

/**
 * What GitHub's row says of a host's `gh`, and its dot's tone. `setup` is whether that plxd can
 * install `gh` and sign it in (`githubSetup`).
 */
export function githubLine(
  status: GithubStatus,
  setup: boolean,
): { detail: string; tone: "on" | "off" | "warn" } {
  if (status.installing) return { detail: "Installing the GitHub CLI…", tone: "warn" };
  if (!status.installed)
    return {
      detail: setup
        ? "Not installed. Parallax can install the GitHub CLI on this host."
        : "Not installed. Install the GitHub CLI on this host to open pull requests.",
      tone: "off",
    };
  if (status.signingIn)
    return { detail: "Waiting for you to approve the code on GitHub…", tone: "warn" };
  if (status.signedIn === false)
    return {
      detail: setup
        ? "Not signed in."
        : "Not signed in. Run `gh auth login` on this host, then refresh.",
      tone: "warn",
    };
  if (status.signedIn)
    return {
      detail: status.account ? `Signed in as @${status.account}` : "Signed in",
      tone: "on",
    };
  return { detail: status.note ?? "Couldn't tell whether gh is signed in.", tone: "warn" };
}

/** An account a worker or coordinator can run on, as the account chooser lists it. */
export interface AccountOption {
  label: string;
  account: AccountChoice;
}

/**
 * The host's accounts a thread or a Project's coordinator can run on: its signed-in Claude Code
 * login, then its Anthropic key accounts. Resolves to plxd's error, for people, when either list
 * fails.
 */
export async function accountOptions(hostId: string): Promise<AccountOption[] | string> {
  const [clis, keys] = await Promise.all([
    window.parallax.request(hostId, "accounts/list", {}),
    window.parallax.request(hostId, "accounts/keys/list", {}),
  ]);
  if ("error" in clis) return describeError(clis.error);
  if ("error" in keys) return describeError(keys.error);
  // ponytail: mirrors plxd's backend registry, where only Claude runs workers today. PLX-99 has
  // plxd report which accounts can run a thread, so this stops hard-coding it.
  return [
    ...clis.result.clis
      .filter((c) => c.cli === "claude" && c.signedIn)
      .map((c) => ({
        label: "Claude Code",
        account: { kind: "subscription", backend: c.cli } as const,
      })),
    ...keys.result.accounts
      .filter((k) => k.provider === "anthropic")
      .map((k) => ({
        label: `${k.label} (API key)`,
        account: { kind: "key", id: k.id } as const,
      })),
  ];
}

/** The agent kind each source's imports continue on. */
const importKinds: Record<ImportSource, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  chatgpt: "codex",
  claudeChat: "claude",
};

/**
 * The account an import from `source` runs its follow-ups on: that source's own agent when it's
 * on, else the first agent that is. With none, plxd picks the source's own.
 */
export function importAccount(source: ImportSource, providers: ProviderInfo[] | undefined) {
  const kind = importKinds[source];
  const on = providers?.filter((p) => p.instance.enabled);
  const info =
    on?.find((p) => p.instance.id === kind) ?? on?.find((p) => p.instance.kind === kind) ?? on?.[0];
  return info && ({ kind: "subscription", backend: info.instance.id } as const);
}
