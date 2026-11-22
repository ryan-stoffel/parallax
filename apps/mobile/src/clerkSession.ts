// What refreshing the account's session does when Clerk refuses, apart from Account.tsx for the test.
import { msg } from "../../desktop/src/i18n";

/** A failed call to Clerk. `revoked` when Clerk refused the refresh token itself. */
export class ClerkError extends Error {
  constructor(
    message: string,
    readonly revoked = false,
  ) {
    super(message);
  }
}

/**
 * How a refresh went: `valid` with its result, `refused` when Clerk refused the refresh token
 * itself, or `unreachable` for anything else, such as no network or a 500.
 */
export type Refreshed<T> = { state: "valid"; value: T } | { state: "refused" } | { state: "unreachable" };

/**
 * Runs `refresh` and says how it went. A refresh token Clerk refused, such as after signing out
 * everywhere, signs this phone out too. Any other failure leaves it signed in.
 */
export async function refreshOrSignOut<T>(
  refresh: () => Promise<T>,
  signOut: () => Promise<void>,
): Promise<Refreshed<T>> {
  try {
    return { state: "valid", value: await refresh() };
  } catch (e) {
    if (!(e instanceof ClerkError && e.revoked)) return { state: "unreachable" };
    await signOut();
    return { state: "refused" };
  }
}

/**
 * How deleting the account on Clerk's page ended:
 * - `deleted`: Clerk took the refresh token before the page and refuses it after.
 * - `kept`: Clerk still takes it, so the page was closed without deleting.
 * - `unconfirmed`: no answer after the page, so the phone stays signed in and the next refresh decides.
 * - `revoked`: Clerk refused the token before the page opened, so this is a sign-out and no deletion.
 * - `unreachable`: no answer before the page, which then isn't opened.
 */
export type Deletion = "deleted" | "kept" | "unconfirmed" | "revoked" | "unreachable";

/**
 * Deletes the account on Clerk's page (`openPage`, which ends when the page is closed), with a
 * fresh refresh (`check`) on each side of it. Clerk answers a deleted user's refresh token and a
 * revoked one alike, `invalid_grant`, and the access token alike too, so the refresh before the
 * page is what tells them apart (PLX-1608).
 */
export async function deleteOnClerk(
  check: () => Promise<Refreshed<unknown>["state"]>,
  openPage: () => Promise<void>,
): Promise<Deletion> {
  const before = await check();
  if (before !== "valid") return before === "refused" ? "revoked" : "unreachable";
  await openPage();
  const after = await check();
  return after === "refused" ? "deleted" : after === "valid" ? "kept" : "unconfirmed";
}

/** What the sign-in screen says after a session from another Clerk instance is dropped. Shown with `t`. */
export const MOVED = msg("Parallax accounts moved. Sign in again.");

/** The development instance's Frontend API, which issued every session saved before the phone kept one. */
const DEVELOPMENT_API = "https://adjusted-mastodon-8705.clerk.accounts.dev";

/**
 * The session the Keychain held as `raw`, if the Clerk instance at `api` issued it. One saved
 * before the phone kept its instance is the development instance's. One from another instance is
 * `moved`: its tokens mean nothing here, so the phone is signed out (PLX-1049).
 */
export function restore<T extends { api: string }>(
  raw: string | null,
  api: string,
): { session: T | null; moved: boolean } {
  if (!raw) return { session: null, moved: false };
  const saved = JSON.parse(raw) as Partial<T>;
  return (saved.api ?? DEVELOPMENT_API) === api
    ? { session: { ...saved, api } as T, moved: false }
    : { session: null, moved: true };
}
