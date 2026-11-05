// @ts-check
// Sign-in against a fake Clerk: the loopback and paste flows with PKCE, and the device grant.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import { lineReader } from "../src/cli.mjs";
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
      // Discovery lists no device grant, so a sign-in with no browser pastes.
      if (req.url === "/.well-known/oauth-authorization-server") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token_endpoint: "unused" }));
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

test("an empty line at the code prompt waits for the code, and doesn't use up a try", async () => {
  const fake = await fakeClerk();
  const answers = ["", "  ", "bad-code", "", "good-code"];
  try {
    const { token } = await quietly((printed) =>
      signIn({
        clerk: fake.clerk,
        browser: false,
        codePage: "https://relay.example/connect/code",
        open: async () => assert.fail("no browser opens in the paste flow"),
        prompt: async () => {
          fake.authorize(/(http\S+\/oauth\/authorize\S+)/.exec(printed())?.[1] ?? "");
          return answers.shift() ?? assert.fail("it asked too many times");
        },
      }),
    );
    assert.equal(token, "token-1");
  } finally {
    fake.close();
  }
});

test("end of input at the code prompt, even after an empty line, fails saying no code was entered", async () => {
  const fake = await fakeClerk();
  const input = new PassThrough();
  input.end("\n");
  const ask = lineReader(input, new PassThrough());
  try {
    await assert.rejects(
      quietly(() =>
        signIn({
          clerk: fake.clerk,
          browser: false,
          codePage: "https://relay.example/connect/code",
          open: async () => assert.fail("no browser opens in the paste flow"),
          prompt: ask,
        }),
      ),
      /^Error: No code was entered before input ended\./,
    );
    assert.equal(fake.grants.length, 0);
  } finally {
    fake.close();
  }
});

