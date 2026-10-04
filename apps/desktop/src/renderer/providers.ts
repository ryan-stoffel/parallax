import { Bot, Cpu } from "lucide-react";
import { useEffect, useSyncExternalStore, type ComponentType, type SVGProps } from "react";

import type { ConnectionState } from "../preload/bridge";
import type {
  ProviderEnvVar,
  ProviderInstance,
  ProviderKind,
  ProvidersListResult,
} from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { notify } from "./notifications";
import { merged, stored } from "./stored";
import {
  AmpLogo,
  AntigravityLogo,
  ClaudeLogo,
  ClineLogo,
  CursorLogo,
  GrokLogo,
  HermesLogo,
  maskLogo,
  OllamaLogo,
  OpenAILogo,
  OpenCodeLogo,
  OpenRouterLogo,
  PiLogo,
} from "./logos";

// A host's provider instances (`providers/list`), on a plxd with `providers`: one list per host,
// shared by Settings and every model picker, and replaced by each save or remove's answer.

const lists = new Map<string, ProvidersListResult>();
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<string | undefined>>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function put(hostId: string, result: ProvidersListResult | undefined) {
  const before = lists.get(hostId);
  if (before && result) notifySignIns(hostId, before, result);
  if (result) lists.set(hostId, result);
  else lists.delete(hostId);
  for (const listener of listeners) listener();
}

/**
 * A notification for each enabled instance whose sign-in changed between two lists (PLX-507):
 * signed in, as when Sign in's terminal ends, or signed out, which its threads would fail on.
 */
function notifySignIns(hostId: string, before: ProvidersListResult, after: ProvidersListResult) {
  for (const { instance, signedIn, account } of after.providers) {
    const was = before.providers.find((p) => p.instance.id === instance.id)?.signedIn;
    if (!instance.enabled || was == null || signedIn == null || was === signedIn) continue;
    const key = `provider/${hostId}/${instance.id}`;
    if (signedIn)
      notify({ key, tone: "success", title: `Signed in to ${instance.name}`, body: account });
    else
      notify({
        key,
        tone: "error",
        title: `${instance.name} is signed out`,
        body: "Its threads can't run until you sign in again in Settings > Providers.",
      });
  }
}

/**
 * Lists `hostId`'s instances again, probing each with `refresh`. A load already on its way answers
 * one without `refresh`. Resolves to an error for people.
 */
export function loadProviders(hostId: string, refresh = false): Promise<string | undefined> {
  const pending = loading.get(hostId);
  if (pending && !refresh) return pending;
  const load = window.parallax.request(hostId, "providers/list", { refresh }).then((answer) => {
    if (loading.get(hostId) === load) loading.delete(hostId);
    if ("error" in answer) return describeError(answer.error);
    put(hostId, answer.result);
    return undefined;
  });
  loading.set(hostId, load);
  return load;
}

/** Adds `instance` to a host, or replaces the one with its id. Resolves to an error for people. */
export async function saveProvider(
  hostId: string,
  instance: ProviderInstance,
): Promise<string | undefined> {
  const answer = await window.parallax.request(hostId, "providers/save", { instance });
  if ("error" in answer) return describeError(answer.error);
  put(hostId, answer.result);
  return undefined;
}

/** Removes an instance, and its secrets. Resolves to an error for people. */
export async function removeProvider(hostId: string, id: string): Promise<string | undefined> {
  const answer = await window.parallax.request(hostId, "providers/remove", { id });
  if ("error" in answer) return describeError(answer.error);
  put(hostId, answer.result);
  return undefined;
}

/**
 * `hostId`'s instances, kept current: listed whenever it connects to a plxd with `providers`, and
 * undefined until then, for no host, and for an older plxd.
 */
