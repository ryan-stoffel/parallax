import assert from "node:assert/strict";
import test from "node:test";

import { verifyClerkToken, type VerifyOptions } from "../src/verify.ts";

const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** A local Clerk instance: its signing key, served as its JWKS, and a token signer. */
async function instance(issuer: string) {
  const pair = await crypto.subtle.generateKey(
    { ...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "ins_1" };
  let fetches = 0;
  const options: VerifyOptions = {
    issuer,
    clientIds: ["desktop"],
    authorizedParties: ["https://app.parallx.dev"],
    fetch: (async (url: string) => {
      assert.equal(url, `${issuer}/.well-known/jwks.json`);
      fetches++;
      return Response.json({ keys: [jwk] });
    }) as typeof fetch,
  };
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = async (claims: object, header: object = { alg: "RS256", kid: "ins_1" }) => {
    const signed = `${encode(header)}.${encode(claims)}`;
    const signature = await crypto.subtle.sign(
      algorithm,
      pair.privateKey,
      new TextEncoder().encode(signed),
    );
    return `${signed}.${Buffer.from(signature).toString("base64url")}`;
  };
  return { options, sign, fetches: () => fetches };
}

const now = Math.floor(Date.now() / 1000);

test("accepts a session token and the desktop app's OAuth access token", async () => {
  const issuer = "https://clerk.one.test";
  const { options, sign, fetches } = await instance(issuer);
  const session = { iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 60, nbf: now - 1 };
  assert.deepEqual(await verifyClerkToken(await sign(session), options), {
    userId: "user_1",
    sessionId: "sess_1",
  });
  // A native app's session token has no azp.
  assert.deepEqual(
    await verifyClerkToken(await sign({ ...session, azp: "https://app.parallx.dev" }), options),
    { userId: "user_1", sessionId: "sess_1" },
  );
  const oauth = { iss: issuer, sub: "user_1", client_id: "desktop", exp: now + 60 };
  assert.deepEqual(await verifyClerkToken(await sign(oauth), options), {
    userId: "user_1",
    clientId: "desktop",
  });
  // The JWKS was fetched once and cached.
  assert.equal(fetches(), 1);
});

test("refuses forged, expired, foreign, and unknown tokens", async () => {
  const issuer = "https://clerk.two.test";
  const { options, sign } = await instance(issuer);
  const other = await instance(issuer);
  const good = { iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 60 };
  const refuses = async (token: string, message: string) =>
    assert.rejects(verifyClerkToken(token, options), { message });

  await refuses(await other.sign(good), "Bad signature.");
  const [head, , signature] = (await sign(good)).split(".");
  const tampered = Buffer.from(JSON.stringify({ ...good, sub: "user_2" })).toString("base64url");
  await refuses(`${head}.${tampered}.${signature}`, "Bad signature.");
  await refuses(await sign(good, { alg: "none", kid: "ins_1" }), "Unexpected signing algorithm.");
  await refuses(await sign(good, { alg: "RS256", kid: "ins_2" }), "Unknown signing key.");
  await refuses(await sign({ ...good, exp: now - 10 }), "Expired.");
  await refuses(await sign({ ...good, nbf: now + 60 }), "Not valid yet.");
  await refuses(await sign({ ...good, iss: "https://clerk.evil.test" }), "Wrong issuer.");
  await refuses(await sign({ ...good, azp: "https://evil.test" }), "Unexpected origin.");
  await refuses(
    await sign({ iss: issuer, sub: "user_1", client_id: "someone-else", exp: now + 60 }),
    "Unknown OAuth application.",
  );
  await refuses(
    await sign({ iss: issuer, sub: "user_1", exp: now + 60 }),
    "Neither a session nor an OAuth token.",
  );
  await refuses("not.a-jwt", "Not a JWT.");
});
