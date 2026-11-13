import { msg } from "../i18n";
import type { HostHealthResult, ProviderInfo } from "../protocol/generated/protocol";
import type { ComposerContents } from "./drafts";
import { canRun } from "./models";
import { listedProviders, loadProviders } from "./providers";
import { merged, stored } from "./stored";

// The Load Balancer (0101): which computer a new thread's draft starts on. The switch, the
// computers left out, and each computer's preference are this app's, in localStorage, as linked
// providers' list is (0096).

export type Preference = "prefer" | "normal" | "less";

export const preferences: { value: Preference; name: string }[] = [
  { value: "prefer", name: msg("Prefer") },
  { value: "normal", name: msg("Normal") },
  { value: "less", name: msg("Less often") },
];

interface Settings {
  on: boolean;
  /** Each computer's preference, by host id. One not listed is Normal. */
  preferences: Record<string, Preference>;
  /** The computers that don't take part, by host id. Each keeps its preference. */
  leftOut: string[];
}

const key = "parallax.loadBalancer";
const fallback: Settings = { on: false, preferences: {}, leftOut: [] };

export const loadBalancer = stored<Settings>(key, fallback, merged);

// Another window's change, read from what's stored now, so an older event can't undo a newer one.
// Tests load this without a window.
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key !== key) return;
    const raw = localStorage.getItem(key);
    loadBalancer.adopt(merged(raw ? JSON.parse(raw) : null, fallback));
  });

const weights: Record<Preference, number> = { prefer: 100, normal: 50, less: 25 };

/** At or over this share of CPU or memory in use, in percent, a computer is full. */
export const fullAt = 95;

/** What a computer's `host/health` says about how busy it is. */
export type Health = Pick<HostHealthResult, "runningAgents" | "load">;

/** Why a computer can't take a thread. */
export type Why =
  | "left-out"
  | "offline"
  | "no-repository"
  | "named"
  | "no-answer"
  | "needs-update"
  | "no-provider"
  | "full";

/** What a computer's row says for each `Why`. */
export const whyText: Record<Why, string> = {
  "left-out": msg("Left out"),
  offline: msg("Offline"),
  "no-repository": msg("No repository"),
  named: msg("Named in this message"),
  "no-answer": msg("Didn't answer"),
  "needs-update": msg("Needs updating"),
  "no-provider": msg("Provider unavailable"),
  full: msg("Full", { context: "computer at capacity" }),
};

export interface Candidate {
  id: string;
  preference: Preference;
  /** Why it can't take the thread whatever its load: left out, offline, and the like. */
  barred?: Why;
  /** What it answered in time, absent when it didn't. */
  health?: Health;
  providers?: ProviderInfo[];
  /** The provider instance the draft runs on. Absent when the user chose none. */
  provider?: string;
}

/**
 * Whether a computer's providers can run a thread on `provider`, or on any it has when the user
 * chose none, which is what New Thread's model menu would then start on there.
 */
export const canTake = (providers: ProviderInfo[], provider?: string) =>
  providers.some(
    (p) =>
      p.instance.enabled && canRun(p) && (provider === undefined || p.instance.id === provider),
  );

/**
 * A computer's score, `w * cores * (1 - cpu) * (1 - memory) / (1 + runningAgents)`, or why it can't
 * take the thread. Running agents count because a just-started one doesn't show in a CPU sample yet.
 */
export function assess(c: Candidate): { score: number } | { why: Why } {
  if (c.barred) return { why: c.barred };
  if (!c.health) return { why: "no-answer" };
  const load = c.health.load;
  // An older plxd says nothing about its load, so nothing says it has room.
  if (!load?.cores) return { why: "needs-update" };
  if (!c.providers) return { why: "no-answer" };
  if (!canTake(c.providers, c.provider)) return { why: "no-provider" };
  if (load.cpu >= fullAt || load.memory >= fullAt) return { why: "full" };
  const room = load.cores * (1 - load.cpu / 100) * (1 - load.memory / 100);
  return { score: (weights[c.preference] * room) / (1 + c.health.runningAgents) };
}

/** The candidate with the highest score, or undefined when none can take the thread. */
export function pickComputer(candidates: Candidate[]): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const c of candidates) {
    const verdict = assess(c);
    if ("score" in verdict && (!best || verdict.score > best.score))
      best = { id: c.id, score: verdict.score };
  }
  return best?.id;
}

/** How long a computer has to answer before it counts as unanswered. */
export const answerMs = 3000;

const inTime = <T>(work: Promise<T>) =>
  Promise.race([
    work.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, answerMs)),
  ]);

/** `hostId`'s `host/health`, or undefined when it doesn't answer in time. */
async function askHealth(hostId: string): Promise<Health | undefined> {
  const answer = await inTime(window.parallax.request(hostId, "host/health", {}));
  return answer && "result" in answer ? answer.result : undefined;
}

/**
 * `hostId`'s providers: the list this app holds, or else what it answers in time, since a computer
 * can take seconds to probe them. With `fresh` it's asked again in any case, for the next time.
 */
async function askProviders(hostId: string, fresh: boolean) {
  const held = listedProviders(hostId);
  if (held && !fresh) return held.providers;
  const asked = inTime(loadProviders(hostId));
  if (held) return held.providers;
  await asked;
  return listedProviders(hostId)?.providers;
}

/** What `hostId` answers in time, asked together so it takes no longer than one answer. */
export async function askComputer(hostId: string, fresh: boolean) {
  const [health, providers] = await Promise.all([askHealth(hostId), askProviders(hostId, fresh)]);
  return { health, providers };
}

/** The nodes of a composer's document, depth first. */
function* nodesOf(doc: ComposerContents["doc"]): Generator<ComposerContents["doc"]> {
  yield doc;
  for (const child of doc.content ?? []) yield* nodesOf(child);
}

/**
 * What ties a draft to where it is. `pinned` keeps it on this computer: its attached threads are
 * this computer's, and its `@` files were listed here. `named` holds the computers it names, by
 * relay id, whether itself or through a thread on it, which it can't move to, as a computer can't be
 * named from itself. Images and files don't tie it: they stay in this app until the send uploads
 * them to wherever the thread goes.
 */
export function tiesOf(draft: Pick<ComposerContents, "doc" | "threads"> | undefined): {
  pinned?: "threads" | "files";
  named: string[];
} {
  const named: string[] = [];
  let pinned: "threads" | "files" | undefined = draft?.threads.length ? "threads" : undefined;
  for (const node of draft ? nodesOf(draft.doc) : []) {
    const attrs = node.attrs ?? {};
    if (node.type === "threadRef") pinned = "threads";
    else if (node.type === "mention" && String(attrs["token"]).startsWith("@")) pinned ??= "files";
    else if (node.type === "computerRef" || node.type === "remoteThreadRef")
      named.push(String(attrs["computer"]));
  }
  return { pinned, named };
}
