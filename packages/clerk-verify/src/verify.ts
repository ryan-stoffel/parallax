// Checks a Parallax account token (0067): a JWT that the Clerk instance signed. Clerk's web and
// Expo SDKs send session tokens, and the desktop app sends its OAuth access token. Both are
// checked against the instance's JWKS, so nothing calls Clerk per request. Only WebCrypto, so it
// runs in Cloudflare Workers, Node, and browsers alike.

export type VerifyOptions = {
  /** The instance's Frontend API URL, which tokens carry as `iss`: `https://clerk.parallax.codes`. */
  issuer: string;
  /** The OAuth applications whose access tokens count, by `client_id`. `[]` accepts none. */
  clientIds: readonly string[];
  /**
   * The origins a browser's session token may come from (its `azp`). `[]` accepts no browser. A
   * session token without `azp`, as Clerk's native SDKs send, passes.
   */
  authorizedParties: readonly string[];
  /**
   * What fetches the JWKS, for tests and for a shared cache in front of it. A response from a
   * cache carries `Age`. A refetch for a key the set lacks passes `cache: "no-store"`, which such a
   * fetch answers from the network.
   */
  fetch?: typeof fetch;
  now?: number;
};

/** Whom a token speaks for: a Clerk user id, and its session or OAuth application. */
export type Verified = { userId: string; sessionId?: string; clientId?: string };

/** The instance's keys couldn't be read, so the token is unchecked, not refused: Clerk is down. */
export class KeysUnavailable extends Error {}

type Claims = Record<string, unknown>;

// `fresh`: read past any cache, so a key it lacks waits for the once-a-minute refetch.
type KeySet = { ttl: number; keys: Map<string, CryptoKey>; fresh: boolean };
// Signing keys by JWKS URL: when each fetch started, and the fetch, which concurrent checks share.
const keySets = new Map<string, { at: number; set: Promise<KeySet> }>();
// A token naming a key the cached set lacks refetches it, at most this often, since Clerk rotates
// keys rarely and a forged kid shouldn't make every request fetch.
const REFETCH_MS = 60_000;
// How long a JWKS is kept when its response sets no `max-age`.
const TTL_MS = 60 * 60_000;
// Clock skew allowed on `exp` and `nbf`.
const SKEW_S = 5;

/**
 * Resolves to whom `token` speaks for, or throws why it doesn't count, or `KeysUnavailable` when
 * the JWKS can't be read and none is cached.
 */
export async function verifyClerkToken(token: string, options: VerifyOptions): Promise<Verified> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Not a JWT.");
  const [head, body, signature] = parts as [string, string, string];
  const header = json(head);
  // Clerk signs with RS256 only. Anything else, "none" included, is refused before any key is used.
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string")
    throw new Error("Unexpected signing algorithm.");

  const key = await signingKey(options, header["kid"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    bytes(signature),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!valid) throw new Error("Bad signature.");

  const claims = json(body);
  const now = (options.now ?? Date.now()) / 1000;
  if (claims["iss"] !== options.issuer) throw new Error("Wrong issuer.");
  if (typeof claims["exp"] !== "number" || claims["exp"] + SKEW_S <= now)
    throw new Error("Expired.");
  if (typeof claims["nbf"] === "number" && claims["nbf"] - SKEW_S > now)
    throw new Error("Not valid yet.");
  // Clerk's session and OAuth tokens carry no `aud`. One that does, such as a JWT template's or an
  // OAuth token for an API's audience, was meant for another service.
  if ("aud" in claims) throw new Error("Meant for another audience.");
  const userId = claims["sub"];
  if (typeof userId !== "string" || !userId) throw new Error("No user.");

  // An OAuth access token names its application (RFC 9068), a session token its session.
  const clientId = claims["client_id"];
  if (typeof clientId === "string") {
    if (!options.clientIds.includes(clientId)) throw new Error("Unknown OAuth application.");
    return { userId, clientId };
  }
  const sessionId = claims["sid"];
  if (typeof sessionId !== "string") throw new Error("Neither a session nor an OAuth token.");
  const azp = claims["azp"];
  if (typeof azp === "string" && !options.authorizedParties.includes(azp))
    throw new Error("Unexpected origin.");
  return { userId, sessionId };
}

