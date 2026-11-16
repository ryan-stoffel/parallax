import { createCipheriv, randomBytes } from "node:crypto";

import { expect, test } from "vitest";

import { openSealed } from "./sealed";

/** Seals as plxd does (daemon/src/relay/seal.rs), with Node's own AES-GCM. */
function seal(key: Buffer, aad: string, value: object): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, body]).toString("base64url");
}

test("a sealed push opens only with its computer's key, for its own run and state", () => {
  const key = randomBytes(32);
  const push = { hostId: "relay-id", run: "run-1", state: "done" as const };
  const sealed = seal(key, "relay-id:run-1:done", { title: "Fix the bug", text: "All done" });
  const saved = key.toString("base64url");

  expect(openSealed({ ...push, sealed }, saved)).toEqual({ title: "Fix the bug", text: "All done" });
  expect(openSealed({ ...push, state: "failed", sealed }, saved)).toBeUndefined();
  expect(openSealed({ ...push, sealed }, randomBytes(32).toString("base64url"))).toBeUndefined();
  expect(openSealed({ ...push, sealed: "short" }, saved)).toBeUndefined();
  expect(openSealed(push, saved)).toBeUndefined();
});