export function useProviders(hostId: string | undefined): ProvidersListResult | undefined {
  const listed = useSyncExternalStore(subscribe, () =>
    hostId === undefined ? undefined : lists.get(hostId),
  );
  useEffect(() => {
    if (hostId === undefined) return;
    const check = (state: ConnectionState) => {
      if (state.status !== "connected") return;
      // Probing every instance starts each ACP agent, so a view only loads a list the host has
      // none of yet; Settings lists them again, and probes on Refresh.
      if ("providers" in state.capabilities) {
        if (!lists.has(hostId)) void loadProviders(hostId);
      } else if (lists.has(hostId)) put(hostId, undefined);
    };
    const stop = window.parallax.onConnectionState((id, state) => id === hostId && check(state));
    // It rejects only for a host just removed, whose views are going away.
    window.parallax.connectionState(hostId).then(check, () => {});
    return stop;
  }, [hostId]);
  return listed;
}

type Logo = ComponentType<SVGProps<SVGSVGElement>>;

/** A kind of provider instance (`ProviderKind`), as Parallax shows it. */
export interface Kind {
  name: string;
  Logo: Logo;
  /** The program plxd runs for it when the instance names none. */
  program?: string;
  /** Whether an instance's `args` are its whole argument list, not added to the kind's own. */
  wholeArgs?: boolean;
}

export const kinds: Record<string, Kind> = {
  claude: { name: "Claude Code", Logo: ClaudeLogo, program: "claude" },
  codex: { name: "Codex", Logo: OpenAILogo, program: "codex" },
  cursor: { name: "Cursor", Logo: CursorLogo, program: "agent" },
  antigravity: { name: "Antigravity", Logo: AntigravityLogo, program: "agy_acp_server.par" },
  opencode: { name: "OpenCode", Logo: OpenCodeLogo, program: "opencode" },
  pi: { name: "Pi", Logo: PiLogo, program: "npx", wholeArgs: true },
  grokBuild: { name: "Grok Build", Logo: GrokLogo, program: "grok" },
  hermes: { name: "Hermes Agent", Logo: HermesLogo, program: "hermes" },
  ollamaCloud: { name: "Ollama Cloud", Logo: OllamaLogo, program: "claude" },
  openRouter: { name: "OpenRouter", Logo: OpenRouterLogo, program: "claude" },
  localModel: { name: "Local model", Logo: Cpu, program: "claude" },
  acp: { name: "ACP agent", Logo: Bot, wholeArgs: true },
};

/** `kind`'s entry, or the generic ACP one for a kind this app doesn't know. */
export const kindOf = (kind: string): Kind => kinds[kind] ?? kinds["acp"]!;

/** ACP agents with a mark of their own, known by their name or program. */
const acpLogos: [RegExp, Logo][] = [
  [/\bamp\b/i, AmpLogo],
  [/\bcline\b/i, ClineLogo],
];

const registryIcons = stored<Record<string, string>>("parallax.registryIcons", {}, merged);

/** Keeps an ACP Registry agent's icon on this device, for the instances named `name`. */
export const keepRegistryIcon = (name: string, url: string) =>
  registryIcons.set({ ...registryIcons.get(), [name]: url });

/**
 * An instance's logo: its kind's, or for an ACP agent, its own mark, else the icon of the
 * registry agent it was added as (by its name), else the generic one.
 */
export function logoOf(instance: { kind: string; name: string; program?: string }): Logo {
  if (instance.kind !== "acp") return kindOf(instance.kind).Logo;
  const own = `${instance.name} ${instance.program ?? ""}`;
  const known = acpLogos.find(([name]) => name.test(own))?.[1];
  const icon = registryIcons.get()[instance.name];
  return known ?? (icon ? (maskLogo(icon) as Logo) : kindOf("acp").Logo);
}

/**
 * The logo of the instance a run's `backend` names, on any host whose instances are listed: its
 * kind's, or undefined for a backend no list has yet.
 */
export function instanceLogo(backend: string): Logo | undefined {
  for (const list of lists.values()) {
    const info = list.providers.find((p) => p.instance.id === backend);
    if (info) return logoOf(info.instance);
  }
  return undefined;
}

/**
 * The name of the instance `id` on any host whose instances are listed: a subscription account
 * is named by its instance, an added one by the name the user gave it.
 */
export function instanceName(id: string): string | undefined {
  for (const list of lists.values()) {
    const info = list.providers.find((p) => p.instance.id === id);
    if (info) return info.instance.name;
  }
  return undefined;
}

