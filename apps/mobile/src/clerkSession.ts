// What refreshing the account's session does when Clerk refuses, apart from Account.tsx for the test.

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
