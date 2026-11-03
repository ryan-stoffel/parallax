import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { UsageHistoryResult, UsageHour } from "../protocol/generated/protocol";
import { isNightly } from "./updater";

// PostHog's public project key, which only writes events, as the Clerk publishable key in
// account.ts. Project 674045, US Cloud.
const KEY = process.env["PLX_POSTHOG_KEY"] ?? "phc_zyg9cZGNgiwPwkzACNHo34MHkFoGzuqQDjkkvMYfSx4R";
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const BATCH_URL = "https://us.i.posthog.com/batch/";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Install = { id: string; version: string; platform: string; arch: string };

/** Whether to send at all: there is a key and DO_NOT_TRACK is unset or 0. */
export function enabled(key: string, env: NodeJS.ProcessEnv) {
  const dnt = env["DO_NOT_TRACK"];
  return key !== "" && (!dnt || dnt === "0");
}

// An event of this install. It names no person: the id is a random one per install, PostHog keeps
// no profile for it, and it adds no location from the request's IP.
function installEvent(
  key: string,
  install: Install,
  event: string,
  properties: Record<string, string | number> = {},
) {
  return {
    api_key: key,
    event,
    distinct_id: install.id,
    properties: {
      $process_person_profile: false,
      $geoip_disable: true,
      version: install.version,
      channel: isNightly(install.version) ? "nightly" : "stable",
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

/**
 * Sends the whole hours of usage since `since`, an hour's start, and answers the hour to report
 * from next. That stays `since` when plxd can't answer or the send fails, so the hours go again
 * later, and the hour in progress waits until it's over, so each hour goes once.
 */
export async function reportTokens(
  since: string,
  now: number,
  usage: (since: string) => Promise<UsageHistoryResult | undefined>,
  send: (hours: UsageHour[]) => Promise<boolean>,
): Promise<string> {
  const history = await usage(since);
  if (!history) return since;
  const until = hourStart(now);
  const whole = history.hours.filter((h) => Date.parse(h.hour) < Date.parse(until));
  if (whole.length > 0 && !(await send(whole))) return since;
  return until;
}

const hourStart = (now: number) => new Date(now - (now % HOUR)).toISOString();

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

// Where token reporting left off, kept in userData. A first run reports from this hour on, not
// the install's past usage.
function tokensSince(file: string, now: number): string {
  try {
    const since = readFileSync(file, "utf8").trim();
    if (!Number.isNaN(Date.parse(since))) return since;
  } catch {}
  return hourStart(now);
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
 * Sends `app_active` at launch and once a day while the app runs, so PostHog's unique users
 * per day, week, and month count the installs in use, `prompt_sent` for each prompt, and
 * `tokens_used` hourly from the local plxd's `usage`. A packaged app only. Telemetry never keeps
 * the app from starting: without an id it sends nothing. Every send is best effort: a failed one
 * is a count missing, not an error to show.
 */
export function startTelemetry(usage: (since: string) => Promise<UsageHistoryResult | undefined>) {
  if (!app.isPackaged || !enabled(KEY, process.env)) return;
  let id: string;
  try {
    id = installId();
  } catch {
    return;
  }
  const install = {
    id,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const body = JSON.stringify(activeEvent(KEY, install));
  // Checked hourly against the wall clock, which counts time asleep where timers don't, so a
  // laptop left open for days still sends each day.
  let sentAt = 0;
  const tick = () => {
    if (Date.now() - sentAt < DAY) return;
    sentAt = Date.now();
    void post(CAPTURE_URL, body).catch(() => {});
  };
  tick();
  setInterval(tick, HOUR);

  promptSent = (kind) =>
    void post(CAPTURE_URL, JSON.stringify(promptEvent(KEY, install, kind))).catch(() => {});

  const sinceFile = path.join(app.getPath("userData"), "telemetry-tokens-since");
  let since = tokensSince(sinceFile, Date.now());
  const reportHours = async () => {
    since = await reportTokens(since, Date.now(), usage, async (hours) => {
      const batch = tokenEvents(KEY, install, hours);
      const sent = await post(BATCH_URL, JSON.stringify({ api_key: KEY, batch })).catch(() => {});
      return sent?.ok ?? false;
    });
    try {
      writeFileSync(sinceFile, since);
    } catch {}
  };
  // A minute in, since the local plxd isn't connected at launch.
  setTimeout(() => {
    void reportHours();
    setInterval(() => void reportHours(), HOUR);
  }, MINUTE);
}
