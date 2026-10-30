// @ts-check
// Sign-in with PKCE against a fake Clerk token endpoint: the paste flow and the loopback flow.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { canOpenBrowser, codePage, signIn } from "../src/signin.mjs";

/**
 * A fake Clerk whose token endpoint accepts `good-code` with the verifier matching the challenge
 * the test saw, and records each grant.
 */
async function fakeClerk() {
  /** @type {URLSearchParams[]} */
  const grants = [];
  /** @type {string | undefined} */
  let challenge;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const grant = new URLSearchParams(body);
      grants.push(grant);
      const verified = createHash("sha256").update(grant.get("code_verifier") ?? "").digest("base64url") === challenge;
      const ok = req.url === "/oauth/token" && grant.get("code") === "good-code" && verified && grant.get("client_id") === "client";
      res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { access_token: "token-1", expires_in: 3600 } : { error: "invalid_grant", error_description: "The code is invalid" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    clerk: { api: `http://127.0.0.1:${port}`, clientId: "client" },
    grants,
    /** Reads the challenge from an authorize URL, as Clerk would keep it. @param {string} url */
    authorize(url) {
      const params = new URL(url).searchParams;
      challenge = params.get("code_challenge") ?? undefined;
      return params;
    },
    close: () => server.close(),
  };
}

/**
 * Runs `body` with console.log captured, passing it what was printed so far.
 * @param {(printed: () => string) => Promise<string>} body
 */
async function quietly(body) {
  const lines = /** @type {string[]} */ ([]);
  const log = console.log;
  console.log = (/** @type {unknown[]} */ ...args) => void lines.push(args.join(" "));
  try {
    return { token: await body(() => lines.join("\n")), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

test("a browser opens only without --no-browser, outside SSH, and on Linux with a display", () => {
  assert.equal(canOpenBrowser({}, "darwin", false), true);
  assert.equal(canOpenBrowser({}, "win32", false), true);
  assert.equal(canOpenBrowser({}, "darwin", true), false);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: "10.0.0.2 51000 10.0.0.3 22" }, "darwin", false), false);
  assert.equal(canOpenBrowser({}, "linux", false), false);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux", false), true);
  assert.equal(canOpenBrowser({ DISPLAY: ":0", SSH_CONNECTION: "x" }, "linux", false), false);
});

test("the pasted code's redirect is the relay's /connect/code page", () => {
  assert.equal(codePage({}), "https://relay.parallax.codes/connect/code");
  assert.equal(codePage({ PLX_RELAY_URL: "http://127.0.0.1:8787/" }), "http://127.0.0.1:8787/connect/code");
});

test("the paste flow prints the link, reads the code, and redeems it with the PKCE verifier", async () => {
  const clerk = await fakeClerk();
  const page = "https://relay.example/connect/code";
  const answers = ["wrong-code", "  good-code \n"];
  /** @type {string[]} */
  const asked = [];
  /** @type {URLSearchParams | undefined} */
  let params;
  const { token, out } = await quietly((printed) =>
    signIn({
      clerk: clerk.clerk,
      browser: false,
      codePage: page,
      open: async () => assert.fail("no browser opens in the paste flow"),
      // The user opens the printed link, which Clerk reads the challenge from, and pastes.
      prompt: async (question) => {
        asked.push(question);
        params ??= clerk.authorize(/(http\S+\/oauth\/authorize\S+)/.exec(printed())?.[1] ?? "");
        return answers.shift() ?? "";
      },
    }),
  );
  assert.equal(token, "token-1");
  assert.ok(params);
  assert.equal(params.get("redirect_uri"), page);
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.equal(params.get("client_id"), "client");
  // The first, mistyped code was refused and asked for again; the second redeemed.
  assert.equal(asked.length, 2);
  assert.match(out, /✗ Clerk didn't accept the code: The code is invalid\. Try again\./);
  assert.equal(clerk.grants.length, 2);
  assert.equal(clerk.grants[1]?.get("code"), "good-code");
  assert.equal(clerk.grants[1]?.get("redirect_uri"), page);
  assert.equal(clerk.grants[1]?.get("grant_type"), "authorization_code");
  clerk.close();
});

test("the loopback flow takes only the callback with its state, and redeems its code here", async () => {
  const clerk = await fakeClerk();
  const { token, out } = await quietly(() =>
    signIn({
      clerk: clerk.clerk,
      browser: true,
      codePage: "unused",
      prompt: async () => assert.fail("nothing is pasted in the loopback flow"),
      // The test is the browser: a guess without the state is refused, then Clerk's redirect lands.
      open: async (url) => {
        const params = clerk.authorize(url);
        const redirect = new URL(params.get("redirect_uri") ?? "");
        assert.equal(redirect.hostname, "127.0.0.1");
        const guessed = await fetch(`${redirect.href}?code=good-code&state=guess`);
        assert.equal(guessed.status, 403);
        void fetch(`${redirect.href}?code=good-code&state=${params.get("state")}`).then(async (res) => {
          assert.match(await res.text(), /Signed in to Parallax/);
        });
        return true;
      },
    }),
  );
  assert.equal(token, "token-1");
  assert.match(out, /Opened your browser to sign in/);
  assert.equal(clerk.grants.length, 1);
  assert.match(clerk.grants[0]?.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  clerk.close();
});

test("the loopback flow reports Clerk's error", async () => {
  const clerk = await fakeClerk();
  await assert.rejects(
    quietly(() =>
      signIn({
        clerk: clerk.clerk,
        browser: true,
        codePage: "unused",
        prompt: async () => "",
        open: async (url) => {
          const params = new URL(url).searchParams;
          void fetch(`${params.get("redirect_uri")}?error=access_denied&error_description=The+user+denied+access&state=${params.get("state")}`);
          return false;
        },
      }),
    ),
    /The user denied access/,
  );
  clerk.close();
});
