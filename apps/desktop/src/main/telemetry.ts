import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isNightly } from "./updater";

// PostHog's public project key, which only writes events, as the Clerk publishable key in
// account.ts. Empty sends nothing.
const KEY = process.env["PLX_POSTHOG_KEY"] ?? "";
const CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const DAY = 24 * 60 * 60 * 1000;

type Install = { id: string; version: string; platform: string; arch: string };

/**
 * The `app_active` event PostHog counts installs by, or undefined when there is no key or
 * DO_NOT_TRACK is set. It names no person: the id is a random one per install, and PostHog keeps
 * no profile for it.
 */
export function activeEvent(key: string, install: Install, env: NodeJS.ProcessEnv) {
  const dnt = env["DO_NOT_TRACK"];
  if (!key || (dnt && dnt !== "0")) return undefined;
  return {
    api_key: key,
    event: "app_active",
    distinct_id: install.id,
    properties: {
      $process_person_profile: false,
      version: install.version,
      channel: isNightly(install.version) ? "nightly" : "stable",
      os: install.platform,
      arch: install.arch,
    },
  };
}

// The install's id, made on first use and kept in userData.
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
 * per day, week, and month count the installs in use. A packaged app only.
 */
export function startTelemetry() {
  if (!app.isPackaged) return;
  const install = {
    id: installId(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const event = activeEvent(KEY, install, process.env);
  if (!event) return;
  // Best effort: a failed send is the day's count missing this install, not an error to show.
  const send = () =>
    void fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  send();
  setInterval(send, DAY);
}
