/** Bytes as base64url without padding. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url, padded or not, as bytes. Throws on anything else. */
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> {
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}

/** The SHA-256 of `text` in base64url. */
export async function sha256(text: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** 32 random bytes in base64url. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Whether two strings are equal, in time that doesn't depend on where they differ. */
export function same(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** A host's public key, a P-256 JWK. */
export type HostJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

export function isHostJwk(value: unknown): value is HostJwk {
  const jwk = value as HostJwk | null;
  return (
    !!jwk &&
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string"
  );
}

/** The JWK thumbprint (RFC 7638) of `jwk`, which is the host's id on the relay. */
export function thumbprint(jwk: HostJwk): Promise<string> {
  return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

/** Whether `signature` (r || s, base64url) is `jwk`'s ES256 signature of `message`. */
export async function verifyEs256(jwk: HostJwk, signature: string, message: string) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64url(signature),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * Fixed-window counters, one per key: `allow` says whether one more fits in this minute.
 *
 * ponytail: in memory, so an evicted Durable Object starts its windows over. Fine against abuse
 * at this scale; move to the Rate Limiting binding if the relay gets real traffic.
 */
export class Limiter {
  private windows = new Map<string, { start: number; count: number }>();

  allow(key: string, perMinute: number, now = Date.now()): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= perMinute;
  }
}
