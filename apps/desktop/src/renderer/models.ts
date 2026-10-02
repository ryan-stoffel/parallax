import type { AgentPermission, ThreadStartParams } from "../protocol/generated/protocol";

// The models each worker backend's CLI took on 2026-09-29, and what to send for each. A
// placeholder until plxd reports them per host. Sources:
// - Claude Code 2.1.283: the full names its aliases (opus, fable, sonnet, haiku) resolve to in
//   its baked-in model catalog. `--model` takes these as they are.
// - codex-cli 0.157.1: the slugs ~/.codex/models_cache.json lists (visibility "list"), which
//   `-m` takes.
// - Cursor Agent 2026.10.01-14929f9: a model of each family `agent models` listed on 2026-10-01,
//   by the ids `--model` takes, effort included (0036).
// Context windows and fast mode, checked on Claude Code 2.1.286 and codex-cli 0.159.3: Claude's
// models but Haiku run 1M natively and can be capped at 200K, and only Opus 5.5 has fast mode.
// Codex's catalog gives every model 272K by default and all but GPT-5.5 up to 872K, and every one
// the Fast service tier.
// Cursor's backend maps neither, so its models offer none.

export type Provider = "Claude" | "Codex" | "Cursor";

export interface Model {
  /** What the backend's CLI takes, sent as `thread/start`'s `model`. */
  id: string;
  name: string;
  provider: Provider;
  isNew?: boolean;
  /** The context windows it offers, in tokens, its default first. */
  contexts: number[];
  /** Whether it has fast mode. */
  fast?: boolean;
}

const claude1M = [1_000_000, 200_000];
const codex872K = [272_000, 872_000];

export const models: Model[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "Claude",
    isNew: true,
    contexts: claude1M,
    fast: true,
  },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "Claude", contexts: claude1M },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "Claude", contexts: claude1M },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "Claude", contexts: [200_000] },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "Codex",
    isNew: true,
    contexts: codex872K,
    fast: true,
  },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "Codex", contexts: codex872K, fast: true },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "Codex",
    contexts: codex872K,
    fast: true,
  },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "Codex", contexts: codex872K, fast: true },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "Codex", contexts: [272_000], fast: true },
  { id: "auto", name: "Auto", provider: "Cursor", contexts: [] },
  { id: "composer-2.5", name: "Composer 2.5", provider: "Cursor", contexts: [], isNew: true },
  { id: "composer-2.5-fast", name: "Composer 2.5 Fast", provider: "Cursor", contexts: [] },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5", provider: "Cursor", contexts: [] },
  { id: "claude-fable-5-1-high", name: "Claude Fable 5.1", provider: "Cursor", contexts: [] },
  { id: "claude-sonnet-5-high", name: "Claude Sonnet 5", provider: "Cursor", contexts: [] },
  { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol", provider: "Cursor", contexts: [] },
  { id: "gpt-5.5-medium", name: "GPT-5.5", provider: "Cursor", contexts: [] },
  { id: "gpt-5.3-codex", name: "Codex 5.3", provider: "Cursor", contexts: [] },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", provider: "Cursor", contexts: [] },
  { id: "grok-4.7-high", name: "Grok 4.7 High", provider: "Cursor", contexts: [] },
  { id: "kimi-k3-max", name: "Kimi K3", provider: "Cursor", contexts: [] },
];

/**
 * The plxd backends a thread can run on, by name (`AccountChoice`'s `backend`): whose models
 * they take, the permissions they map, whether they can run a Project's coordinator, and whether
 * they map efforts: every one but Cursor, whose model ids carry the effort (RYA-97, RYA-38, 0036).
 * ponytail: mirrors plxd's `Backend::permissions`, `Backend::efforts`, and
 * `Capabilities::coordinator`, which it doesn't report yet (RYA-154).
 */
export const backends: Record<
  string,
  {
    provider: Provider;
    permissions: AgentPermission[];
    coordinator: boolean;
    efforts?: false;
  }
> = {
  claude: {
    provider: "Claude",
    permissions: ["auto", "manual", "edit", "plan", "bypass"],
    coordinator: true,
  },
  // A Codex thread's modes (0035); Codex's plan mode is experimental, so it has no Plan.
  codex: {
    provider: "Codex",
    permissions: ["auto", "manual", "edit", "bypass"],
    coordinator: false,
  },
  cursor: {
    provider: "Cursor",
    permissions: ["edit", "plan", "bypass"],
    coordinator: false,
    efforts: false,
  },
};

/** The backend that runs `provider`'s models. */
export const backendOf = (provider: Provider) =>
  Object.keys(backends).find((b) => backends[b]!.provider === provider)!;

/**
 * What a new thread's run asks of its CLI, sent only to a plxd that advertises `runOptions`, and
 * its context window and fast mode only to one that advertises `contextAndFast`. An open run's
 * message adds the account it moves to, for another provider's model (`sendAccount`).
 */
export type RunOptions = Pick<
  ThreadStartParams,
  "model" | "effort" | "permission" | "contextWindow" | "fast" | "account"
>;
