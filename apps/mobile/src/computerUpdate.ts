// Updating a computer's plxd from the phone (PLX-1366, 0066). The phone's own version isn't a plxd
// release, so a computer is behind when its channel has a newer release with a plxd for it. Only
// the user starts an update here. `HostUpdater` then follows it as it does on the desktop, from the
// real connection state, not the shown one, since plxd restarts for longer than the shown state's
// grace.

import { t } from "i18next";
import { useEffect, useState, useSyncExternalStore } from "react";

import { HostUpdater } from "../../desktop/src/main/hostUpdate";
import type { RpcResponse } from "../../desktop/src/preload/bridge";
import type { HostUpdateResult } from "../../desktop/src/protocol/generated/protocol";

/** The part of a GitHub release this reads. */
export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string }[];
}

const RELEASES = "https://api.github.com/repos/ryan-stoffel/parallax/releases";

/** How long the release list is reused: GitHub allows a phone 60 requests an hour. */
const RELEASES_FRESH_MS = 10 * 60_000;

/**
 * The newest version on the channel of `plxd`, as `plx` picks one (releases.mjs), with a plxd for
 * `os` and `arch` as `host/version` names them. A release publishes as soon as its first build is
 * done, so the newest may not have this computer's yet. GitHub lists newest first.
 */
export function newestRelease(releases: Release[], plxd: string, os: string, arch: string): string | undefined {
  const nightly = plxd.endsWith("-nightly");
  const platform = /^macos/i.test(os) ? "mac" : /^windows/i.test(os) ? "win" : "linux";
  const name = (version: string) =>
    `parallax-plxd-${version}-${platform}-${arch === "aarch64" ? "arm64" : "x64"}${platform === "win" ? ".exe" : ""}`;
  return releases
    .filter((r) => !r.draft && (nightly ? r.prerelease && r.tag_name.endsWith("-nightly") : !r.prerelease))
    .map((r) => ({ version: r.tag_name.replace(/^v/, ""), assets: r.assets }))
    .find(({ version, assets }) => assets.some((a) => a.name === name(version)))?.version;
}

const cached = new Map<boolean, { at: number; releases: Promise<Release[]> }>();

/**
 * The channel's latest releases. A stable one can be many nightlies back, past the list's first
 * page, so stable asks for GitHub's latest, a 404 until there's a stable release.
 */
function fetchReleases(nightly: boolean): Promise<Release[]> {
  const kept = cached.get(nightly);
  if (kept && Date.now() - kept.at < RELEASES_FRESH_MS) return kept.releases;
  const url = nightly ? `${RELEASES}?per_page=30` : `${RELEASES}/latest`;
  const releases = fetch(url, { headers: { accept: "application/vnd.github+json" } }).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
    const answer = (await response.json()) as Release[] | Release;
    return Array.isArray(answer) ? answer : [answer];
  });
  cached.set(nightly, { at: Date.now(), releases });
  releases.catch(() => {
    if (cached.get(nightly)?.releases === releases) cached.delete(nightly);
  });
  return releases;
}

/** The version a computer on `plxd` could update to, or undefined when `plxd` is, or it can't tell. */
export async function newestVersion(id: string, plxd: string): Promise<string | undefined> {
  const version = await window.parallax.request(id, "host/version", {});
  if (!("result" in version)) return undefined;
  const releases = await fetchReleases(plxd.endsWith("-nightly"));
  return newestRelease(releases, plxd, version.result.os, version.result.arch);
}

/**
 * The version a computer connected on `plxd` could update to, once known. Undefined `plxd` waits.
 * Without an answer from GitHub or the computer it's unknown, so nothing offers an update. An
 * answer only holds for the `id` and `plxd` it was for, since plxd takes a version from another
 * channel if it's sent one.
 */
export function useNewestVersion(id: string, plxd: string | undefined): string | undefined {
  const [newest, setNewest] = useState<{ id: string; plxd: string; version?: string }>();
  useEffect(() => {
    if (!plxd) return;
    let live = true;
    newestVersion(id, plxd).then(
      (version) => {
        if (live) setNewest({ id, plxd, version });
      },
      () => {
        if (live) setNewest(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [id, plxd]);
  return newest?.id === id && newest.plxd === plxd ? newest.version : undefined;
}

/** Whether two plxd versions are on one channel. plxd itself ignores the channel when it updates. */
export const sameChannel = (a: string, b: string) => a.endsWith("-nightly") === b.endsWith("-nightly");

/**
 * What an update's restart would cut off on `id`, to ask about first, or undefined when `id` says
 * nothing's running. A computer that doesn't say may have threads running.
 */
export async function restartCutsOff(id: string): Promise<string | undefined> {
  const health = await window.parallax.request(id, "host/health", {});
  if (!("result" in health)) return t("any running threads");
  const running = health.result.runningAgents;
  if (running === 0) return undefined;
  return t("{{count}} running threads", { count: running, defaultValue_one: "{{count}} running thread" });
}

/** A computer's update: plxd downloading it, restarting into it, or waiting for its agents. */
export type ComputerUpdate =
  | { stage: "installing" | "restarting"; version: string }
  /** A plxd too old for `now` restarts once its `running` agents finish. */
  | { stage: "waiting"; version: string; running: number }
  | { stage: "failed"; version: string; error: string };

const updates = new Map<string, ComputerUpdate>();
const listeners = new Set<() => void>();

function report(id: string, update?: ComputerUpdate) {
  if (update) updates.set(id, update);
  else updates.delete(id);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** `id`'s update, kept outside the screen so leaving Settings doesn't lose it. */
export const useComputerUpdate = (id: string) => useSyncExternalStore(subscribe, () => updates.get(id));

/** Whether `id` is down for its update, or about to be, so its status says so, not an error. */
export function restarting(id: string, connected: boolean): boolean {
  const stage = updates.get(id)?.stage;
  return stage === "restarting" || (stage === "waiting" && !connected);
}

/** `restarting`, kept current. */
export const useRestarting = (id: string, connected: boolean) =>
  useSyncExternalStore(subscribe, () => restarting(id, connected));

/**
 * Updates `id` to `version` through `send`, which sends `host/update`, restarting at once as
 * Update everything does. It's over when `useComputerUpdate` says it failed or there's none.
 */
export async function updateComputer(
  id: string,
  version: string,
  send: (version: string, now?: boolean) => Promise<RpcResponse<HostUpdateResult>>,
): Promise<void> {
  const running = updates.get(id);
  if (running && running.stage !== "failed") return;
  report(id, { stage: "installing", version });
  let stop = () => {};
  const finish = (update?: ComputerUpdate) => {
    stop();
    report(id, update);
  };
  const updater = new HostUpdater({
    // Only `updateNow` and `onState` run here, so nothing updates by itself.
    packaged: false,
    version,
    channel: "stable",
    kindOf: () => undefined,
    states: () => [],
    runningAgents: async () => undefined,
    installSsh: async () => undefined,
    osOf: async () => undefined,
    update: async (_, target, now) => {
      const answer = await send(target, now);
      if ("result" in answer) {
        const { restart, runningAgents } = answer.result;
        if (restart === "upToDate") finish();
        else report(id, restart === "now" ? { stage: "restarting", version } : { stage: "waiting", version, running: runningAgents });
      }
      return answer;
    },
    emit: (event) => finish(event.status === "failed" ? { stage: "failed", version, error: event.error } : undefined),
  });
  stop = window.parallax.onConnectionState((hostId, state) => {
    if (hostId === id) updater.onState(id, state);
  });
  await updater.updateNow(id, version);
}
