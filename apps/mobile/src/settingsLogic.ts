// What Settings works out without drawing: a computer's settings pages, a new provider instance
// from a preset, a provider's variables after an edit, and an account choice as a picker's value.
import type {
  AccountChoice,
  ProviderEnvVar,
  ProviderInstance,
} from "../../desktop/src/protocol/generated/protocol";
import { kindInfoOf, slug, unique, type Preset } from "../../desktop/src/renderer/providerKinds";

/** A computer's settings pages, as the desktop's Settings names its sections. */
export const pages = {
  providers: "Providers",
  accounts: "Accounts",
  threads: "Threads",
  schedules: "Schedules",
  sourceControl: "Source control",
  computerUse: "Computer use",
  scripts: "Scripts",
  connections: "Connections",
  storage: "Storage",
} as const;

export type SettingsPage = keyof typeof pages;

/** A field's words as arguments, split on spaces. ponytail: no quoting, as the desktop's. */
export const argsOf = (text: string) => text.split(/\s+/).filter(Boolean);

/** Whether a new variable called `name` is a secret by default: its name has KEY, TOKEN, or SECRET. */
export const secretName = (name: string) => /KEY|TOKEN|SECRET/i.test(name);

/** `env` with `name` set to `value`, in its place, or added at the end. */
export function withVar(env: ProviderEnvVar[], name: string, value: string, secret: boolean) {
  const next = { name, value, secret };
  return env.some((v) => v.name === name)
    ? env.map((v) => (v.name === name ? next : v))
    : [...env, next];
}

/**
 * A new instance from an Add provider card, as the desktop's dialog adds one with its defaults:
 * a name and id the host doesn't have yet (a built-in agent takes its kind's id while it's free),
 * and `secrets` filling the card's secret variables.
 */
export function newInstance(
  preset: Preset,
  instances: ProviderInstance[],
  secrets: Record<string, string> = {},
): ProviderInstance {
  const ids = instances.map((i) => i.id);
  const name = unique(
    preset.name,
    instances.map((i) => i.name),
  );
  const builtIn = ["claude", "codex", "cursor"].includes(preset.kind) && !ids.includes(preset.kind);
  const program = preset.program !== kindInfoOf(preset.kind).program ? preset.program : undefined;
  return {
    id: builtIn ? preset.kind : unique(slug(name), ids, "-"),
    kind: preset.kind,
    name,
    enabled: true,
    ...(program && { program }),
    args: preset.args ?? [],
    env: (preset.env ?? []).map((v) => (v.name in secrets ? { ...v, value: secrets[v.name] } : v)),
    models: [],
  };
}

/** An account choice as a picker's value: `subscription:claude`, `key:<id>`. */
export const choiceKey = (choice?: AccountChoice) =>
  !choice ? "" : choice.kind === "subscription" ? `subscription:${choice.backend}` : `key:${choice.id}`;
