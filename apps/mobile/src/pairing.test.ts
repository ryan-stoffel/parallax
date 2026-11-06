import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vitest";

import {
  fromBase64url,
  newDpopSecret,
  passwordScalar,
  proof,
  spake,
  thumbprint,
  transcriptKey,
} from "./pairing";

// RustCrypto spake2 0.4's own vectors (src/lib.rs tests), so the phone and plxd agree.
test("the password scalar and transcript key match spake2's vectors", () => {
  expect(passwordScalar(utf8ToBytes("password"))).toBe(
    3515301705789368674385125653994241092664323519848410154015274772661223168839n,
  );
  const key = transcriptKey(
    ...(["pw", "idA", "idB", "X".repeat(32), "Y".repeat(32), "K".repeat(32)].map(utf8ToBytes) as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
      Uint8Array,
    ]),
  );
  expect(bytesToHex(key)).toBe("d59d9ba920f7092565cec747b08d5b2e981d553ac32fde0f25e5b4a4cfca3efd");
});

// plxd's side B, as spake2 runs it: Y = B*y + N*pw, K = (X - M*pw)*y.
function host(code: string, fingerprint: string, message: Uint8Array) {
  const { Point } = ed25519;
  const M = Point.fromHex("15cfd18e385952982b6a8f8c7854963b58e34388c8e6dae891db756481a02312");
  const N = Point.fromHex("f04f2e7eb734b2a8f8b472eaf9c3c632576ac64aea650b496a8a20ff00e583c3");
  const password = utf8ToBytes(code);
  const pw = passwordScalar(password);
  const y = 12345678901234567890n;
  const theirs = Point.BASE.multiply(y).add(N.multiply(pw)).toBytes();
  const x = message.slice(1);
  const k = Point.fromBytes(x).subtract(M.multiply(pw)).multiply(y).toBytes();
  const id = utf8ToBytes("parallax pairing client");
  const key = transcriptKey(password, id, utf8ToBytes(fingerprint), x, theirs, k);
  return { answer: Uint8Array.of(0x42, ...theirs), key };
}

test("SPAKE2 agrees only on the same code and certificate", () => {
  const phone = spake("7kq-4m2", "ab12");
  const plxd = host("7KQ4M2", "ab12", phone.message);
  expect(phone.message[0]).toBe(0x41);
  expect(bytesToHex(phone.finish(plxd.answer))).toBe(bytesToHex(plxd.key));
  const wrongCode = spake("7KQ4M3", "ab12");
  expect(bytesToHex(wrongCode.finish(host("7KQ4M2", "ab12", wrongCode.message).answer))).not.toBe(
    bytesToHex(host("7KQ4M2", "ab12", wrongCode.message).key),
  );
  const otherHost = spake("7KQ4M2", "cd34");
  const relayed = host("7KQ4M2", "ab12", otherHost.message);
  expect(bytesToHex(otherHost.finish(relayed.answer))).not.toBe(bytesToHex(relayed.key));
});

test("a DPoP proof is an ES256 JWT over its claims, with the token's hash", () => {
  const secret = newDpopSecret();
  const jwt = proof(secret, "POST", "https://10.0.0.2:7341/api/auth/websocket-ticket", "tok");
  const [header, claims, signature] = jwt.split(".") as [string, string, string];
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
  const { jwk } = decode(header);
  expect(decode(header)).toMatchObject({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: "EC", crv: "P-256" },
  });
  expect(decode(claims)).toMatchObject({
    htm: "POST",
    htu: "https://10.0.0.2:7341/api/auth/websocket-ticket",
    ath: btoa(String.fromCharCode(...sha256(utf8ToBytes("tok"))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  });
  const point = Uint8Array.of(4, ...fromBase64url(jwk.x), ...fromBase64url(jwk.y));
  expect(p256.verify(fromBase64url(signature), utf8ToBytes(`${header}.${claims}`), point)).toBe(
    true,
  );
  expect(thumbprint(secret)).toMatch(/^[\w-]{43}$/);
});
