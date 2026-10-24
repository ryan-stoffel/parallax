import { stored } from "./stored";

// The browser's history (PLX-976): every page a browser's own tab visits, shared by every browser
// and kept on this computer, oldest first.

/** A visit: the page, its title once it says, and when, in milliseconds. */
export interface Visit {
  url: string;
  title?: string;
  time: number;
}

// The most visits kept, the newest.
const MAX_VISITS = 5000;

export const browserHistory = stored<Visit[]>("parallax.history", [], (raw, fallback) =>
  Array.isArray(raw)
    ? raw.filter(
        (v): v is Visit =>
          typeof (v as Visit | null)?.url === "string" && typeof (v as Visit).time === "number",
      )
    : fallback,
);

/**
 * `list` with a visit to `url` at `time`. Coming back to the page the last visit was to, as a
 * reload or an in-page step does, only moves that visit's time.
 */
export function visited(list: readonly Visit[], url: string, time: number): Visit[] {
  const last = list.at(-1);
  if (last?.url === url) return [...list.slice(0, -1), { ...last, time }];
  return [...list, { url, time }].slice(-MAX_VISITS);
}

/** `list` with the latest visit to `url` titled `title`, or `list` itself when that changes nothing. */
export function titled(list: readonly Visit[], url: string, title: string): readonly Visit[] {
  const at = list.findLastIndex((v) => v.url === url);
  if (at < 0 || list[at]!.title === title) return list;
  return list.with(at, { ...list[at]!, title });
}

/** The visits whose title or page holds every word of `query`, the newest first. */
export function searchHistory(list: readonly Visit[], query: string): Visit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list
    .filter((v) => words.every((w) => `${v.title ?? ""} ${v.url}`.toLowerCase().includes(w)))
    .reverse();
}

/**
 * Visits, the newest first, grouped by the day they fell on in local time: "Today", "Yesterday",
 * or the date, as Chrome's History heads them.
 */
export function byDay(
  visits: readonly Visit[],
  now = Date.now(),
): { day: string; visits: Visit[] }[] {
  const start = (time: number) => new Date(time).setHours(0, 0, 0, 0);
  const today = start(now);
  const year = new Date(now).getFullYear();
  const groups: { day: string; start: number; visits: Visit[] }[] = [];
  for (const visit of visits) {
    const day = start(visit.time);
    const group = groups.at(-1);
    if (group?.start === day) {
      group.visits.push(visit);
      continue;
    }
    // A day's name once per day, not per visit, as History can hold thousands.
    const name =
      day === today
        ? "Today"
        : day === start(today - 1)
          ? "Yesterday"
          : new Date(day).toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
              ...(new Date(day).getFullYear() !== year && { year: "numeric" }),
            });
    groups.push({ day: name, start: day, visits: [visit] });
  }
  return groups.map(({ day, visits: list }) => ({ day, visits: list }));
}
