import { useCallback, useEffect, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type {
  PrActParams,
  PrDiffResult,
  PrFailureLogResult,
  PrStatusResult,
  PrWrite,
  PullRequest,
} from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError } from "./errors";
import { icons } from "./icons";
import type { PrActExtra, PrActionMore } from "./pr/model";
import { ago, PrRow } from "./pr/parts";
import { menuItem } from "./ui";

export { lookOf } from "./pr/parts";
export { PullRequestView } from "./pr/PullRequestView";

/** A linked pull request as last read: GitHub's view of it, when, and why a read or action failed. */
export interface Linked {
  pr?: PullRequest;
  at?: string;
  error?: RpcError;
}

/** A thread's linked pull requests (PLX-318), as `usePullRequests` keeps them. */
export interface PullRequests {
  /** Their URLs, oldest first. */
  urls: readonly string[];
  get: (url: string) => Linked | undefined;
  /** Reads one again. */
  refresh: (url: string) => Promise<void>;
  /**
   * Runs `action` on one, keeping what GitHub has after it. Resolves to its error, if it failed.
   * `extra` and PLX-1151's actions go only to a plxd with `prActions` (`actions`).
   */
  act: (url: string, action: PrActionMore, extra?: PrActExtra) => Promise<RpcError | undefined>;
  /** Reads one's unified diff, on a plxd with `prDiff` (PLX-328); absent on an older one. */
  diff?: (url: string) => Promise<{ result?: PrDiffResult; error?: string }>;
  /** Reads `pr/status`: required checks, why it can't merge, unresolved threads. Needs `prWatch`. */
  status?: (url: string) => Promise<{ result?: PrStatusResult; error?: RpcError }>;
  /** Reads `pr/failureLog`: failed checks' error lines, of the check named `check`. Needs `prWatch`. */
  failureLog?: (
    url: string,
    check?: string,
  ) => Promise<{ result?: PrFailureLogResult; error?: RpcError }>;
  /** Comments, reviews, or replies to or resolves a thread, through `pr/write`. Needs `prWatch`. */
  write?: (url: string, write: PrWrite) => Promise<RpcError | undefined>;
  /** Whether plxd takes PLX-1151's actions (`prActions`): re-run, update and delete branch, a method. */
  actions?: boolean;
}

/**
 * Reads each of a run's linked pull requests with `pr/view`, again whenever the list changes, and
 * acts on them with `pr/act`. With `diffs`, reads one's diff with `pr/diff` on demand. On a plxd
 * with `prWatch` it also reads `pr/status` and `pr/failureLog` and writes `pr/write` on demand.
 * Reads are kept by run and URL, so a late answer for another thread lands under that thread. An
 * open one is read again every `POLL_MS`, every `RUNNING_POLL_MS` while its checks run, and when
 * the window regains focus, so its checks, comments, and state follow GitHub's, unless `poll` is
 * false (the sidebar's rows read once). ponytail: every linked one is read on open; read on demand
 * if threads come to link many.
 */
