import assert from "node:assert/strict";
import test from "node:test";

import { KeysUnavailable, verifyClerkToken, type VerifyOptions } from "../src/verify.ts";

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
  let down = false;
  const options: VerifyOptions = {
    issuer,
    clientIds: ["desktop"],
    authorizedParties: ["https://app.parallax.codes"],
    fetch: (async (url: string) => {
      assert.equal(url, `${issuer}/.well-known/jwks.json`);
      fetches++;
      if (down) return new Response(null, { status: 503 });
      return Response.json(
        { keys: [jwk] },
        { headers: { "cache-control": "public, max-age=600" } },
      );
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
  return { options, sign, fetches: () => fetches, setDown: (value: boolean) => (down = value) };
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
    await verifyClerkToken(await sign({ ...session, azp: "https://app.parallax.codes" }), options),
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
    await sign({ ...good, aud: "https://api.other.test" }),
    "Meant for another audience.",
  );
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

test("one JWKS fetch at a time; forged kids refetch once a minute; the cache expires", async () => {
  const issuer = "https://clerk.three.test";
  const { options, sign, fetches } = await instance(issuer);
  const good = await sign({ iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 3600 });
  const forged = await sign(
    { iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 3600 },
    {
      alg: "RS256",
      kid: "forged",
    },
  );
  const at = (ms: number) => ({ ...options, now: Date.now() + ms });
  const all = (token: string, ms: number) =>
    Promise.allSettled(Array.from({ length: 50 }, () => verifyClerkToken(token, at(ms))));

  await all(good, 0);
  assert.equal(fetches(), 1);
  await all(forged, 1_000);
  assert.equal(fetches(), 1);
  await all(forged, 61_000);
  assert.equal(fetches(), 2);
  await verifyClerkToken(good, at(62_000));
  assert.equal(fetches(), 2);
  // The response's max-age, 10 minutes, ends the cache.
  await verifyClerkToken(good, at(61_000 + 600_000));
  assert.equal(fetches(), 3);
});

test("a cached copy refetches past the cache for a key it lacks, once, and lives out its age", async () => {
  const issuer = "https://clerk.six.test";
  const { options, sign } = await instance(issuer);
  // A shared cache in front of the JWKS: its copy is 500 s into a 600 s max-age.
  const calls: (RequestInit | undefined)[] = [];
  const cached = {
    ...options,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(init);
      const res = await options.fetch!(url);
      if (init?.cache === "no-store") return res;
      return new Response(res.body, { headers: { "cache-control": "max-age=600", age: "500" } });
    }) as typeof fetch,
  };
  const claims = { iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 3600 };
  const good = await sign(claims);
  const forged = await sign(claims, { alg: "RS256", kid: "forged" });
  const at = (ms: number) => ({ ...cached, now: Date.now() + ms });

  await verifyClerkToken(good, at(0));
  await verifyClerkToken(good, at(99_000));
  assert.deepEqual(calls, [undefined]);
  // The copy had 100 s left, not a new 600.
  await verifyClerkToken(good, at(101_000));
  assert.deepEqual(calls, [undefined, undefined]);
  // A cached set may predate a rotation, so the first unknown kid reads past the cache at once.
  await assert.rejects(verifyClerkToken(forged, at(102_000)), { message: "Unknown signing key." });
  assert.deepEqual(calls, [undefined, undefined, { cache: "no-store" }]);
  // That set is fresh, so more forged kids wait for the minute.
  await assert.rejects(verifyClerkToken(forged, at(103_000)), { message: "Unknown signing key." });
  assert.equal(calls.length, 3);
});

test("while the JWKS is down, a forged kid can't drop the keys already fetched", async () => {
  const issuer = "https://clerk.four.test";
  const { options, sign, fetches, setDown } = await instance(issuer);
  const claims = { iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 3600 };
  const good = await sign(claims);
  const forged = await sign(claims, { alg: "RS256", kid: "forged" });
  const at = (ms: number) => ({ ...options, now: Date.now() + ms });

  await verifyClerkToken(good, at(0));
  setDown(true);
  await assert.rejects(verifyClerkToken(forged, at(61_000)), { message: "Unknown signing key." });
  assert.equal(fetches(), 2);
  assert.deepEqual(await verifyClerkToken(good, at(62_000)), {
    userId: "user_1",
    sessionId: "sess_1",
  });
  // Retried a minute later, not on every check.
  await assert.rejects(verifyClerkToken(forged, at(63_000)), { message: "Unknown signing key." });
  assert.equal(fetches(), 2);
  await verifyClerkToken(good, at(122_000));
  assert.equal(fetches(), 3);
  setDown(false);
});

test("a JWKS that's down with none cached throws KeysUnavailable, unlike a refused token", async () => {
  const issuer = "https://clerk.five.test";
  const { options, sign, setDown } = await instance(issuer);
  const good = await sign({ iss: issuer, sub: "user_1", sid: "sess_1", exp: now + 3600 });
  setDown(true);
  await assert.rejects(verifyClerkToken(good, options), KeysUnavailable);
  const refused = { ...options, fetch: () => Promise.reject(new TypeError("fetch failed")) };
  await assert.rejects(verifyClerkToken(good, refused), KeysUnavailable);
  // A 200 that isn't a JWKS with a usable key is an outage too, not a bad token.
  for (const body of ["<html>Bad gateway</html>", "{}", '{"keys":[]}']) {
    const bad = { ...options, fetch: (async () => new Response(body)) as typeof fetch };
    await assert.rejects(verifyClerkToken(good, bad), KeysUnavailable);
  }
  setDown(false);
});
