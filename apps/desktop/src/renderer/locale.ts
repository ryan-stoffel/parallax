/**
 * The OS's locale, for every date, time, number, and name sort the app shows in the user's own
 * format. The app ships only Chromium's en-US locale (PLX-613), which makes Chromium's default
 * en-US on every system, so pass this where the default locale would be (`undefined`, `[]`, or
 * nothing). Undefined, so the default, where there is no bridge, as in tests.
 */
export const locale = (): string | undefined => globalThis.window?.parallax?.locale;
