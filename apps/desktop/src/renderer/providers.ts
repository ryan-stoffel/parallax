import { Bot, Cpu, Feather } from "lucide-react";
import { useEffect, useSyncExternalStore, type ComponentType, type SVGProps } from "react";

import type { ConnectionState } from "../preload/bridge";
import type {
  ProviderEnvVar,
  ProviderInstance,
  ProviderKind,
  ProvidersListResult,
} from "../protocol/generated/protocol";
import { describeError } from "./errors";
import {
  AntigravityLogo,
  ClaudeLogo,
  CursorLogo,
  GrokLogo,
  OhMyPiLogo,
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
  if (result) lists.set(hostId, result);
  else lists.delete(hostId);
  for (const listener of listeners) listener();
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

/** Removes an instance the user added. Resolves to an error for people. */
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
      if ("providers" in state.capabilities) void loadProviders(hostId);
      else if (lists.has(hostId)) put(hostId, undefined);
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
  omp: { name: "Oh My Pi", Logo: OhMyPiLogo, program: "omp" },
  grokBuild: { name: "Grok Build", Logo: GrokLogo, program: "grok" },
  hermes: { name: "Hermes Agent", Logo: Feather, program: "hermes" },
  ollamaCloud: { name: "Ollama Cloud", Logo: OllamaLogo, program: "claude" },
  openRouter: { name: "OpenRouter", Logo: OpenRouterLogo, program: "claude" },
  localModel: { name: "Local model", Logo: Cpu, program: "claude" },
  acp: { name: "ACP agent", Logo: Bot, wholeArgs: true },
};

/** `kind`'s entry, or the generic ACP one for a kind this app doesn't know. */
export const kindOf = (kind: string): Kind => kinds[kind] ?? kinds["acp"]!;

/**
 * The logo of the instance a run's `backend` names, on any host whose instances are listed: its
 * kind's, or undefined for a backend no list has yet.
 */
export function instanceLogo(backend: string): Logo | undefined {
  for (const list of lists.values()) {
    const info = list.providers.find((p) => p.instance.id === backend);
    if (info) return kindOf(info.instance.kind).Logo;
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

/** The instances every plxd has, which can be turned off but not removed. */
export const builtInIds = ["claude", "codex", "cursor"];

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

const piCommand = (value: string): ProviderEnvVar[] => [
  { name: "PI_ACP_PI_COMMAND", value, secret: false },
];

/**
 * The Add provider dialog's cards, in order. The model services run Claude Code against an
 * Anthropic-compatible endpoint, set in their variables.
 */
export const presets: Preset[] = [
  { kind: "claude", name: "Claude Code", blurb: "Anthropic's agent" },
  { kind: "codex", name: "Codex", blurb: "OpenAI's agent" },
  { kind: "cursor", name: "Cursor", blurb: "Cursor Agent" },
  {
    kind: "antigravity",
    name: "Antigravity",
    blurb: "Google's agent",
    programHint:
      "The full path to agy_acp_server.par, from the ACP Registry's Google Antigravity archive.",
  },
  { kind: "opencode", name: "OpenCode", blurb: "Any model" },
  { kind: "opencode", name: "OpenCode 2", blurb: "OpenCode 2.x", program: "opencode2" },
  {
    kind: "pi",
    name: "Pi",
    blurb: "A minimal agent",
    args: ["-y", "pi-acp@0.0.34"],
    env: piCommand("pi"),
  },
  {
    kind: "pi",
    name: "Pi (0.x)",
    blurb: "For Pi before 1.0",
    args: ["-y", "pi-acp@0.0.27"],
    env: piCommand("pi-0.73"),
  },
  { kind: "omp", name: "Oh My Pi", blurb: "Pi, extended" },
  { kind: "grokBuild", name: "Grok Build", blurb: "xAI's agent" },
  { kind: "hermes", name: "Hermes Agent", blurb: "Nous Portal" },
  {
    kind: "ollamaCloud",
    name: "Ollama Cloud",
    blurb: "Claude Code on Ollama's models",
    env: anthropicApi("https://ollama.com", { secret: true }),
  },
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
