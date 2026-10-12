// The phone's side of pairing and DPoP (0065), as `plxd dial` does them in daemon/src/remote.rs:
// SPAKE2 with the code, keyed to the certificate the phone reached, a confirmation each way, and an
// ES256 DPoP key that the session is bound to. Pure, so it's tested without React Native.

import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const Point = ed25519.Point;
const ORDER = Point.Fn.ORDER;
// RustCrypto spake2's Ed25519Group M and N.
const M = Point.fromHex("15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312");
const N = Point.fromHex("f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3");
/** The client's SPAKE2 identity, plxd's `PAKE_CLIENT`. */
const CLIENT = utf8ToBytes("parallax pairing client");

export const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export const fromBase64url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const bigEndian = (bytes: Uint8Array) => BigInt(`0x${bytesToHex(bytes) || "0"}`);

/** A code as typed, without spaces or dashes, in capitals: `7kq-4m2` is `7KQ4M2`. */
export const normalizeCode = (typed: string) => typed.replace(/[\s-]/g, "").toUpperCase();

/** spake2's `hash_to_scalar`: HKDF-SHA256 of the password to 48 bytes, read big-endian, mod l. */
export const passwordScalar = (password: Uint8Array) =>
  bigEndian(hkdf(sha256, password, new Uint8Array(), utf8ToBytes("SPAKE2 pw"), 48)) % ORDER;

/** spake2's key: SHA-256 of the hashed password and ids, both messages, and the shared point. */
export const transcriptKey = (
  password: Uint8Array,
  idA: Uint8Array,
  idB: Uint8Array,
  x: Uint8Array,
  y: Uint8Array,
  k: Uint8Array,
) => sha256(concatBytes(sha256(password), sha256(idA), sha256(idB), x, y, k));

/**
 * Starts SPAKE2 as side A with `code`, for the host whose certificate has `fingerprint`: the
 * message to send, and `finish`, which takes the host's answer and gives the shared key.
 */
export function spake(code: string, fingerprint: string) {
  const password = utf8ToBytes(normalizeCode(code));
  const pw = passwordScalar(password);
  const x = (bigEndian(randomBytes(64)) % (ORDER - 1n)) + 1n;
  const mine = Point.BASE.multiply(x).add(M.multiply(pw)).toBytes();
  return {
    message: concatBytes(Uint8Array.of(0x41), mine),
    finish(answer: Uint8Array): Uint8Array {
      if (answer.length !== 33 || answer[0] !== 0x42) throw new Error("a bad SPAKE2 answer");
      const theirs = answer.slice(1);
      const k = Point.fromBytes(theirs).subtract(N.multiply(pw)).multiply(x).toBytes();
      return transcriptKey(password, CLIENT, utf8ToBytes(fingerprint), mine, theirs, k);
    },
  };
}

/** Proof that `role` holds the SPAKE2 `key`, over the certificate seen and the DPoP thumbprint. */
export const confirmation = (
  key: Uint8Array,
  role: "client" | "host",
  fingerprint: string,
  thumbprint: string,
) => hmac(sha256, key, utf8ToBytes(`${role}\0${fingerprint}\0${thumbprint}`));

/** Whether two byte strings are equal, in time that doesn't depend on where they differ. */
export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** A P-256 DPoP key's public coordinates, in base64url, from its secret. */
function coordinates(secret: Uint8Array) {
  const point = p256.getPublicKey(secret, false);
  return { x: base64url(point.slice(1, 33)), y: base64url(point.slice(33)) };
}

export const newDpopSecret = () => p256.utils.randomSecretKey();

/** The key's JWK thumbprint (RFC 7638), which plxd binds the session to. */
export function thumbprint(secret: Uint8Array): string {
  const { x, y } = coordinates(secret);
  return base64url(sha256(utf8ToBytes(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`)));
}

const encoded = (value: object) => base64url(utf8ToBytes(JSON.stringify(value)));

/** An ES256 DPoP proof (RFC 9449) for a `method` request to `url`, with `token`'s hash if given. */
export function proof(secret: Uint8Array, method: string, url: string, token?: string): string {
  const header = encoded({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: "EC", crv: "P-256", ...coordinates(secret) },
  });
  const claims = encoded({
    htm: method,
    htu: url,
    jti: base64url(randomBytes(16)),
    iat: Math.floor(Date.now() / 1000),
    ...(token && { ath: base64url(sha256(utf8ToBytes(token))) }),
  });
  const input = `${header}.${claims}`;
  return `${input}.${base64url(p256.sign(utf8ToBytes(input), secret))}`;
}
