import type { AgentPermission, ThreadStartParams } from "../protocol/generated/protocol";

// The models each worker backend's CLI took on 2026-09-29, and what to send for each. A
// placeholder until plxd reports them per host. Sources:
// - Claude Code 2.1.283: the full names its aliases (opus, fable, sonnet, haiku) resolve to in
//   its baked-in model catalog. `--model` takes these as they are.
// - codex-cli 0.157.1: the slugs ~/.codex/models_cache.json lists (visibility "list"), which
//   `-m` takes.
// Cursor has no plxd backend, so it has no models here.

export type Provider = "Claude" | "Codex";

export interface Model {
  /** What the backend's CLI takes, sent as `thread/start`'s `model`. */
  id: string;
  name: string;
  provider: Provider;
  isNew?: boolean;
}

export const models: Model[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "Claude", isNew: true },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "Claude" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "Claude" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Claude" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "Codex", isNew: true },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "Codex" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "Codex" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "Codex" },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "Codex" },
];

/**
 * The plxd backends a thread can run on, by name (`AccountChoice`'s `backend`): whose models
 * they take, the permissions they map, and whether they can run a Project's coordinator. Every
 * backend maps every effort (RYA-97, RYA-38).
 * ponytail: mirrors plxd's `Backend::permissions` and `Capabilities::coordinator`, which it
 * doesn't report yet (RYA-154).
 */
export const backends: Record<
  string,
  { provider: Provider; permissions: AgentPermission[]; coordinator: boolean }
> = {
  claude: {
    provider: "Claude",
    permissions: ["auto", "manual", "edit", "plan", "bypass"],
    coordinator: true,
  },
  codex: { provider: "Codex", permissions: ["edit"], coordinator: false },
};

/** The backend that runs `provider`'s models. */
export const backendOf = (provider: Provider) =>
  Object.keys(backends).find((b) => backends[b]!.provider === provider)!;

/**
 * What a new thread's run asks of its CLI, sent only to a plxd that advertises `runOptions`. An
 * open run's message adds the account it moves to, for another provider's model (`sendAccount`).
 */
export type RunOptions = Pick<ThreadStartParams, "model" | "effort" | "permission" | "account">;