/**
 * The instance's key named `kid`, from the cached JWKS, or a fresh one once the cache expires or
 * when it lacks `kid`.
 */
async function signingKey(options: VerifyOptions, kid: string): Promise<CryptoKey> {
  const url = `${options.issuer}/.well-known/jwks.json`;
  const now = options.now ?? Date.now();
  const refetch = (previous?: Promise<KeySet>, noStore = false) => {
    const set = loadKeys(options, url, noStore).catch(async (error: unknown) => {
      // While the JWKS is down, the keys already fetched still count, and it's retried in a
      // minute, so a forged kid can't make good tokens fail.
      if (!previous) throw error;
      return { ttl: REFETCH_MS, keys: (await previous).keys, fresh: true };
    });
    const entry = { at: now, set };
    keySets.set(url, entry);
    // A first fetch that failed isn't cached: the next check tries again.
    set.catch(() => keySets.get(url) === entry && keySets.delete(url));
    return entry;
  };
  let entry = keySets.get(url) ?? refetch();
  const cached = await entry.set;
  let keys = cached.keys;
  // A key the set lacks is refetched at once when the set came from a cache, which may predate a
  // rotation, and otherwise once a minute.
  const missing = !keys.has(kid);
  if (now - entry.at >= cached.ttl || (missing && (!cached.fresh || now - entry.at >= REFETCH_MS))) {
    // Checks that waited on the same set share one refetch.
    const latest = keySets.get(url);
    entry = latest && latest !== entry ? latest : refetch(entry.set, missing);
    ({ keys } = await entry.set);
  }
  const key = keys.get(kid);
  if (!key) throw new Error("Unknown signing key.");
  return key;
}

async function loadKeys(options: VerifyOptions, url: string, noStore: boolean): Promise<KeySet> {
  const res = await (options.fetch ?? fetch)(url, noStore ? { cache: "no-store" } : undefined).catch((error: unknown) => {
    throw new KeysUnavailable(`JWKS fetch failed: ${String(error)}`);
  });
  if (!res.ok) throw new KeysUnavailable(`JWKS answered ${res.status}.`);
  // A cached copy lives out what's left of its max-age, not a new one.
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
  const age = Number(res.headers.get("age")) || 0;
  const ttl = maxAge ? Math.max((Number(maxAge) - age) * 1000, REFETCH_MS) : TTL_MS;
  const imported = await importKeys(await res.text().catch(() => ""));
  return { ttl, keys: imported, fresh: noStore || !res.headers.has("age") };
}

/**
 * The RS256 signing keys in a JWKS body, by `kid`. Throws `KeysUnavailable` when it isn't JSON or
 * holds no usable key, as an HTML error page or an empty set answered 200 would, so that answer
 * is taken for an outage and not for every token being bad.
 */
export async function importKeys(body: string): Promise<Map<string, CryptoKey>> {
  let keys: unknown;
  try {
    keys = (JSON.parse(body) as { keys?: unknown })?.keys;
  } catch {
    throw new KeysUnavailable("JWKS isn't JSON.");
  }
  const imported = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(keys) ? (keys as (JsonWebKey & { kid?: unknown })[]) : []) {
    if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string" || !jwk.kid) continue;
    const key = await crypto.subtle
      .importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
      .catch(() => undefined);
    if (key) imported.set(jwk.kid, key);
  }
  if (!imported.size) throw new KeysUnavailable("JWKS holds no usable key.");
  return imported;
}

function bytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function json(base64url: string): Claims {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes(base64url)));
  } catch {
    throw new Error("Not a JWT.");
  }
  if (!value || typeof value !== "object") throw new Error("Not a JWT.");
  return value as Claims;
}
