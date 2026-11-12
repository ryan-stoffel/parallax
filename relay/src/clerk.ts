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
 * Clerk's development instance. Its users were registered under their bare user id before the move
 * to production (PLX-1049), so they keep it, and their hosts and devices with it.
 */
export const DEVELOPMENT = "https://adjusted-mastodon-8705.clerk.accounts.dev";

/**
 * The relay's name for user `userId` of the Clerk instance `issuer`, which keys their account and
 * owns their hosts: `<issuer>|<user id>`, so the same user id from another instance is another
 * account. The development instance's stay bare.
 */
export const accountOf = (issuer: string, userId: string) =>
  issuer === DEVELOPMENT ? userId : `${issuer}|${userId}`;

/**
 * The relay account of a Parallax account token (0067), by [`accountOf`]: a session token from
 * Clerk's web or Expo SDK, or the desktop app's OAuth access token. Null when it isn't one.
 * `CLERK_ISSUER` lists the instances whose tokens count, so a move between instances can take
 * both (PLX-1049), and the token's own `iss` picks which one checks it. `CLERK_JWKS_URL` and
 * `CLERK_CLIENT_IDS` list each one's JWKS and OAuth applications in the same order, so a token
 * counts only with its own instance's applications. The JWKS is `CLERK_JWKS` inline (tests and
 * `wrangler dev`), else its `CLERK_JWKS_URL` entry, else its issuer's `/.well-known/jwks.json`.
 * Throws `KeysUnavailable` when those keys can't be read, so an outage isn't taken for a bad token
 * (PLX-1351). The JWKS is read through [`sharedJwks`], and `fetched` hears how long reading it
 * took when this check had to fetch it from Clerk: the keys are otherwise this isolate's or this
 * data center's cached ones.
 */
export async function verifySession(
  env: Env,
  token: string,
  fetched?: (ms: number) => void,
): Promise<string | null> {
  // An issuer that isn't listed is refused before any key is fetched, and with none configured a
  // deploy trusts no instance.
  const issuer = claimedIssuer(token);
  const at = issuer === undefined ? -1 : list(env.CLERK_ISSUER).indexOf(issuer);
  if (issuer === undefined || at < 0) return null;
  const inline = env.CLERK_JWKS;
  const url = list(env.CLERK_JWKS_URL)[at];
  const jwks: typeof fetch = inline
    ? async () => {
        const start = performance.now();
        const response = new Response(inline);
        fetched?.(performance.now() - start);
        return response;
      }
    : (input, init) => sharedJwks(url ?? String(input), init?.cache === "no-store", fetched);
  try {
    const verified = await verifyClerkToken(token, {
      issuer,
      // Several for one instance are separated by spaces.
      clientIds: (list(env.CLERK_CLIENT_IDS)[at] ?? "").split(/\s+/).filter(Boolean),
      authorizedParties: list(env.CLERK_AUTHORIZED_PARTIES),
      fetch: jwks,
    });
    return accountOf(issuer, verified.userId);
  } catch (error) {
    if (error instanceof KeysUnavailable) throw error;
    return null;
  }
}

/**
 * How long a JWKS stays in the shared cache, at most: an hour, or Clerk's `max-age` when shorter.
 * Clerk sends four hours. An hour costs one fetch per data center and instance each hour, and
 * bounds how long a key Clerk removed keeps working, since isolates keep a copy only for what's
 * left of its hour.
 */
const SHARED_TTL_S = 3600;

/**
 * Clerk's JWKS at `url`, from the Cache API, which every isolate in a data center shares, or else
 * fetched and stored there for [`SHARED_TTL_S`]. A stored copy answers with its `Age`, so the
 * isolate keeps it only for the rest of that time and refetches past it for a key it lacks
 * (`noStore`). That refetch replaces the stored copy, so a rotation reaches the data center's
 * other isolates too. `fetched` hears how long a fetch from Clerk took, and only then. A failed
 * fetch or a non-2xx answer is never stored, and the cache failing counts as a miss.
 */
export async function sharedJwks(
  url: string,
  noStore: boolean,
  fetched?: (ms: number) => void,
): Promise<Response> {
  const cache = caches.default;
  if (!noStore) {
    const hit = await cache.match(url).catch(() => undefined);
    if (hit) {
      const headers = new Headers(hit.headers);
      const date = Date.parse(headers.get("date") ?? "");
      headers.set("age", String(Number.isNaN(date) ? 0 : Math.max(0, Math.floor((Date.now() - date) / 1000))));
      return new Response(hit.body, { status: hit.status, headers });
    }
  }
  const start = performance.now();
  let response: Response;
  try {
    response = await fetch(url);
  } finally {
    fetched?.(performance.now() - start);
  }
  if (!response.ok) return response;
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1]);
  const ttl = Number.isNaN(maxAge) ? SHARED_TTL_S : Math.min(maxAge, SHARED_TTL_S);
  const body = await response.arrayBuffer();
  const headers = new Headers({
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": `public, max-age=${ttl}`,
    date: new Date().toUTCString(),
  });
  await cache.put(url, new Response(body, { headers })).catch(() => {});
  return new Response(body, { headers });
}

/**
 * Whether the relay serves the account `user` (from [`verifySession`]). Without
 * `REQUIRE_ALLOWED_USERS`, as on production, it serves everyone and never reads `ALLOWED_USERS`,
 * so that secret landing there by mistake locks nobody out. With it, as on staging (PLX-1495), it
 * serves only the Clerk user ids `ALLOWED_USERS` lists, comma-separated, so a missing or empty
 * list serves nobody and deleting the secret can't open staging.
 */
export function allowedUser(env: Env, user: string): boolean {
  if (!env.REQUIRE_ALLOWED_USERS) return true;
  return list(env.ALLOWED_USERS).includes(user.slice(user.lastIndexOf("|") + 1));
}
