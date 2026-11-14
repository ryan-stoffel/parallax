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
 * The result of `refresh`, or undefined if it failed. A refresh token Clerk refused, such as after
 * signing out everywhere, signs this phone out too. Any other failure leaves it signed in.
 */
export async function refreshOrSignOut<T>(
  refresh: () => Promise<T>,
  signOut: () => Promise<void>,
): Promise<T | undefined> {
  try {
    return await refresh();
  } catch (e) {
    if (e instanceof ClerkError && e.revoked) await signOut();
    return undefined;
  }
}

/** What the sign-in screen says after a session from another Clerk instance is dropped. Shown with `t`. */
export const MOVED = msg("Parallax accounts moved. Sign in again, then set up each computer again.");

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