/** An Add provider card: what a new instance starts as. */
export interface Preset {
  kind: ProviderKind;
  name: string;
  /** A line about it, under its name. */
  blurb: string;
  /** Its program, when it isn't the kind's. */
  program?: string;
  args?: string[];
  /** What its variables start as. A secret without a value is asked for. */
  env?: ProviderEnvVar[];
  /** Why the program must be given, which makes the field required. */
  programHint?: string;
}

const anthropicApi = (url: string, token: Omit<ProviderEnvVar, "name">): ProviderEnvVar[] => [
  { name: "ANTHROPIC_BASE_URL", value: url, secret: false },
  { name: "ANTHROPIC_AUTH_TOKEN", ...token },
];

/**
 * The Add provider dialog's cards, in order: the main providers. Every other ACP agent
 * comes from the ACP Registry. The model services run Claude Code against an Anthropic-compatible
 * endpoint, set in their variables.
 */
export const presets: Preset[] = [
  { kind: "claude", name: "Claude Code", blurb: "Anthropic's agent" },
  { kind: "codex", name: "Codex", blurb: "OpenAI's agent" },
  { kind: "cursor", name: "Cursor", blurb: "Cursor Agent" },
  {
    kind: "pi",
    name: "Pi",
    blurb: "A minimal agent",
    args: ["-y", "pi-acp@0.0.34"],
    env: [{ name: "PI_ACP_PI_COMMAND", value: "pi", secret: false }],
  },
  { kind: "opencode", name: "OpenCode", blurb: "Any model" },
  {
    kind: "ollamaCloud",
    name: "Ollama Cloud",
    blurb: "Claude Code on Ollama's models",
    env: anthropicApi("https://ollama.com", { secret: true }),
  },
  { kind: "hermes", name: "Hermes Agent", blurb: "Nous Portal" },
  {
    kind: "openRouter",
    name: "OpenRouter",
    blurb: "Claude Code on any model",
    env: anthropicApi("https://openrouter.ai/api", { secret: true }),
  },
  {
    kind: "localModel",
    name: "Local model",
    blurb: "Claude Code on your own server",
    env: anthropicApi("http://127.0.0.1:8080", { value: "local", secret: false }),
  },
];

/** What a version choice sets: its program (absent: the kind's), arguments, and variables. */
export interface Version {
  label: string;
  program?: string;
  args?: string[];
  env?: ProviderEnvVar[];
}

const piVersion = (label: string, pkg: string, command: string): Version => ({
  label,
  args: ["-y", pkg],
  env: [{ name: "PI_ACP_PI_COMMAND", value: command, secret: false }],
});

/** The kinds that run in more than one version, the default first. */
export const versions: Partial<Record<string, Version[]>> = {
  opencode: [{ label: "1.x" }, { label: "2.x", program: "opencode2" }],
  pi: [piVersion("1.0", "pi-acp@0.0.34", "pi"), piVersion("0.x", "pi-acp@0.0.27", "pi-0.73")],
};

type Fields = Pick<ProviderInstance, "kind" | "program" | "args" | "env">;

/**
 * The version `fields` run, read back from them: the first besides the default whose program or
 * arguments they have, else the default. Undefined for a kind with one version.
 */
export function versionOf(fields: Fields): Version | undefined {
  const all = versions[fields.kind];
  const has = (v: Version) =>
    (v.program !== undefined && fields.program === v.program) ||
    (v.args !== undefined && v.args.join(" ") === fields.args.join(" "));
  return all && (all.slice(1).find(has) ?? all[0]);
}

/** `fields` running `version`: its program, its arguments if it sets them, and its variables. */
export function withVersion<T extends Fields>(fields: T, version: Version): T {
  const names = new Set(version.env?.map((v) => v.name));
  return {
    ...fields,
    // A custom program stays, unless it is another version's.
    program:
      version.program ??
      (versions[fields.kind]?.some((v) => v.program && v.program === fields.program)
        ? undefined
        : fields.program),
    args: version.args ?? fields.args,
    env: [...fields.env.filter((v) => !names.has(v.name)), ...(version.env ?? [])],
  };
}
