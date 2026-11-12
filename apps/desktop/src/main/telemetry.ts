import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { UsageHour, UsageReportClaimResult } from "../protocol/generated/protocol";
import type { Account } from "./account";
import { tokenSubject } from "./accountHosts";
import { isDev, isNightly } from "./updater";

// PostHog's public project key, which only writes events, as the Clerk publishable key in
// account.ts. Project 674045, US Cloud.
const KEY = process.env["PLX_POSTHOG_KEY"] ?? "phc_zyg9cZGNgiwPwkzACNHo34MHkFoGzuqQDjkkvMYfSx4R";
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const BATCH_URL = "https://us.i.posthog.com/batch/";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Install = {
  id: string;
  version: string;
  platform: string;
  arch: string;
  /** The signed-in account's hash (`accountHash`). Absent signed out. */
  account?: string;
};

/** Whether to send at all: there is a key and DO_NOT_TRACK is unset or 0. */
export function enabled(key: string, env: NodeJS.ProcessEnv) {
  const dnt = env["DO_NOT_TRACK"];
  return key !== "" && (!dnt || dnt === "0");
}

/**
 * How usage data knows an account: a one-way hash of its Clerk user id, the same on every device,
 * so one person's devices count as one user.
 */
export function accountHash(userId: string) {
  return createHash("sha256").update(userId).digest("hex");
}

// An event of this install, under its account's hash when signed in and a random id per install
// when not. `signed_in` lets the dashboards count only accounts. Neither names a person: PostHog
// keeps no profile for the id, and it adds no location from the request's IP.
function installEvent(
  key: string,
  install: Install,
  event: string,
  properties: Record<string, string | number | boolean> = {},
) {
  return {
    api_key: key,
    event,
    distinct_id: install.account ?? install.id,
    properties: {
      $process_person_profile: false,
      $geoip_disable: true,
      signed_in: install.account !== undefined,
      version: install.version,
      channel: isDev(install.version) ? "dev" : isNightly(install.version) ? "nightly" : "stable",
      os: install.platform,
      arch: install.arch,
      ...properties,
    },
  };
}

/** The `app_active` event PostHog counts installs by. */
export function activeEvent(key: string, install: Install) {
  return installEvent(key, install, "app_active");
}

/** Whether a request from the app sends a prompt, and to a new thread or an existing one. */
export function promptKind(method: string, params: Record<string, unknown>) {
  if (method === "thread/start" || method === "agent/start" || method === "orchestrator/start")
    return "new_thread";
  if (method === "agent/send") return "follow_up";
  if (method === "orchestration/dispatch" && params["type"] === "message.dispatch")
    return "follow_up";
  return undefined;
}

/** The `prompt_sent` event, which says how many prompts are sent and carries none of their text. */
export function promptEvent(key: string, install: Install, kind: string) {
  return installEvent(key, install, "prompt_sent", { kind });
}

/**
 * The `tokens_used` events for `hours`: one per UTC hour and model, timed at the start of the hour.
 * Accounts are summed away, so no account id leaves the app. `cost_usd` is there only when the
 * vendor reported one.
 */
export function tokenEvents(key: string, install: Install, hours: UsageHour[]) {
  const sums = new Map<string, UsageHour>();
  for (const hour of hours) {
    const id = `${hour.hour} ${hour.model ?? ""}`;
    const sum = sums.get(id);
    if (!sum) {
      sums.set(id, { ...hour });
      continue;
    }
    sum.inputTokens += hour.inputTokens;
    sum.outputTokens += hour.outputTokens;
    sum.cacheReadTokens += hour.cacheReadTokens;
    sum.cacheWriteTokens += hour.cacheWriteTokens;
    if (hour.costUsdMicros !== undefined)
      sum.costUsdMicros = (sum.costUsdMicros ?? 0) + hour.costUsdMicros;
  }
  return [...sums.values()].map((sum) => ({
    ...installEvent(key, install, "tokens_used", {
      model: sum.model ?? "unknown",
      input_tokens: sum.inputTokens,
      output_tokens: sum.outputTokens,
      cache_read_tokens: sum.cacheReadTokens,
      cache_write_tokens: sum.cacheWriteTokens,
      total_tokens: sum.inputTokens + sum.outputTokens + sum.cacheReadTokens + sum.cacheWriteTokens,
      ...(sum.costUsdMicros !== undefined && { cost_usd: sum.costUsdMicros / 1_000_000 }),
    }),
    timestamp: sum.hour,
  }));
}

