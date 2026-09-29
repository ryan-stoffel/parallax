// The models each agent CLI offered on 2026-09-28, one entry per model (effort and "fast"
// variants folded in). A placeholder until wispd reports them per host. Sources:
// - Claude Code has no list command; these are what its aliases (opus, fable, sonnet, haiku) resolve to.
// - Codex: ~/.codex/models_cache.json, the entries it lists (visibility "list").
// - Cursor: `cursor-agent models`, in its order.

export type Provider = "Claude" | "Codex" | "Cursor";

export interface Model {
  name: string;
  provider: Provider;
  isNew?: boolean;
}

const claude: Model[] = [
  { name: "Claude Opus 5.5", provider: "Claude", isNew: true },
  { name: "Claude Fable 5.1", provider: "Claude" },
  { name: "Claude Sonnet 5.5", provider: "Claude", isNew: true },
  { name: "Claude Haiku 4.5", provider: "Claude" },
];

const codex: Model[] = [
  { name: "GPT-6 Astra", provider: "Codex", isNew: true },
  { name: "GPT-6 Sol", provider: "Codex", isNew: true },
  { name: "GPT-6 Luna", provider: "Codex", isNew: true },
  { name: "GPT-5.6 Sol", provider: "Codex" },
  { name: "GPT-5.6 Terra", provider: "Codex" },
  { name: "GPT-5.6 Luna", provider: "Codex" },
  { name: "GPT-5.5", provider: "Codex" },
];

const cursor: Model[] = [
  "Auto",
  "Composer 2.5",
  "Codex 5.3",
  "GPT-5.2",
  "Claude Opus 5",
  "GPT-5.6 Sol",
  "Claude Fable 5",
  "Grok 4.5",
  "Gemini 3.7 Flash",
  "Claude Sonnet 5",
  "GPT-5.6 Luna",
  "Grok 4.7",
  "Grok 4.6",
  "Claude Opus 5.5",
  "Claude Opus 4.8",
  "GPT-5.5",
  "Claude Fable 5.1",
  "Gemini 3.8 Flash",
  "Muse Spark 1.3",
  "GPT-5.6 Terra",
  "Claude Sonnet 5.5",
  "Claude Sonnet 4.6",
  "Claude Opus 4.7",
  "GPT-5.4",
  "Claude Opus 4.6",
  "Claude Opus 4.5",
  "Gemini 3.6 Flash",
  "Gemini 3.1 Pro",
  "GPT-5.4 Mini",
  "GPT-5.4 Nano",
  "Claude Sonnet 4.5",
  "GPT-5.1",
  "Gemini 3 Flash",
  "Gemini 3.5 Flash",
  "Claude Sonnet 4",
  "GPT-5 Mini",
  "Kimi K3",
  "Kimi K2.7 Code",
  "GLM 5.2",
].map((name) => ({ name, provider: "Cursor" }));

export const models: Model[] = [...claude, ...codex, ...cursor];
