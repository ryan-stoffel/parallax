// @ts-check
// scripts/bench/probe-clerk.mjs: the relay probe stays on Clerk's development instance, where its
// test account is, while plx defaults to production (PLX-1049, PLX-1457).
import assert from "node:assert/strict";
import test from "node:test";

import { clerkOf } from "../src/signin.mjs";
import { plxdTrusts, probeClerk } from "../../../scripts/bench/probe-clerk.mjs";

const DEV = "https://adjusted-mastodon-8705.clerk.accounts.dev";

test("the probe and the plxd it runs use the development instance, while plx uses production", () => {
  assert.deepEqual(clerkOf({}), { api: "https://clerk.parallax.codes", clientId: "mp9Q72aAbB0LC83O" });
  const clerk = probeClerk({});
  assert.deepEqual(clerk, { api: DEV, clientId: "SXDueyOLOJ2v4Vmq" });
  assert.deepEqual(plxdTrusts(clerk), { PLXD_CLERK_ISSUER: DEV, PLXD_CLERK_CLIENT_IDS: "SXDueyOLOJ2v4Vmq" });
});

test("the environment still names another instance, or a local Clerk", () => {
  const live = { PLX_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsucGFyYWxsYXguY29kZXMk", PLX_CLERK_CLIENT_ID: "mp9Q72aAbB0LC83O" };
  assert.deepEqual(probeClerk(live), { api: "https://clerk.parallax.codes", clientId: "mp9Q72aAbB0LC83O" });
  assert.equal(probeClerk({ PROBE_CLERK_API: "http://127.0.0.1:9" }).api, "http://127.0.0.1:9");
});