test("piped codes redeem like pasted ones, however the lines arrive", async () => {
  const fake = await fakeClerk();
  const input = new PassThrough();
  // One chunk, so the reader holds the second code while the first is refused.
  input.end("bad-code\ngood-code\n");
  const ask = lineReader(input, new PassThrough());
  try {
    const { token } = await quietly((printed) =>
      signIn({
        clerk: fake.clerk,
        browser: false,
        codePage: "https://relay.example/connect/code",
        open: async () => assert.fail("no browser opens in the paste flow"),
        prompt: (question) => {
          fake.authorize(/(http\S+\/oauth\/authorize\S+)/.exec(printed())?.[1] ?? "");
          return ask(question);
        },
      }),
    );
    assert.equal(token, "token-1");
    assert.deepEqual(fake.grants.map((grant) => grant.get("code")), ["bad-code", "good-code"]);
  } finally {
    fake.close();
  }
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
          assert.match(await res.text(), /You're signed in/);
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

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CLERK_REFUSAL = "The requested OAuth 2.0 Client does not have the 'urn:ietf:params:oauth:grant-type:device_code' grant.";

/**
 * A fake Clerk with the device grant, per RFC 8628. Time is the fake's `sleep`, so a poll sooner
 * than the current interval counts as `early` and gets `slow_down`, as a real server answers it.
 * Each other poll takes the next of `polls`: an OAuth error, `token`, `drop` (the connection
 * breaks), or `503`. `metadata` and `device` replace what discovery and the device endpoint answer,
 * and a string `metadata` is sent as it is.
 * @param {{ polls?: string[], metadata?: unknown, discoveryStatus?: number, device?: Record<string, unknown>, deviceStatus?: number }} [options]
 */
async function fakeDeviceClerk({ polls = [], metadata, discoveryStatus = 200, device, deviceStatus = 200 } = {}) {
  /** @type {URLSearchParams[]} */
  const deviceRequests = [];
  /** @type {URLSearchParams[]} */
  const tokenRequests = [];
  /** @type {number[]} */
  const waits = [];
  const answer = device ?? {
    device_code: "secret-device-code",
    user_code: "WDJB-MJHT",
    verification_uri: "https://clerk.example/oauth/device",
    verification_uri_complete: "https://clerk.example/oauth/device?user_code=WDJB-MJHT",
    expires_in: 600,
    interval: 2,
  };
  let required = (typeof answer["interval"] === "number" ? answer["interval"] : 5) * 1000;
  let clock = 0;
  let lastPoll = 0;
  let early = 0;
  const server = createServer((req, res) => {
    /** @param {number} status @param {unknown} body */
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(text);
      if (req.url === "/.well-known/oauth-authorization-server") {
        if (typeof metadata === "string") return void res.writeHead(discoveryStatus).end(metadata);
        return json(discoveryStatus, metadata ?? { device_authorization_endpoint: `${api}/oauth/device_authorization`, token_endpoint: `${api}/oauth/token`, grant_types_supported: ["authorization_code", DEVICE_GRANT] });
      }
      if (req.url === "/oauth/device_authorization") {
        deviceRequests.push(params);
        return json(deviceStatus, answer);
      }
      tokenRequests.push(params);
      if (clock - lastPoll < required) {
        early++;
        lastPoll = clock;
        required += 5000;
        return json(400, { error: "slow_down" });
      }
      lastPoll = clock;
      const next = polls.shift() ?? "authorization_pending";
      if (next === "drop") return void req.socket.destroy();
      if (next === "503") return void res.writeHead(503).end("Service Unavailable");
      if (next === "token") return json(200, { access_token: "secret-token", token_type: "bearer", expires_in: 3600 });
      if (next === "slow_down") required += 5000;
      return json(400, { error: next });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const api = `http://127.0.0.1:${port}`;
  return {
    clerk: { api, clientId: "client" },
    deviceRequests,
    tokenRequests,
    waits,
    early: () => early,
    /** @param {number} ms */
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    close: () => server.close(),
  };
}

/**
 * Signs in with no browser against `fake`.
 * @param {Awaited<ReturnType<typeof fakeDeviceClerk>>} fake
 * @param {() => Promise<string>} [prompt]
 */
const signInWithout = (fake, prompt = async () => assert.fail("nothing is pasted in the device grant")) =>
  signIn({
    clerk: fake.clerk,
    browser: false,
    codePage: "https://relay.example/connect/code",
    open: async () => assert.fail("no browser opens without one"),
    prompt,
    sleep: fake.sleep,
  });

test("the device grant prints the link and the short code, polls as RFC 8628 says, and finishes by itself", async () => {
  const fake = await fakeDeviceClerk({ polls: ["authorization_pending", "slow_down", "authorization_pending", "token"] });
  const { token, out } = await quietly(() => signInWithout(fake));
  fake.close();
  assert.equal(token, "secret-token");
  assert.match(out, /https:\/\/clerk\.example\/oauth\/device\?user_code=WDJB-MJHT/);
  assert.match(out, /Code: WDJB-MJHT/);
  assert.doesNotMatch(out, /secret-device-code|secret-token/);
  assert.equal(fake.deviceRequests[0]?.get("client_id"), "client");
  assert.equal(fake.deviceRequests[0]?.get("scope"), "profile email");
  // Two seconds until slow_down adds five for every later poll, and never sooner than the server allows.
  assert.deepEqual(fake.waits, [2000, 2000, 7000, 7000]);
  assert.equal(fake.early(), 0);
  assert.equal(fake.tokenRequests[0]?.get("grant_type"), DEVICE_GRANT);
  assert.equal(fake.tokenRequests[0]?.get("device_code"), "secret-device-code");
  assert.equal(fake.tokenRequests[0]?.get("client_id"), "client");
});

test("with no interval it polls every 5 seconds, and with no complete link it asks to enter the code", async () => {
  const fake = await fakeDeviceClerk({ polls: ["token"], device: { device_code: "secret-device-code", user_code: "WDJB-MJHT", verification_uri: "https://clerk.example/oauth/device", expires_in: 600 } });
  const { token, out } = await quietly(() => signInWithout(fake));
  fake.close();
  assert.equal(token, "secret-token");
  assert.match(out, /enter this code/);
  assert.deepEqual(fake.waits, [5000]);
});

test("a dropped connection or a server error doubles the interval and keeps polling", async () => {
  const fake = await fakeDeviceClerk({ polls: ["drop", "503", "token"] });
  const { token } = await quietly(() => signInWithout(fake));
  fake.close();
  assert.equal(token, "secret-token");
  assert.deepEqual(fake.waits, [2000, 4000, 8000]);
  assert.equal(fake.early(), 0);
});

for (const [error, message] of /** @type {[string, RegExp][]} */ ([
  ["access_denied", /The sign-in was denied/],
  ["expired_token", /The code expired/],
  ["invalid_grant", /Clerk didn't finish the sign-in: invalid_grant/],
])) {
  test(`${error} ends the sign-in rather than falling back to pasting`, async () => {
    const fake = await fakeDeviceClerk({ polls: [error] });
    await assert.rejects(quietly(() => signInWithout(fake)), message);
    fake.close();
    assert.equal(fake.tokenRequests.length, 1);
  });
}

test("polling stops when the code's own lifetime ends, even if Clerk never says so", async () => {
  const fake = await fakeDeviceClerk({ device: { device_code: "secret-device-code", user_code: "WDJB-MJHT", verification_uri: "https://clerk.example/oauth/device", expires_in: 0.02, interval: 60 } });
  await assert.rejects(
    quietly(() =>
      signIn({
        clerk: fake.clerk,
        browser: false,
        codePage: "unused",
        open: async () => false,
        prompt: async () => assert.fail("nothing is pasted in the device grant"),
        sleep: wait,
      }),
    ),
    /The code expired/,
  );
  fake.close();
  assert.equal(fake.tokenRequests.length, 0);
});

test("a wait that wakes after the code's lifetime ends doesn't poll", async () => {
  const fake = await fakeDeviceClerk({ device: { device_code: "secret-device-code", user_code: "WDJB-MJHT", verification_uri: "https://clerk.example/oauth/device", expires_in: 0.02, interval: 0.001 } });
  await assert.rejects(
    quietly(() =>
      signIn({
        clerk: fake.clerk,
        browser: false,
        codePage: "unused",
        open: async () => false,
        prompt: async () => assert.fail("nothing is pasted in the device grant"),
        // Asked for a millisecond, it wakes well past the 20 ms lifetime, as after a laptop's sleep.
        sleep: () => wait(60),
      }),
    ),
    /The code expired/,
  );
  fake.close();
  assert.equal(fake.tokenRequests.length, 0);
});

for (const [name, options] of /** @type {[string, Parameters<typeof fakeDeviceClerk>[0]][]} */ ([
  // What Clerk's development instance answers today: the instance offers the grant, this client doesn't have it.
  ["the device endpoint refuses this OAuth application", { deviceStatus: 400, device: { error: "invalid_grant", error_description: CLERK_REFUSAL } }],
  ["the device endpoint answers RFC 6749's unauthorized_client", { deviceStatus: 400, device: { error: "unauthorized_client" } }],
  ["discovery doesn't list the device endpoint", { metadata: { token_endpoint: "https://clerk.example/oauth/token", grant_types_supported: [DEVICE_GRANT] } }],
  ["discovery doesn't list the grant", { metadata: { device_authorization_endpoint: "https://clerk.example/oauth/device_authorization", token_endpoint: "https://clerk.example/oauth/token", grant_types_supported: ["authorization_code"] } }],
])) {
  test(`the paste flow takes over, with no error shown, when ${name}`, async () => {
    const fake = await fakeDeviceClerk(options);
    let out = "";
    // A prompt that rejects is input ending, so reaching it fails the way the paste flow does.
    await assert.rejects(
      quietly((printed) =>
        signInWithout(fake, async () => {
          out = printed();
          throw new Error("Input ended.");
        }),
      ),
      /No code was entered before input ended/,
    );
    fake.close();
    assert.match(out, /\/oauth\/authorize\?/);
    assert.doesNotMatch(out, /invalid_grant|device_code|Code:|✗/);
    assert.equal(fake.tokenRequests.length, 0);
  });
}

for (const [name, options, message] of /** @type {[string, Parameters<typeof fakeDeviceClerk>[0], RegExp][]} */ ([
  ["refuses the scope", { deviceStatus: 400, device: { error: "invalid_scope", error_description: "The requested scope is invalid" } }, /Clerk didn't start the sign-in: The requested scope is invalid\./],
  ["answers invalid_grant with a server error", { deviceStatus: 500, device: { error: "invalid_grant" } }, /Clerk didn't start the sign-in: invalid_grant\./],
  ["answers without a code", { device: { verification_uri: "https://clerk.example/oauth/device", expires_in: 600 } }, /Clerk didn't start the sign-in: it answered 200\./],
  ["fails its discovery document", { discoveryStatus: 503 }, /its discovery document answered 503/],
  ["sends a discovery document that isn't JSON", { metadata: "<html>Sign in to this network</html>" }, /its discovery document is malformed/],
  ["sends a discovery document that's a list", { metadata: "[]" }, /its discovery document is malformed/],
  ["sends a discovery document with no token endpoint", { metadata: { grant_types_supported: [DEVICE_GRANT] } }, /its discovery document is malformed/],
  ["sends a device endpoint that isn't a string", { metadata: { device_authorization_endpoint: 5, token_endpoint: "https://clerk.example/oauth/token", grant_types_supported: [DEVICE_GRANT] } }, /its discovery document is malformed/],
  ["sends grant types that aren't a list", { metadata: { device_authorization_endpoint: "https://clerk.example/d", token_endpoint: "https://clerk.example/oauth/token", grant_types_supported: DEVICE_GRANT } }, /its discovery document is malformed/],
])) {
  test(`the sign-in stops with the reason, rather than pasting, when Clerk ${name}`, async () => {
    const fake = await fakeDeviceClerk(options);
    await assert.rejects(quietly(() => signInWithout(fake)), message);
    fake.close();
  });
}

test("the sign-in stops with the reason, rather than pasting, when Clerk can't be reached", async () => {
  const fake = await fakeDeviceClerk();
  fake.close();
  await assert.rejects(quietly(() => signInWithout(fake)), /Couldn't reach Clerk/);
});
