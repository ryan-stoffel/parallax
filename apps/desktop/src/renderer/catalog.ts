// The models each provider instance offers, the reasoning efforts, and the access levels, as the
// desktop's pickers and the mobile app's composer list them. Pure, so both apps share it; models.ts
// adds this device's choices and the host's providers.

import type { AgentEffort, AgentPermission, ProviderInfo } from "../protocol/generated/protocol";

// The models each worker backend's CLI took on 2026-10-12, and what to send for each. A
// placeholder until plxd reports them per host (PLX-154). Sources:
// - Claude Code 2.1.295: the models its `initialize` control response lists, which T3 Code's
//   catalog matches, plus Opus 4.5. `--model` takes these ids as they are. List a longer id
//   before the shorter one it extends (`claude-opus-5-5`, then `claude-opus-5`): `knownModel`
//   matches a dated id by prefix.
// - codex-cli 0.159.3: the slugs ~/.codex/models_cache.json listed (visibility "list") on
//   2026-10-02, which `-m` takes.
// - Cursor Agent 2026.10.01-14929f9: a model of each family `agent models` listed on 2026-10-01,
//   by the ids `--model` takes, effort included (0036).
// Context windows and fast mode, checked on Claude Code 2.1.295 and codex-cli 0.159.3: Claude's
// models run 1M natively and can be capped at 200K, but Opus 4.6, Opus 4.5, Sonnet 4.6, and
// Haiku 4.5 have 200K only, and only Opus 5.5, Opus 5, and Opus 4.8 have fast mode.
// Codex's catalog gives every model 272K by default and all but GPT-5.5 up to 872K, and every one
// the Fast service tier.
// Cursor's backend maps neither, so its models offer none.
// Release dates are the makers' announcements, except Haiku 5.5's, the day Claude Code took it.
// Each model's `provider` here is the kind of instance that runs it: on an old plxd, the built-in
// instance of that id; on one with `providers`, every instance of that kind (`instanceModels`).

/** A provider instance's id, which is also its backend's name (`AccountChoice`'s `backend`). */
export type Provider = string;

export interface Model {
  /** What the backend's CLI takes, sent as `thread/start`'s `model`. */
  id: string;
  name: string;
  /** The instance that runs it. */
  provider: Provider;
  /** The day its maker released it, `YYYY-MM-DD`, for `isNew`. */
  released?: string;
  /** The context windows it offers, in tokens, its default first. */
  contexts: number[];
  /** Whether it has fast mode. */
  fast?: boolean;
  /** One the user added to its instance (`ProviderInstance.models`). */
  custom?: boolean;
}

const week = 7 * 24 * 60 * 60 * 1000;

/** Whether the pickers mark `model` New: less than a week past its release. */
export const isNew = (model: Model, now = Date.now()) =>
  !!model.released && now - Date.parse(model.released) < week;

const claude1M = [1_000_000, 200_000];
const codex872K = [272_000, 872_000];

