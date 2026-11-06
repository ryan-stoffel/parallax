// What the agents every host has run add up to, by local day: the Account dialog's stats and
// streaks, and Usage's days. Pure, so the phone's Account screen counts them the same way.
import type { AgentRun } from "../protocol/generated/protocol";

/** `at`'s local day, as "2026-10-02". */
export function dayKey(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The local midnight `key`'s day starts at, `key` being a `dayKey`. */
export function dayOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** The local day after `key`'s, by calendar, so a DST change never skips or repeats one. */
function nextDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return dayKey(new Date(y, m - 1, d + 1).getTime());
}

/** What the Account dialog shows of the agents every host has run. */
export interface Activity {
  /** Agents started on each local day, by `dayKey`. Days with none are left out. */
  days: Map<string, number>;
  agents: number;
  /** Pull requests linked to the agents (PLX-318). */
  pullRequests: number;
  /** The most consecutive days with an agent started. */
  longest: number;
  /** The consecutive days with one, ending today, or yesterday while today has none yet. */
  current: number;
  busiest?: { day: string; agents: number };
  /** When the first agent started. */
  since?: number;
  /** Agents started in each local hour of the day, midnight first. */
  hours: number[];
  /** Each backend and model by how many agents ran it, most first. No `model` is the CLI's default. */
  models: { backend: string; model?: string; agents: number }[];
}

/** The activity of `runs`, by local day, with `now` as today. */
export function activityOf(runs: AgentRun[], now: number): Activity {
  const days = new Map<string, number>();
  const models = new Map<string, Activity["models"][number]>();
  const hours = Array.from({ length: 24 }, () => 0);
  let pullRequests = 0;
  let since: number | undefined;
  for (const run of runs) {
    const at = Date.parse(run.createdAt);
    hours[new Date(at).getHours()]!++;
    const day = dayKey(at);
    days.set(day, (days.get(day) ?? 0) + 1);
    pullRequests += run.pullRequests?.length ?? 0;
    since = Math.min(since ?? at, at);
    const id = `${run.backend}/${run.model ?? ""}`;
    const model = models.get(id) ?? { backend: run.backend, model: run.model, agents: 0 };
    model.agents++;
    models.set(id, model);
  }

  let longest = 0;
  let streak = 0;
  let busiest: Activity["busiest"];
  let previous: string | undefined;
  for (const day of [...days.keys()].sort()) {
    streak = previous && day === nextDay(previous) ? streak + 1 : 1;
    longest = Math.max(longest, streak);
    previous = day;
    const agents = days.get(day)!;
    if (!busiest || agents >= busiest.agents) busiest = { day, agents };
  }
  let current = 0;
  const day = new Date(now);
  if (!days.has(dayKey(day.getTime()))) day.setDate(day.getDate() - 1);
  while (days.has(dayKey(day.getTime()))) {
    current++;
    day.setDate(day.getDate() - 1);
  }

  return {
    days,
    agents: runs.length,
    pullRequests,
    longest,
    current,
    busiest,
    since,
    hours,
    models: [...models.values()].sort((a, b) => b.agents - a.agents),
  };
}

/** What a busiest hour of the day, 0 to 23, says about when someone builds. */
export function rhythmOf(hour: number): string {
  if (hour >= 5 && hour < 12) return "Early bird";
  if (hour >= 12 && hour < 18) return "Afternoon builder";
  if (hour >= 18 && hour < 22) return "Evening builder";
  return "Night owl";
}
