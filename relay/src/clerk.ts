import { KeysUnavailable, verifyClerkToken } from "@parallax/clerk-verify";

import type { Env } from "./index";

/** A comma-separated var as a list. Unset is empty, which accepts none. */
const list = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** The `iss` a JWT claims, unchecked, or undefined when it names none. */
function claimedIssuer(token: string): string | undefined {
  try {
    const body = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const iss: unknown = JSON.parse(atob(body))?.iss;
    return typeof iss === "string" ? iss : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Clerk user id of a Parallax account token (0067): a session token from Clerk's web or Expo
 * SDK, or the desktop app's OAuth access token. Null when it isn't one. `CLERK_ISSUER` lists the
 * instances whose tokens count, so a move between instances can take both (PLX-1049), and the
 * token's own `iss` picks which one checks it. That instance's JWKS is `CLERK_JWKS` inline (tests
 * and `wrangler dev`), else its entry in `CLERK_JWKS_URL`, listed in the same order, else its
 * issuer's `/.well-known/jwks.json`. Throws `KeysUnavailable` when those keys can't be read, so an
 * outage isn't taken for a bad token (PLX-1351).
 */
export async function verifySession(env: Env, token: string): Promise<string | null> {
  // An issuer that isn't listed is refused before any key is fetched, and with none configured a
  // deploy trusts no instance.
  const issuer = claimedIssuer(token);
  const at = issuer === undefined ? -1 : list(env.CLERK_ISSUER).indexOf(issuer);
  if (issuer === undefined || at < 0) return null;
  const inline = env.CLERK_JWKS;
  const url = list(env.CLERK_JWKS_URL)[at];
  const jwks: typeof fetch | undefined = inline
    ? async () => new Response(inline)
    : url
      ? () => fetch(url)
      : undefined;
  try {
    const verified = await verifyClerkToken(token, {
      issuer,
      clientIds: list(env.CLERK_CLIENT_IDS),
      authorizedParties: list(env.CLERK_AUTHORIZED_PARTIES),
      ...(jwks && { fetch: jwks }),
    });
    return verified.userId;
  } catch (error) {
    if (error instanceof KeysUnavailable) throw error;
    return null;
  }
}