/** The computers telemetry reports usage from, and their plxd's claims on it (PLX-1301). */
export type HostUsage = {
  hosts(): string[];
  claim(hostId: string): Promise<UsageReportClaimResult | undefined>;
  /** Whether plxd took the claim back. */
  release(hostId: string, claim: UsageReportClaimResult): Promise<boolean>;
};

/**
 * Sends each computer's unreported whole hours. Its plxd keeps the place, so two apps connected to
 * one computer send each hour once. A failed send gives the claim back, so its hours go again later.
 * `unreleased` holds the claims plxd couldn't take back yet, as when the network went with the send,
 * and each is given back before that computer's next claim.
 */
export async function reportTokens(
  usage: HostUsage,
  send: (hours: UsageHour[]) => Promise<boolean>,
  unreleased: Map<string, UsageReportClaimResult>,
): Promise<void> {
  const release = (hostId: string, claim: UsageReportClaimResult) =>
    usage.release(hostId, claim).catch(() => false);
  for (const hostId of usage.hosts()) {
    const held = unreleased.get(hostId);
    if (held && !(await release(hostId, held))) continue;
    unreleased.delete(hostId);
    const claim = await usage.claim(hostId).catch(() => undefined);
    if (!claim || claim.hours.length === 0) continue;
    if (!(await send(claim.hours).catch(() => false)) && !(await release(hostId, claim)))
      unreleased.set(hostId, claim);
  }
}

// The install's id, made on first use and kept in userData. Throws when the file can't be written.
function installId(): string {
  const file = path.join(app.getPath("userData"), "telemetry-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {}
  const id = randomUUID();
  writeFileSync(file, id);
  return id;
}

function post(url: string, body: string) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
}

// Sends a prompt's event, once telemetry has started and is allowed to.
let promptSent: ((kind: string) => void) | undefined;

/** Tells telemetry plxd accepted a request from the app, which may have sent a prompt. */
export function requestAccepted(method: string, params: Record<string, unknown>) {
  const kind = promptKind(method, params);
  if (kind) promptSent?.(kind);
}

/**
 * Sends `app_active` at launch, at each sign-in, and once a day while the app runs, so PostHog's
 * unique users per day, week, and month count the accounts in use, `prompt_sent` for each prompt,
 * and `tokens_used` hourly from `usage`, when signed in, since a signed-out install isn't counted
 * and would use up the hours of an account on the same computer. A packaged app only. Telemetry
 * never keeps the app from starting: without an id it sends nothing. Every send is best effort: a
 * failed one is a count missing, not an error to show.
 */
export function startTelemetry(account: Account, usage: HostUsage) {
  if (!app.isPackaged || !enabled(KEY, process.env)) return;
  let id: string;
  try {
    id = installId();
  } catch {
    return;
  }
  const device = {
    id,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  // Asked at each send, since the account can change while the app runs.
  const install = async (): Promise<Install> => {
    const token = await account.accessToken();
    const user = token && tokenSubject(token);
    return user ? { ...device, account: accountHash(user) } : device;
  };
  // Checked hourly against the wall clock, which counts time asleep where timers don't, so a
  // laptop left open for days still sends each day.
  let sentAt = 0;
  const tick = () => {
    if (Date.now() - sentAt < DAY) return;
    sentAt = Date.now();
    void install()
      .then((each) => post(CAPTURE_URL, JSON.stringify(activeEvent(KEY, each))))
      .catch(() => {});
  };
  tick();
  setInterval(tick, HOUR);
  // Counted now, not at the next launch or a day from now.
  account.onSignIn(() => {
    sentAt = 0;
    tick();
  });

  promptSent = (kind) =>
    void install()
      .then((each) => post(CAPTURE_URL, JSON.stringify(promptEvent(KEY, each, kind))))
      .catch(() => {});

  const unreleased = new Map<string, UsageReportClaimResult>();
  const reportHours = () =>
    install()
      .then(async (each) => {
        if (!each.account) return;
        await reportTokens(
          usage,
          async (hours) => {
            const batch = tokenEvents(KEY, each, hours);
            const sent = await post(BATCH_URL, JSON.stringify({ api_key: KEY, batch }));
            return sent.ok;
          },
          unreleased,
        );
      })
      .catch(() => {});
  // A minute in, since plxd isn't connected at launch.
  setTimeout(() => {
    void reportHours();
    setInterval(() => void reportHours(), HOUR);
  }, MINUTE);
}
