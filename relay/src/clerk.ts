import { verifyClerkToken } from "@parallax/clerk-verify";

import type { Env } from "./index";

/** A comma-separated var as a list. Unset is empty, which accepts none. */
const list = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * The Clerk user id of a Parallax account token (0067): a session token from Clerk's web or Expo
 * SDK, or the desktop app's OAuth access token. Null when it isn't one. The JWKS is
 * `CLERK_JWKS` inline (tests and `wrangler dev`), else fetched from `CLERK_JWKS_URL`, else from
 * the issuer's `/.well-known/jwks.json`.
 */
export async function verifySession(env: Env, token: string): Promise<string | null> {
  // No instance configured: every token is refused, so a deploy can't trust the dev instance.
  if (!env.CLERK_ISSUER) return null;
  const { CLERK_JWKS: inline, CLERK_JWKS_URL: url } = env;
  const jwks: typeof fetch | undefined = inline
    ? async () => new Response(inline)
    : url
      ? () => fetch(url)
      : undefined;
  try {
    const verified = await verifyClerkToken(token, {
      issuer: env.CLERK_ISSUER,
      clientIds: list(env.CLERK_CLIENT_IDS),
      authorizedParties: list(env.CLERK_AUTHORIZED_PARTIES),
      ...(jwks && { fetch: jwks }),
    });
    return verified.userId;
  } catch {
    return null;
  }
}