export function usePullRequests(
  hostId: string,
  runId: string | undefined,
  urls: readonly string[],
  diffs = false,
  poll = true,
): PullRequests {
  const [read, setRead] = useState<Readonly<Record<string, Linked>>>({});
  const connection = useConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const watch = !!capabilities && "prWatch" in capabilities;
  const actions = !!capabilities && "prActions" in capabilities;
  const put = useCallback(
    (url: string, next: (prev?: Linked) => Linked) =>
      setRead((all) => ({ ...all, [`${runId} ${url}`]: next(all[`${runId} ${url}`]) })),
    [runId],
  );
  const refresh = useCallback(
    async (url: string) => {
      if (!runId) return;
      const sent = new Date().toISOString();
      const answer = await window.parallax.request(hostId, "pr/view", { runId, url });
      const at = new Date().toISOString();
      // A read kept after this one was sent, such as a merge's answer, is newer than this one.
      const newer = (prev?: Linked) => !!prev?.at && prev.at > sent;
      if ("error" in answer)
        put(url, (prev) => (newer(prev) ? prev! : { ...prev, error: answer.error }));
      else put(url, (prev) => (newer(prev) ? prev! : { pr: answer.result, at }));
    },
    [hostId, runId, put],
  );
  // Kept across renders, so a tab's read isn't restarted by every App render.
  const diff = useCallback(
    async (url: string) => {
      const answer = await window.parallax.request(hostId, "pr/diff", { runId: runId!, url });
      return "error" in answer ? { error: describeError(answer.error) } : { result: answer.result };
    },
    [hostId, runId],
  );
  const status = useCallback(
    async (url: string) => {
      const answer = await window.parallax.request(hostId, "pr/status", { runId: runId!, url });
      return "error" in answer ? { error: answer.error } : { result: answer.result };
    },
    [hostId, runId],
  );
  const failureLog = useCallback(
    async (url: string, check?: string) => {
      const answer = await window.parallax.request(hostId, "pr/failureLog", { url, check });
      return "error" in answer ? { error: answer.error } : { result: answer.result };
    },
    [hostId],
  );
  const write = useCallback(
    async (url: string, w: PrWrite) => {
      const answer = await window.parallax.request(hostId, "pr/write", { url, write: w });
      return "error" in answer ? answer.error : undefined;
    },
    [hostId],
  );
  const key = urls.join("\n");
  useEffect(() => {
    for (const url of key ? key.split("\n") : []) void refresh(url);
  }, [key, refresh]);
  // A merged or closed one won't change much, so only the rest are polled, sooner while checks run.
  const live = urls.filter(
    (url) => !["merged", "closed"].includes(read[`${runId} ${url}`]?.pr?.state ?? ""),
  );
  // Any check, since one failed check makes the rolled-up state failed while others still run. One
  // running longer than STUCK_MS, or still queued, waits for POLL_MS, so a stuck check doesn't
  // spend gh's quota every RUNNING_POLL_MS.
  const running = (url: string) =>
    !!read[`${runId} ${url}`]?.pr?.checks.some(
      (c) =>
        c.state === "pending" && !!c.startedAt && Date.now() - Date.parse(c.startedAt) < STUCK_MS,
    );
  const fast = live.filter(running).join("\n");
  const slow = live.filter((url) => !running(url)).join("\n");
  // A read can take minutes (plxd's gh timeout), so a poll skips one whose last read hasn't settled.
  const polling = useRef(new Set<string>());
  const readAgain = useCallback(
    (list: string) => {
      for (const url of list ? list.split("\n") : []) {
        if (polling.current.has(url)) continue;
        polling.current.add(url);
        void refresh(url).finally(() => polling.current.delete(url));
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!fast || !poll) return;
    const timer = setInterval(() => readAgain(fast), RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [fast, poll, readAgain]);
  useEffect(() => {
    if (!slow || !poll) return;
    const timer = setInterval(() => readAgain(slow), POLL_MS);
    return () => clearInterval(timer);
  }, [slow, poll, readAgain]);
  // Focus reads again only the ones not read within RUNNING_POLL_MS, as of the focus.
  const latest = useRef(read);
  latest.current = read;
  const all = live.join("\n");
  useEffect(() => {
    if (!poll) return;
    const stale = (url: string) => {
      const at = latest.current[`${runId} ${url}`]?.at;
      return !at || Date.now() - Date.parse(at) >= RUNNING_POLL_MS;
    };
    const focus = () => readAgain(all.split("\n").filter(stale).join("\n"));
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [all, poll, readAgain, runId]);
  return {
    urls,
    get: (url) => read[`${runId} ${url}`],
    refresh,
    act: async (url, action, extra) => {
      if (!runId) return;
      // PLX-1151's actions and params aren't in this protocol yet; only a plxd with them gets them.
      const params = { runId, url, action, ...(actions ? extra : {}) } as PrActParams;
      const answer = await window.parallax.request(hostId, "pr/act", params);
      if ("error" in answer) return answer.error;
      put(url, () => ({ pr: answer.result, at: new Date().toISOString() }));
    },
    diff: diffs && runId ? diff : undefined,
    status: watch && runId ? status : undefined,
    failureLog: watch ? failureLog : undefined,
    write: watch ? write : undefined,
    actions,
  };
}

/** How often an open linked pull request is read again. */
export const POLL_MS = 60_000;
/** How often one is read again while its checks run. */
export const RUNNING_POLL_MS = 15_000;
/** How long a check runs before it counts as stuck and its pull request is read every POLL_MS. */
export const STUCK_MS = 30 * 60_000;

/** Which of `urls`, a thread's linked pull requests, `href` goes to, on any of its tabs. */
export const linkedPr = (href: string, urls: readonly string[]) => {
  const pr = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.exec(href)?.[0].toLowerCase();
  return pr ? urls.find((url) => url.toLowerCase() === pr) : undefined;
};

/**
 * The side panel's Pull requests view: the thread's linked pull requests, newest first, each a
 * PrRow opening its own view, over a footer counting the open and linked ones and when they were
 * read.
 */
export function PullRequestList({
  prs,
  onOpen,
}: {
  prs: PullRequests;
  onOpen: (url: string) => void;
}) {
  const read = prs.urls.map((url) => prs.get(url));
  const open = read.filter((r) => r?.pr?.state === "open").length;
  // The oldest read, since the list is only as current as it.
  const synced = read.every((r) => r?.at) ? read.map((r) => r!.at!).sort()[0] : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul aria-label="Pull requests" className="min-h-0 flex-1 overflow-y-auto p-2">
        {[...prs.urls].reverse().map((url) => {
          const { pr, error } = prs.get(url) ?? {};
          return (
            <li key={url}>
              <PrRow url={url} pr={pr} error={error} onOpen={() => onOpen(url)} />
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-2.5 text-meta text-faint-foreground">
        {open} open · {prs.urls.length} linked · {synced ? `synced ${ago(synced)}` : "syncing…"}
      </p>
    </div>
  );
}

/** How many linked pull requests Thread details shows, and how many after Show more. */
const SHOWN = 3;
const EXPANDED = 10;

/**
 * Thread details' list of a thread's linked pull requests, newest first, each a PrRow opening its
 * view. Past the newest `SHOWN`, they wait behind Show N more, which shows up to `EXPANDED`, and
 * past those View all opens the Pull requests view through `onOpen()` (PLX-1086).
 */
export function LinkedPullRequests({
  prs,
  onOpen,
}: {
  prs: PullRequests;
  /** Opens `url`'s view, or without one the Pull requests view. */
  onOpen: (url?: string) => void;
}) {
  const [all, setAll] = useState(false);
  const newest = [...prs.urls].reverse();
  const shown = newest.slice(0, all ? EXPANDED : SHOWN);
  const more = Math.min(newest.length, EXPANDED) - SHOWN;
  if (!newest.length) return null;
  return (
    <>
      <ul aria-label="Linked pull requests" className="flex flex-col gap-px">
        {shown.map((url) => {
          const { pr, error } = prs.get(url) ?? {};
          return (
            <li key={url}>
              <PrRow url={url} pr={pr} error={error} onOpen={() => onOpen(url)} />
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className={`${menuItem} text-faint-foreground hover:text-foreground`}
        >
          <icons.add aria-hidden className={`transition-transform ${all ? "rotate-45" : ""}`} />
          {all ? "Show less" : `Show ${more} more`}
        </button>
      )}
      {all && newest.length > EXPANDED && (
        <button
          type="button"
          onClick={() => onOpen()}
          className={`${menuItem} text-faint-foreground hover:text-foreground`}
        >
          <icons.external aria-hidden />
          View all {newest.length}
        </button>
      )}
    </>
  );
}
