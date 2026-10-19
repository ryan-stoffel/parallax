import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isNightly } from "./updater";

// PostHog's public project key, which only writes events, as the Clerk publishable key in
// account.ts. Project 674045, US Cloud.
const KEY = process.env["PLX_POSTHOG_KEY"] ?? "phc_zyg9cZGNgiwPwkzACNHo34MHkFoGzuqQDjkkvMYfSx4R";
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Install = { id: string; version: string; platform: string; arch: string };

/** Whether to send at all: there is a key and DO_NOT_TRACK is unset or 0. */
export function enabled(key: string, env: NodeJS.ProcessEnv) {
  const dnt = env["DO_NOT_TRACK"];
  return key !== "" && (!dnt || dnt === "0");
}

/**
 * The `app_active` event PostHog counts installs by. It names no person: the id is a random one
 * per install, PostHog keeps no profile for it, and it adds no location from the request's IP.
 */
export function activeEvent(key: string, install: Install) {
  return {
    api_key: key,
    event: "app_active",
    distinct_id: install.id,
    properties: {
      $process_person_profile: false,
      $geoip_disable: true,
      version: install.version,
      channel: isNightly(install.version) ? "nightly" : "stable",
      os: install.platform,
      arch: install.arch,
    },
  };
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

/**
 * Sends `app_active` at launch and once a day while the app runs, so PostHog's unique users
 * per day, week, and month count the installs in use. A packaged app only. Telemetry never keeps
 * the app from starting: without an id it sends nothing.
 */
export function startTelemetry() {
  if (!app.isPackaged || !enabled(KEY, process.env)) return;
  let id: string;
  try {
    id = installId();
  } catch {
    return;
  }
  const body = JSON.stringify(
    activeEvent(KEY, {
      id,
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    }),
  );
  // Checked hourly against the wall clock, which counts time asleep where timers don't, so a
  // laptop left open for days still sends each day. Best effort: a failed send is that day's
  // count missing this install, not an error to show.
  let sentAt = 0;
  const tick = () => {
    if (Date.now() - sentAt < DAY) return;
    sentAt = Date.now();
    void fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  };
  tick();
  setInterval(tick, HOUR);
}
