/**
 * The OS's locale, for every date, time, number, and name sort the app shows in the user's own
 * format. The app ships only Chromium's en-US locale (PLX-613), which makes Chromium's default
 * en-US on every system, so pass this where the default locale would be (`undefined`, `[]`, or
 * nothing). Undefined, so the default, where there is no bridge, as in tests.
 */
export const locale = (): string | undefined => globalThis.window?.parallax?.locale;

/**
 * Today, Yesterday, or the date of `at` in the user's format, such as "Mon, Oct 20", by local
 * midnights on the calendar, so a daylight-saving day's 23 or 25 hours still count.
 */
export function dayLabel(
  at: number,
  now = Date.now(),
  date: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" },
): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (at >= yesterday.getTime()) return "Yesterday";
  return new Date(at).toLocaleDateString(locale(), date);
}
