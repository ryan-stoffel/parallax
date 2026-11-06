// The kinds of provider instance and what a new one starts as, without their logos: pure, so the
// mobile app shares them. providers.ts adds the logos and re-exports the rest.

import type {
  ProviderEnvVar,
  ProviderInstance,
  ProviderKind,
} from "../protocol/generated/protocol";

/** A kind of provider instance (`ProviderKind`), as Parallax names it. */
export interface KindInfo {
  name: string;
  /** The program plxd runs for it when the instance names none. */
  program?: string;
  /** Whether an instance's `args` are its whole argument list, not added to the kind's own. */
  wholeArgs?: boolean;
}

export const kindInfo = {
  claude: { name: "Claude Code", program: "claude" },
  codex: { name: "Codex", program: "codex" },
  cursor: { name: "Cursor", program: "agent" },
  antigravity: { name: "Antigravity", program: "agy_acp_server.par" },
  opencode: { name: "OpenCode", program: "opencode" },
  pi: { name: "Pi", program: "npx", wholeArgs: true },
  grokBuild: { name: "Grok Build", program: "grok" },
  hermes: { name: "Hermes Agent", program: "hermes" },
  // Hermes Agent's Ollama Cloud provider runs it, out of sight (0070).
  ollamaCloud: { name: "Ollama Cloud" },
  openRouter: { name: "OpenRouter", program: "claude" },
  localModel: { name: "Local model", program: "claude" },
  acp: { name: "ACP agent", wholeArgs: true },
} satisfies Record<string, KindInfo>;

/** `kind`'s entry, or the generic ACP one for a kind this app doesn't know. */
export const kindInfoOf = (kind: string): KindInfo =>
  (kindInfo as Record<string, KindInfo>)[kind] ?? kindInfo.acp;

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
 * endpoint, set in their variables, except Ollama Cloud, which runs on its API key (0070).
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
    blurb: "Cloud models with an API key",
    env: [{ name: "OLLAMA_API_KEY", secret: true }],
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

/** `base`, or "`base` 2", "`base` 3"…: the first that `taken` doesn't have. */
export function unique(base: string, taken: string[], join = " "): string {
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}${join}${n}`;
  return name;
}

/** An instance id from a name: lowercase letters, digits, and `-`. */
export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "provider";