/** The built-in catalog, by kind. */
export const models: Model[] = [
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    provider: "claude",
    released: "2026-09-22",
    contexts: claude1M,
    fast: true,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    provider: "claude",
    released: "2026-09-29",
    contexts: claude1M,
  },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "claude", contexts: claude1M },
  { id: "claude-fable-5", name: "Claude Fable 5", provider: "claude", contexts: claude1M },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "claude",
    contexts: claude1M,
    fast: true,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "claude",
    contexts: claude1M,
    fast: true,
  },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "claude", contexts: claude1M },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "claude", contexts: [200_000] },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "claude", contexts: [200_000] },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "claude", contexts: claude1M },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "claude", contexts: [200_000] },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    provider: "claude",
    released: "2026-10-11",
    contexts: claude1M,
  },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "claude", contexts: [200_000] },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    provider: "codex",
    released: "2026-09-29",
    contexts: codex872K,
    fast: true,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "codex",
    released: "2026-09-03",
    contexts: codex872K,
    fast: true,
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    provider: "codex",
    released: "2026-09-22",
    contexts: codex872K,
    fast: true,
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    provider: "codex",
    released: "2026-09-22",
    contexts: codex872K,
    fast: true,
  },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "codex", contexts: codex872K, fast: true },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "codex",
    contexts: codex872K,
    fast: true,
  },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "codex", contexts: codex872K, fast: true },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", contexts: [272_000], fast: true },
  { id: "auto", name: "Auto", provider: "cursor", contexts: [] },
  {
    id: "composer-2.5",
    name: "Composer 2.5",
    provider: "cursor",
    contexts: [],
    released: "2026-05-18",
  },
  { id: "composer-2.5-fast", name: "Composer 2.5 Fast", provider: "cursor", contexts: [] },
  { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5", provider: "cursor", contexts: [] },
  { id: "claude-fable-5-1-high", name: "Claude Fable 5.1", provider: "cursor", contexts: [] },
  { id: "claude-sonnet-5-high", name: "Claude Sonnet 5", provider: "cursor", contexts: [] },
  { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol", provider: "cursor", contexts: [] },
  { id: "gpt-5.5-medium", name: "GPT-5.5", provider: "cursor", contexts: [] },
  { id: "gpt-5.3-codex", name: "Codex 5.3", provider: "cursor", contexts: [] },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", provider: "cursor", contexts: [] },
  { id: "grok-4.7-high", name: "Grok 4.7 High", provider: "cursor", contexts: [] },
  { id: "kimi-k3-max", name: "Kimi K3", provider: "cursor", contexts: [] },
];

/**
 * An instance's models before this device's choices: its kind's built-in catalog, then those plxd
 * found, OpenCode's own without its name for itself, then the user's own, each id once. One that lists none offers its agent's own default,
 * whose empty id sends no `model`.
 */
export function instanceModels(info: ProviderInfo): Model[] {
  const { instance } = info;
  const seen = new Set<string>();
  const listed = [
    ...models.filter((m) => m.provider === instance.kind),
    // OpenCode names its own models (ids `opencode/…`) "opencode/Big Pickle" or "OpenCode
    // Zen/Big Pickle", by version: the picker already says OpenCode.
    ...info.models.map((m) => ({
      ...m,
      name:
        instance.kind === "opencode" && m.id.startsWith("opencode/")
          ? m.name.replace(/^[^/]*\//, "")
          : m.name,
      contexts: [],
    })),
    ...instance.models.map((m) => ({ ...m, contexts: [] })),
  ];
  return (listed.length ? listed : [{ id: "", name: "Default model", contexts: [] }])
    .filter((m) => !seen.has(m.id) && !!seen.add(m.id))
    .map((m) => ({
      ...m,
      provider: instance.id,
      ...(instance.models.some((c) => c.id === m.id) && { custom: true }),
    }));
}

/** Each reasoning effort plxd takes, a line about it, and how fast EffortMenu's stripe moves. */
export const effortLevels: { value: AgentEffort; name: string; blurb: string; speed: number }[] = [
  { value: "low", name: "Low", blurb: "A little thought first", speed: 3 },
  { value: "medium", name: "Medium", blurb: "Thinks it over", speed: 2 },
  { value: "high", name: "High", blurb: "Digs in on the hard parts", speed: 1.3 },
  { value: "xhigh", name: "Extra high", blurb: "Takes its time on the hardest parts", speed: 0.8 },
  { value: "max", name: "Max", blurb: "Everything it's got", speed: 0.4 },
];

// One set of access levels for every provider (0054), from most to least supervised. Each backend
// maps the ones it can honor, and a thread is full Claude Code in every mode (0034). A project's
// worker keeps its sandbox in every mode but Full access (0013). What would prompt comes to the
// chat as approval cards (PLX-196), unless the run can't send them (`manualDenied`).
export const accessLevels: Record<AgentPermission, { label: string; description: string }> = {
  manual: { label: "Supervised", description: "Asks you before commands and file changes." },
  edit: {
    label: "Auto-accept edits",
    description: "Accepts file edits, asks before other actions.",
  },
  auto: {
    label: "Auto",
    description: "The provider approves routine actions for you and blocks the risky ones.",
  },
  plan: { label: "Plan", description: "Explores and writes a plan without editing files." },
  bypass: { label: "Full access", description: "Runs commands and edits files without asking." },
};
