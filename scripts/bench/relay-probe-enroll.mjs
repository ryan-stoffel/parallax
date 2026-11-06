#!/usr/bin/env node
// Stores a test account's Clerk refresh token as the repo's PROBE_CLERK_REFRESH_TOKEN, for
// relay-probe.mjs (PLX-1360). Set the repo variable PROBE_CLERK_USER_ID to that account's Clerk user
// id first. This signs in with the desktop app's OAuth application and refuses to store a token for
// any other account. The token goes straight to `gh secret set` on its stdin and is never printed.
// Open the link in a private window, so Clerk doesn't reuse your own sign-in, and sign in as the
// test account.
//
//     gh variable set PROBE_CLERK_USER_ID --repo ryan-stoffel/parallax --body <user id>
//     node scripts/bench/relay-probe-enroll.mjs
//
// With --file, the token goes to a new file readable only by you, for t3-compare.mjs --token-file
// on this computer, instead of to GitHub (PLX-1452). Each enroll is its own Clerk session, so a file
// and CI's secret don't rotate each other's token away. It won't overwrite an existing file.
//
//     node scripts/bench/relay-probe-enroll.mjs --file ~/.config/parallax/probe-token
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { authorizeUrl, clerkOf } from "../../packages/plx/src/signin.mjs";

const { values: options } = parseArgs({ options: { file: { type: "string" } } });
const file = options.file && resolve(options.file);
if (file && existsSync(file)) {
  console.error(`${file} already exists. Remove it first to enroll again.`);
  process.exit(1);
}
// Before sign-in, so a missing folder doesn't waste one.
if (file) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

const REPO = "ryan-stoffel/parallax";
// offline_access is what makes Clerk give a refresh token, as for the desktop app.
const SCOPES = "profile email offline_access";
// PROBE_CLERK_API names another Clerk, for trying this against a local one.
const clerk = { ...clerkOf(process.env), ...(process.env.PROBE_CLERK_API && { api: process.env.PROBE_CLERK_API }) };
const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(16).toString("base64url");

const variable = spawnSync("gh", ["variable", "get", "PROBE_CLERK_USER_ID", "--repo", REPO], { encoding: "utf8" });
const expected = variable.status === 0 ? variable.stdout.trim() : "";
if (!expected) {
  console.error("Set the repo variable PROBE_CLERK_USER_ID to the test account's Clerk user id first.");
  process.exit(1);
}

const { promise: called, resolve: answer } = Promise.withResolvers();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) return void response.writeHead(403).end();
  response.writeHead(200, { connection: "close" }).end("Signed in. You can close this window.");
  answer(url.searchParams);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
console.log(`Open this in a private window and sign in as the test account:\n\n  ${authorizeUrl(clerk, { redirectUri, state, verifier, scope: SCOPES })}\n`);
const params = await called;
server.close();
const code = params.get("code");
if (!code) throw new Error(`Clerk sent no code: ${params.get("error_description") ?? params.get("error")}`);

const tokens = await fetch(`${clerk.api}/oauth/token`, {
  method: "POST",
  body: new URLSearchParams({ client_id: clerk.clientId, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }),
  signal: AbortSignal.timeout(15_000),
}).then((res) => res.json());
if (typeof tokens.refresh_token !== "string") throw new Error(`Clerk gave no refresh token: ${tokens.error ?? "its answer had none"}`);

const user = await fetch(`${clerk.api}/oauth/userinfo`, {
  headers: { authorization: `Bearer ${tokens.access_token}` },
  signal: AbortSignal.timeout(15_000),
}).then((res) => res.json());
if (user.sub !== expected) {
  console.error("That sign-in isn't the account PROBE_CLERK_USER_ID names. Nothing stored.");
  process.exit(1);
}
if (file) {
  // wx: only a file this creates, so its 0600 mode holds. relay-probe keeps that mode when it rotates.
  writeFileSync(file, tokens.refresh_token, { mode: 0o600, flag: "wx" });
  console.log(`Stored the test account's refresh token in ${file}.`);
  process.exit(0);
}
const stored = spawnSync("gh", ["secret", "set", "PROBE_CLERK_REFRESH_TOKEN", "--repo", REPO], {
  input: tokens.refresh_token,
  stdio: ["pipe", "inherit", "inherit"],
});
process.exit(stored.status ?? 1);
