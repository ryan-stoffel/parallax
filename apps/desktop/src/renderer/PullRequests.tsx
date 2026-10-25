import {
  ArrowDownUp,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Copy,
  Ellipsis,
  ExternalLink,
  FileDiff,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hammer,
  Link,
  LoaderCircle,
  MessageCircleQuestionMark,
  MessageSquare,
  Plus,
  RefreshCw,
  Tag,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { RpcError } from "../preload/bridge";
import type {
  PrAction,
  PrCheck,
  PrComment,
  PrDiffResult,
  PullRequest,
} from "../protocol/generated/protocol";
import { MarkdownText } from "./AgentChat";
import { githubText, numberOf, shotName } from "./github";
import { diffBand, diffLook } from "./Approval";
import { tabItem } from "./Composer";
import { describeError, githubProblem } from "./errors";
import { dismiss, notify } from "./notifications";
import { Lightbox } from "./Lightbox";
import { locale } from "./locale";
import { behaviorPrefs } from "./prefs";
import { age } from "./Sidebar";
import { ConfirmDialog, menuItem, menuPanel, moveFocus, SetUpGithub } from "./ui";

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
  /** Runs `action` on one, keeping what GitHub has after it. Resolves to its error, if it failed. */
  act: (url: string, action: PrAction) => Promise<RpcError | undefined>;
  /** Reads one's unified diff, on a plxd with `prDiff` (PLX-328); absent on an older one. */
  diff?: (url: string) => Promise<{ result?: PrDiffResult; error?: string }>;
}

/**
 * Reads each of a run's linked pull requests with `pr/view`, again whenever the list changes, and
 * acts on them with `pr/act`. With `diffs`, reads one's diff with `pr/diff` on demand. Reads are kept by run and URL, so a late answer for another thread
 * lands under that thread. An open one is read again every `POLL_MS`, every `RUNNING_POLL_MS`
 * while its checks run, and when the window regains focus, so its checks, comments, and state
 * follow GitHub's, unless `poll` is false (the sidebar's rows read once). ponytail: every linked
 * one is read on open; read on demand if threads come to link many.
 */
export function usePullRequests(
  hostId: string,
  runId: string | undefined,
  urls: readonly string[],
  diffs = false,
  poll = true,
): PullRequests {
  const [read, setRead] = useState<Readonly<Record<string, Linked>>>({});
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
  // Kept across renders, so the Code tab's read isn't restarted by every App render.
  const diff = useCallback(
    async (url: string) => {
      const answer = await window.parallax.request(hostId, "pr/diff", { runId: runId!, url });
      return "error" in answer ? { error: describeError(answer.error) } : { result: answer.result };
    },
    [hostId, runId],
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
    act: async (url, action) => {
      if (!runId) return;
      const answer = await window.parallax.request(hostId, "pr/act", { runId, url, action });
      if ("error" in answer) return answer.error;
      put(url, () => ({ pr: answer.result, at: new Date().toISOString() }));
    },
    diff: diffs && runId ? diff : undefined,
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
const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? "";

/** How a pull request's state looks: open green, draft gray, merged purple, closed red. */
export function lookOf(pr?: PullRequest): { Icon: LucideIcon; color: string; label?: string } {
  if (pr?.state === "merged")
    return { Icon: GitMerge, color: "text-project-violet", label: "Merged" };
  if (pr?.state === "closed")
    return { Icon: GitPullRequestClosed, color: "text-danger", label: "Closed" };
  if (pr?.state === "open" && pr.draft)
    return { Icon: GitPullRequestDraft, color: "text-faint-foreground", label: "Draft" };
  if (pr?.state === "open") return { Icon: GitPullRequest, color: "text-added", label: "Open" };
  // Not read yet, or a state this version doesn't know.
  return { Icon: GitPullRequest, color: "text-muted-foreground" };
}

const ago = (time: string) => (age(time) === "now" ? "just now" : `${age(time)} ago`);

/**
 * The composer tab's link to a thread's pull requests: the latest one's number, colored by its
 * state, and `+k` for the others. It opens that one's view, or with others, the list.
 */
export function PullRequestChip({
  prs,
  onOpen,
}: {
  prs: PullRequests;
  onOpen: (url?: string) => void;
}) {
  const latest = prs.urls.at(-1);
  if (!latest) return null;
  const pr = prs.get(latest)?.pr;
  const { Icon, color } = lookOf(pr);
  const more = prs.urls.length - 1;
  return (
    <button
      type="button"
      title={pr ? `#${pr.number} ${pr.title}` : latest}
      onClick={() => onOpen(more > 0 ? undefined : latest)}
      className={`${tabItem} shrink-0 rounded-md hover:bg-hover`}
    >
      <span className={`flex items-center gap-1 ${color}`}>
        <Icon aria-hidden />#{numberOf(latest)}
      </span>
      {more > 0 && <span>+{more}</span>}
    </button>
  );
}

/**
 * The side panel's Pull requests view: the thread's linked pull requests, newest first, each
 * opening its own view, over a footer counting the open and linked ones and when they were read.
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
          const { Icon, color } = lookOf(pr);
          return (
            <li key={url}>
              <button
                type="button"
                onClick={() => onOpen(url)}
                className="flex w-full gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover"
              >
                <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${color}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-body">
                    <span className="shrink-0 text-faint-foreground">#{numberOf(url)}</span>
                    <span className="min-w-0 flex-1 truncate">{pr?.title ?? repoOf(url)}</span>
                    {pr && (
                      <span className="shrink-0 font-mono text-meta">
                        <span className="text-added">+{pr.additions.toLocaleString(locale())}</span>{" "}
                        <span className="text-danger">
                          −{pr.deletions.toLocaleString(locale())}
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-baseline gap-2 text-meta text-faint-foreground">
                    {pr ? (
                      <>
                        <span className="shrink-0">{pr.author}</span>
                        <span className="min-w-0 truncate">{pr.repo}</span>
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {pr.headBranch} → {pr.baseBranch}
                        </span>
                        <span className="shrink-0">{ago(pr.updatedAt)}</span>
                      </>
                    ) : (
                      <span className={error ? "text-danger" : ""}>
                        {error ? describeError(error) : "Loading…"}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-2.5 text-body text-faint-foreground">
        {open} open · {prs.urls.length} linked · {synced ? `synced ${ago(synced)}` : "syncing…"}
      </p>
    </div>
  );
}

/**
 * Thread details' list of a thread's linked pull requests, newest first: each one's state, title,
 * number, and checks, opening its view. Past the newest, they wait behind Show N more.
 */
export function LinkedPullRequests({
  prs,
  onOpen,
}: {
  prs: PullRequests;
  onOpen: (url: string) => void;
}) {
  const [all, setAll] = useState(false);
  const newest = [...prs.urls].reverse();
  const more = newest.length - 1;
  if (!newest.length) return null;
  return (
    <>
      <ul aria-label="Linked pull requests">
        {(all ? newest : newest.slice(0, 1)).map((url) => {
          const { pr, error } = prs.get(url) ?? {};
          const { Icon, color } = lookOf(pr);
          const checks =
            pr && (checkIcons[pr.checksState ?? ""] ?? (pr.checks.length ? noCheck : undefined));
          return (
            <li key={url}>
              <button
                type="button"
                onClick={() => onOpen(url)}
                title={pr ? `#${pr.number} ${pr.title}` : url}
                className={`${menuItem} items-start`}
              >
                <Icon aria-hidden className={color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{pr?.title ?? repoOf(url)}</span>
                  <span className="mt-0.5 flex items-center gap-2 text-meta text-faint-foreground">
                    #{numberOf(url)}
                    {checks && (
                      <checks.Icon
                        aria-label={`Checks ${pr.checksState === "pending" ? "running" : (pr.checksState ?? "skipped")}`}
                        className={checks.color}
                      />
                    )}
                    {!pr && (
                      <span className={error ? "truncate text-danger" : ""}>
                        {error ? describeError(error) : "Loading…"}
                      </span>
                    )}
                  </span>
                </span>
              </button>
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
          <Plus aria-hidden className={all ? "rotate-45" : ""} />
          {all ? "Show less" : `Show ${more} more`}
        </button>
      )}
    </>
  );
}

/** A check's icon and its classes: a running one spins until it ends. */
const checkIcons: Record<string, { Icon: LucideIcon; color: string }> = {
  passed: { Icon: CircleCheck, color: "text-added" },
  failed: { Icon: CircleX, color: "text-danger" },
  pending: { Icon: LoaderCircle, color: "animate-spin text-warning" },
};
/** A check, or all of them, neither passed, failed, nor running: skipped, or none. */
const noCheck = { Icon: CircleMinus, color: "text-faint-foreground" };

/** A span of time in a few words: `45s`, `3m 12s`, or `1h 4m`. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Where a check is, in words: queued, running for how long, or how it ended and how long it took. */
function checkStatus(c: PrCheck, now = Date.now()): string {
  const started = c.startedAt ? Date.parse(c.startedAt) : undefined;
  const took = started && span((c.completedAt ? Date.parse(c.completedAt) : now) - started);
  if (c.state === "pending") return took ? `Running for ${took}` : "Queued";
  const ended = (c.conclusion ?? c.state).replaceAll("_", " ");
  return `${ended[0]!.toUpperCase()}${ended.slice(1)}${took ? ` in ${took}` : ""}`;
}

// Failed first, then running, then the rest, as GitHub lists them.
const checkOrder: Record<string, number> = { failed: 0, pending: 1, passed: 2 };

/**
 * One check of the checks popover: its icon, spinning while it runs, its workflow and name, and its
 * status. Hovering or focusing it shows Details and Open on GitHub; Details unfolds when it started,
 * how long it took, and, for a failed one, Fix in this thread.
 */
function CheckRow({
  check,
  now,
  onOpen,
  onFix,
}: {
  check: PrCheck;
  now: number;
  onOpen: (url: string) => void;
  onFix: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, color } = checkIcons[check.state] ?? noCheck;
  const action =
    "-my-0.5 rounded-md px-1.5 py-0.5 text-meta text-muted-foreground hover:bg-hover hover:text-foreground";
  const detail = "flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-hover";
  return (
    <li className="group/check">
      <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-body group-hover/check:bg-hover group-focus-within/check:bg-hover">
        <Icon aria-label={check.state} className={`size-4 shrink-0 ${color}`} />
        <span className="min-w-0 flex-1 truncate" title={check.name}>
          {check.workflow && <span className="text-faint-foreground">{check.workflow} / </span>}
          {check.name}
        </span>
        <span className="shrink-0 text-meta text-faint-foreground">{checkStatus(check, now)}</span>
        <span className="hidden shrink-0 items-center group-focus-within/check:flex group-hover/check:flex">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={action}
          >
            Details
          </button>
          {check.url && (
            <button
              type="button"
              title="Open on GitHub"
              aria-label={`Open ${check.name} on GitHub`}
              onClick={() => onOpen(check.url!)}
              className={`${action} grid place-items-center`}
            >
              <ArrowUpRight aria-hidden className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="mx-2 mt-1 mb-2 rounded-lg border border-border px-3 py-2.5 text-body">
          <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1">
            {check.workflow && (
              <>
                <dt className="text-faint-foreground">Workflow</dt>
                <dd>{check.workflow}</dd>
              </>
            )}
            <dt className="text-faint-foreground">Status</dt>
            <dd>{checkStatus(check, now)}</dd>
            {check.startedAt && (
              <>
                <dt className="text-faint-foreground">Started</dt>
                <dd>{ago(check.startedAt)}</dd>
              </>
            )}
            {check.completedAt && (
              <>
                <dt className="text-faint-foreground">Finished</dt>
                <dd>{ago(check.completedAt)}</dd>
              </>
            )}
          </dl>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {check.url && (
              <>
                <button type="button" onClick={() => onOpen(check.url!)} className={detail}>
                  <ArrowUpRight aria-hidden className="size-3.5" />
                  Open on GitHub
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(check.url!)}
                  className={detail}
                >
                  <Link aria-hidden className="size-3.5" />
                  Copy link
                </button>
              </>
            )}
            {check.state === "failed" && (
              <button type="button" onClick={onFix} className={detail}>
                <Hammer aria-hidden className="size-3.5" />
                Fix in this thread
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The checks popover's list: a count of each state over every check, failed first. Running times tick. */
function ChecksList({
  checks,
  onOpen,
  onFix,
}: {
  checks: readonly PrCheck[];
  onOpen: (url: string) => void;
  onFix: (check: PrCheck) => void;
}) {
  const running = checks.some((c) => c.state === "pending");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const count = (state: string) => checks.filter((c) => c.state === state).length;
  const counts = [
    [count("failed"), "failed"],
    [count("pending"), "running"],
    [count("passed"), "passed"],
    [count("skipped"), "skipped"],
  ].filter(([n]) => n);
  // A check's URL, workflow, and name, counted, since statuses can share all three.
  const seen = new Map<string, number>();
  const keyOf = (c: PrCheck) => {
    const key = `${c.url} ${c.workflow} ${c.name}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${key} ${n}`;
  };
  const sorted = [...checks].sort(
    (a, b) => (checkOrder[a.state] ?? 3) - (checkOrder[b.state] ?? 3),
  );
  return (
    <>
      <p className="px-2 pt-1 pb-2 text-body font-medium">
        {counts.map(([n, what]) => `${n} ${what}`).join(" · ") || "No checks"}
      </p>
      <ul className="flex max-h-[60vh] flex-col overflow-y-auto">
        {sorted.map((c) => (
          <CheckRow key={keyOf(c)} check={c} now={now} onOpen={onOpen} onFix={() => onFix(c)} />
        ))}
      </ul>
    </>
  );
}

/** All of a pull request's checks in a few words, as its Summary tab shows them. */
function checksOf(pr: PullRequest): { Icon: LucideIcon; color: string; text: string } {
  const total = pr.checks.length;
  const count = (state: PrCheck["state"]) => pr.checks.filter((c) => c.state === state).length;
  const text =
    pr.checksState === "failed"
      ? `${count("failed")} of ${total} failed`
      : pr.checksState === "pending"
        ? `${count("pending")} of ${total} running`
        : pr.checksState === "passed"
          ? "All checks passed"
          : total
            ? "Checks skipped"
            : "No checks";
  return { ...(checkIcons[pr.checksState ?? ""] ?? noCheck), text };
}

const FILE_KINDS = ["Code", "Tests", "Mocks", "Docs", "Generated"] as const;

/** What a changed file is, by its path, for the header's lines-changed breakdown. */
export function fileKind(path: string): (typeof FILE_KINDS)[number] {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|\/)generated\//i.test(path) || /(\.lockb?|-lock\.(json|yaml)|^go\.sum)$/.test(name))
    return "Generated";
  if (/(^|\/)(__mocks__|mocks?|fixtures?|samples|testdata)\//i.test(path) || /mock/i.test(name))
    return "Mocks";
  if (/\.(md|mdx|rst)$/i.test(name) || /(^|\/)docs\//i.test(path)) return "Docs";
  if (/(^|\/)(tests?|__tests__|e2e|spec)\//i.test(path) || /[._-](test|spec)\.\w+$/i.test(name))
    return "Tests";
  return "Code";
}

/**
 * A pull request's lines added and removed by kind of file, each kind with any. Other is the lines
 * in files GitHub didn't list, so the rows add up to its totals.
 */
export function lineBreakdown(
  pr: PullRequest,
): { kind: string; additions: number; deletions: number }[] {
  const rows = [...FILE_KINDS, "Other"].map((kind) => ({ kind, additions: 0, deletions: 0 }));
  for (const f of pr.files ?? []) {
    const row = rows[FILE_KINDS.indexOf(fileKind(f.path))]!;
    row.additions += f.additions;
    row.deletions += f.deletions;
  }
  const other = rows.at(-1)!;
  other.additions = Math.max(0, pr.additions - rows.reduce((n, r) => n + r.additions, 0));
  other.deletions = Math.max(0, pr.deletions - rows.reduce((n, r) => n + r.deletions, 0));
  return rows.filter((r) => r.additions || r.deletions);
}

/** A menu row: its icon, label, and an optional line under it. */
function Item({
  Icon,
  label,
  hint,
  danger,
  disabled,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`${menuItem} ${hint ? "items-start" : ""} ${danger ? "text-danger" : ""} disabled:opacity-50 disabled:hover:bg-transparent [&_svg]:size-4`}
    >
      <span className="grid h-5 place-items-center">
        <Icon aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block leading-5">{label}</span>
        {hint && <span className="block text-meta text-faint-foreground">{hint}</span>}
      </span>
    </button>
  );
}

const separator = <div role="separator" className="-mx-1 my-1 h-px bg-border" />;

/** A section of the Summary tab whose heading folds it. */
function Section({
  title,
  open,
  onToggle,
  aside,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="mt-4">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex items-center gap-1 rounded-md py-0.5 text-body text-muted-foreground hover:text-foreground"
        >
          {title}
          <Chevron aria-hidden className="size-3.5" />
        </button>
        {aside}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

// A pull request's description and comments are GitHub's, not the agent's, so their GitHub-hosted
// images load (MarkdownText's `images`), unlike a transcript's remote ones, and open in the
// Lightbox when clicked. Any other image stays a link with its alt text. ponytail: a private
// repository's attachments need GitHub's sign-in and show broken; proxy them through `gh` if that
// matters.

// ponytail: "long" by length, not rendered height; measure it if this cuts the wrong ones.
const isLong = (c: PrComment) => c.body.length > 600 || c.body.split("\n").length > 12;

/** A comment's card: its author, age, and Markdown, folded when long until `onUnfold`. */
function CommentCard({
  c,
  folded,
  onUnfold,
}: {
  c: PrComment;
  folded: boolean;
  onUnfold: () => void;
}) {
  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <p className="text-body">
        <span className="font-medium">{c.author}</span>{" "}
        <span className="text-faint-foreground">{ago(c.createdAt)}</span>
      </p>
      <div
        className={`mt-2 ${folded ? "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" : ""}`}
      >
        <MarkdownText text={githubText(c.body)} images="github" />
      </div>
      {folded && (
        <button
          type="button"
          onClick={onUnfold}
          className="mt-2 text-body text-muted-foreground hover:text-foreground"
        >
          Show full comment
        </button>
      )}
    </div>
  );
}

/** A line of a diff: added, removed, context, or a hunk's `@@` header, with its line numbers. */
export interface DiffLine {
  op: "+" | "-" | " " | "@";
  text: string;
  old?: number;
  new?: number;
}

/** One file of a unified diff. */
export interface DiffFile {
  path: string;
  /** Its path before a rename. */
  oldPath?: string;
  added: number;
  removed: number;
  binary: boolean;
  lines: DiffLine[];
}

/** `gh pr diff`'s unified diff as its files, each with its lines numbered on both sides. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let old = 0;
  let now = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `a/<path> b/<path>`: the same path twice unless renamed. A `rename to` or `+++` line
      // below, when there is one, says it exactly.
      const rest = line.slice(11).replaceAll('"', "");
      const half = (rest.length - 1) / 2;
      const same = rest.slice(2, half) === rest.slice(half + 3);
      file = {
        path: same ? rest.slice(2, half) : (/ b\/(.*)$/.exec(rest)?.[1] ?? rest),
        added: 0,
        removed: 0,
        binary: false,
        lines: [],
      };
      files.push(file);
    } else if (!file) {
      continue;
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      old = Number(m?.[1] ?? 0);
      now = Number(m?.[2] ?? 0);
      file.lines.push({ op: "@", text: line });
    } else if (file.lines.length === 0) {
      // The file's header, before its first hunk.
      // git quotes a path with special characters, and escapes them.
      if (line.startsWith("rename from ")) file.oldPath = line.slice(12).replaceAll('"', "");
      else if (line.startsWith("rename to ")) file.path = line.slice(10).replaceAll('"', "");
      else if (line.startsWith("+++ b/")) file.path = line.slice(6);
      else if (line.startsWith('+++ "b/')) file.path = line.slice(7, -1);
      else if (line.startsWith("Binary files ")) file.binary = true;
    } else if (line.startsWith("+")) {
      file.added++;
      file.lines.push({ op: "+", text: line.slice(1), new: now++ });
    } else if (line.startsWith("-")) {
      file.removed++;
      file.lines.push({ op: "-", text: line.slice(1), old: old++ });
    } else if (line.startsWith(" ")) {
      file.lines.push({ op: " ", text: line.slice(1), old: old++, new: now++ });
    }
  }
  return files;
}

/**
 * One file of the Code tab, and of the Changes view (0062): a header that folds it, with its path,
 * size, and Viewed when `onViewed` is given, over its lines numbered on both sides.
 */
function DiffFileView({
  file,
  viewed = false,
  onViewed,
}: {
  file: DiffFile;
  viewed?: boolean;
  onViewed?: (viewed: boolean) => void;
}) {
  const [folded, setFolded] = useState(false);
  const shut = folded || viewed;
  return (
    <li className="border-b border-border">
      <DiffFileHeader
        file={file}
        shut={shut}
        onToggle={() => (viewed ? onViewed?.(false) : setFolded(!folded))}
      >
        {onViewed && (
          <label className="flex shrink-0 items-center gap-1.5 text-body text-muted-foreground">
            <input type="checkbox" checked={viewed} onChange={(e) => onViewed(e.target.checked)} />
            Viewed
          </label>
        )}
      </DiffFileHeader>
      {!shut && (
        <div className="code-scroll pb-1 font-mono text-meta leading-5">
          {file.binary && <p className="px-3 text-faint-foreground">Binary file not shown</p>}
          {file.lines.map((line, i) => (
            <DiffLineView key={i} line={line} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Shared file header for the Code tab and the virtualized Changes view. */
export function DiffFileHeader({
  file,
  shut,
  onToggle,
  children,
}: {
  file: DiffFile;
  shut: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const Chevron = shut ? ChevronRight : ChevronDown;
  return (
    <div
      className={`flex items-center gap-2 bg-code px-3 py-2 text-body ${shut ? "" : "border-b border-border"}`}
    >
      <button
        type="button"
        aria-expanded={!shut}
        aria-label={`${shut ? "Show" : "Hide"} ${file.path}`}
        onClick={onToggle}
        className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-hover"
      >
        <Chevron aria-hidden className="size-4" />
      </button>
      <span
        className="min-w-0 flex-1 truncate font-mono text-body"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      </span>
      <span className="shrink-0 font-mono text-meta">
        <span className="text-added">+{file.added}</span>{" "}
        <span className="text-danger">−{file.removed}</span>
      </span>
      {children}
    </div>
  );
}

/** Shared diff row, including wrapped text and accessible addition/removal labels. */
export function DiffLineView({ line }: { line: DiffLine }) {
  return line.op === "@" ? (
    <div className={`${diffBand} code-lines break-all whitespace-pre-wrap`}>{line.text}</div>
  ) : (
    <div className={`flex ${diffLook[line.op].row}`}>
      <span
        aria-hidden
        className="w-10 shrink-0 pr-2 text-right text-faint-foreground/70 select-none"
      >
        {line.old}
      </span>
      <span
        aria-hidden
        className="w-10 shrink-0 pr-2 text-right text-faint-foreground/70 select-none"
      >
        {line.new}
      </span>
      <span aria-hidden className={`w-5 shrink-0 select-none ${diffLook[line.op].sign}`}>
        {line.op === "-" ? "−" : line.op}
      </span>
      {line.op !== " " && (
        <span className="sr-only">{line.op === "+" ? "Added: " : "Removed: "}</span>
      )}
      <span className="code-lines min-w-0 pr-3 break-all whitespace-pre-wrap">
        {line.text || " "}
      </span>
    </div>
  );
}

/**
 * A review verdict in words, and its icon. A plain "commented" review shows as its comment, or,
 * with only inline comments, as "reviewed".
 */
const verdicts: Record<string, { Icon: LucideIcon; color: string; text: string }> = {
  commented: { Icon: MessageSquare, color: "text-muted-foreground", text: "reviewed" },
  approved: { Icon: CircleCheck, color: "text-added", text: "approved these changes" },
  changesRequested: { Icon: CircleAlert, color: "text-danger", text: "requested changes" },
  dismissed: { Icon: CircleMinus, color: "text-faint-foreground", text: "had a review dismissed" },
};

/** One row of the Timeline: its icon on the rail, a line of what happened, and what's under it. */
function TimelineEvent({
  Icon,
  color = "text-muted-foreground",
  title,
  sub,
  children,
}: {
  Icon: LucideIcon;
  color?: string;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-5 before:absolute before:top-7 before:bottom-0 before:left-[11px] before:w-px before:bg-border last:before:hidden">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface">
        <Icon aria-hidden className={`size-4 ${color}`} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-body">{title}</p>
        {sub && <p className="mt-0.5 text-meta text-faint-foreground">{sub}</p>}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

/**
 * One linked pull request in the side panel: its repository and number (a link to GitHub), comment
 * count, Merge, and a `…` menu of everything else; its title, author, branches, and size; then its
 * tabs (PLX-328): a Summary of its reviewers, labels, description, and comments, newest first; a
 * Timeline of its commits, comments, reviews, and merge; and, on a plxd with `prDiff`, the Code it
 * changes. The checks' state beside the tabs, spinning while any runs, opens a popover of every
 * check, live. A screenshot in the
 * description or a comment opens in the Lightbox with the others beside it. Opening the view reads
 * the pull request again when its last read is stale.
 * `onCompose` hands a message to this thread's chat: sent, or put in the composer to finish.
 */
export function PullRequestView({
  url,
  prs,
  onCompose,
  onSetUpGithub,
  onBrowse,
}: {
  url: string;
  prs: PullRequests;
  onCompose: (text: string, send: boolean) => void;
  /** Opens a page in the side panel's Browser, for Open on GitHub when Settings sends it there. */
  onBrowse?: (url: string) => void;
  /** Offered when a read or action fails because `gh` is missing or signed out (PLX-423). */
  onSetUpGithub?: () => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const mergeMenu = useRef<HTMLDivElement>(null);
  const checksMenu = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"summary" | "timeline" | "code">("summary");
  const [shots, setShots] = useState<{ images: { src: string; name: string }[]; index: number }>();
  const [description, setDescription] = useState(true);
  const [comments, setComments] = useState(true);
  const [full, setFull] = useState<ReadonlySet<number>>(new Set());
  const [oldestFirst, setOldestFirst] = useState(false);
  // The diff as read for the pull request's `updatedAt`, and the files marked viewed, by path.
  const [diff, setDiff] = useState<{ for: string; result?: PrDiffResult; error?: string }>();
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const linked = prs.get(url);
  const pr = linked?.pr;
  const inBrowser = behaviorPrefs.use().openPrsIn === "browser" && !!onBrowse;
  const openOnGithub = (to: string) => (inBrowser ? onBrowse?.(to) : window.open(to, "_blank"));
  const readDiff = prs.diff;
  const updatedAt = pr?.updatedAt;
  // Opening it reads it again, unless its last read is fresh or still on its way.
  const reread = prs.refresh;
  const last = useRef(linked);
  last.current = linked;
  useEffect(() => {
    const at = last.current?.at;
    if (at && Date.now() - Date.parse(at) > RUNNING_POLL_MS) void reread(url);
  }, [reread, url]);
  useEffect(() => {
    if (tab !== "code" || !readDiff || !updatedAt || diff?.for === updatedAt) return;
    let live = true;
    void readDiff(url).then((read) => live && setDiff({ for: updatedAt, ...read }));
    return () => {
      live = false;
    };
  }, [tab, readDiff, url, updatedAt, diff?.for]);

  // Runs `fn` from the menus, which close first; its error shows in a notification, with Set up
  // GitHub when `gh` is missing or signed out, until one works.
  const run = async (fn: () => Promise<RpcError | undefined | void>) => {
    menu.current?.hidePopover();
    mergeMenu.current?.hidePopover();
    setBusy(true);
    const failed = await fn();
    setBusy(false);
    if (!failed) return dismiss(`pr/${url}`);
    const short = onSetUpGithub && githubProblem(failed);
    notify({
      key: `pr/${url}`,
      tone: "error",
      title: "Couldn't update the pull request",
      body: short || describeError(failed),
      action: short ? { label: "Set up GitHub", run: onSetUpGithub } : undefined,
    });
  };
  const act = (action: PrAction) => void run(() => prs.act(url, action));
  const refresh = () => void run(() => prs.refresh(url));
  const compose = (text: string, send: boolean) => {
    menu.current?.hidePopover();
    onCompose(text, send);
  };
  const copy = (text: string) => {
    menu.current?.hidePopover();
    void navigator.clipboard.writeText(text);
  };
  // A screenshot opens with the others in its description or comment.
  const showShot = (target: EventTarget) => {
    // GitHub's images, the only ones a pull request's Markdown loads.
    const shot = (target as Element).closest?.(".enriched img[src^='https://']");
    if (!(shot instanceof HTMLImageElement)) return;
    const all = [
      ...(shot.closest(".enriched") ?? shot.parentElement!).querySelectorAll<HTMLImageElement>(
        "img[src^='https://']",
      ),
    ];
    setShots({
      images: all.map((img) => ({ src: img.src, name: shotName(img.src, img.alt) })),
      index: all.indexOf(shot),
    });
  };
  // Why it couldn't be read. `gh` missing or signed out: a short line by Set up GitHub, in place
  // of plxd's message.
  const failed = linked?.error;
  const github = onSetUpGithub && githubProblem(failed);
  const failure = failed && (github || describeError(failed));
  const setUp = github && <SetUpGithub onClick={onSetUpGithub!} />;

  if (!pr)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-16 text-center text-body">
        {failure ? (
          <>
            <p role="alert" className="text-danger">
              {failure}
            </p>
            {setUp}
            <button
              type="button"
              disabled={busy}
              onClick={refresh}
              className="rounded-md px-2.5 py-1 text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Try again
            </button>
          </>
        ) : (
          <p className="text-faint-foreground">Loading…</p>
        )}
      </div>
    );

  const open = pr.state === "open";
  const look = lookOf(pr);
  const summary = checksOf(pr);
  const newest = pr.comments.map((c, i) => ({ c, i })).reverse();
  const card = (c: PrComment, i: number) => (
    <CommentCard
      c={c}
      folded={isLong(c) && !full.has(i)}
      onUnfold={() => setFull(new Set(full).add(i))}
    />
  );
  const files = diff?.result ? parseDiff(diff.result.diff) : [];
  // Every event, by time; a plain "commented" review shows as its comment instead.
  const events: { at: string; key: string; node: ReactNode }[] = [
    ...(pr.createdAt
      ? [
          {
            at: pr.createdAt,
            key: "opened",
            node: (
              <TimelineEvent
                Icon={GitPullRequest}
                color="text-added"
                title={
                  <>
                    <span className="font-medium">{pr.author}</span> opened this pull request
                  </>
                }
                sub={ago(pr.createdAt)}
              />
            ),
          },
        ]
      : []),
    ...(pr.commits ?? []).map((c) => ({
      at: c.committedAt,
      key: `commit ${c.oid}`,
      node: (
        <TimelineEvent
          Icon={GitCommitHorizontal}
          title={<span className="font-medium">{c.headline}</span>}
          sub={
            <>
              <span className="font-mono">{c.oid.slice(0, 7)}</span> · {c.author} ·{" "}
              {ago(c.committedAt)}
            </>
          }
        />
      ),
    })),
    ...pr.comments.map((c, i) => ({
      at: c.createdAt,
      key: `comment ${i}`,
      node: (
        <TimelineEvent
          Icon={MessageSquare}
          title={
            <>
              <span className="font-medium">{c.author}</span> commented
            </>
          }
        >
          {card(c, i)}
        </TimelineEvent>
      ),
    })),
    ...(pr.reviews ?? []).flatMap((r, i) => {
      const verdict = verdicts[r.state];
      const said = pr.comments.some((c) => c.author === r.author && c.createdAt === r.submittedAt);
      if (!verdict || (r.state === "commented" && said)) return [];
      return [
        {
          at: r.submittedAt,
          key: `review ${i}`,
          node: (
            <TimelineEvent
              Icon={verdict.Icon}
              color={verdict.color}
              title={
                <>
                  <span className="font-medium">{r.author}</span> {verdict.text}
                </>
              }
              sub={ago(r.submittedAt)}
            />
          ),
        },
      ];
    }),
    ...(pr.mergedAt
      ? [
          {
            at: pr.mergedAt,
            key: "merged",
            node: (
              <TimelineEvent
                Icon={GitMerge}
                color="text-project-violet"
                title={
                  <>
                    <span className="font-medium">{pr.mergedBy ?? "Someone"}</span> merged{" "}
                    <span className="font-mono">{pr.headBranch}</span> into{" "}
                    <span className="font-mono">{pr.baseBranch}</span>
                  </>
                }
                sub={ago(pr.mergedAt)}
              />
            ),
          },
        ]
      : pr.state === "closed" && pr.closedAt
        ? [
            {
              at: pr.closedAt,
              key: "closed",
              node: (
                <TimelineEvent
                  Icon={GitPullRequestClosed}
                  color="text-danger"
                  title="Closed without merging"
                  sub={ago(pr.closedAt)}
                />
              ),
            },
          ]
        : []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!oldestFirst) events.reverse();
  const tabButton = (name: typeof tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === name}
      onClick={() => setTab(name)}
      className={`rounded-lg px-2.5 py-1 text-body ${tab === name ? "bg-selected font-medium" : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
  const sort = (
    <button
      type="button"
      onClick={() => setOldestFirst(!oldestFirst)}
      className="ml-auto flex items-center gap-1 text-body text-muted-foreground hover:text-foreground"
    >
      <ArrowDownUp aria-hidden className="size-3.5" />
      {oldestFirst ? "Oldest first" : "Newest first"}
    </button>
  );
  return (
    <div
      ref={view}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      onClick={(e) => showShot(e.target)}
    >
      <header className="border-b border-border px-4 pt-2 pb-3">
        <div className="flex items-center gap-2">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            onClick={(e) => {
              if (!inBrowser) return;
              e.preventDefault();
              openOnGithub(pr.url);
            }}
            className="flex min-w-0 items-center gap-1 text-body text-muted-foreground hover:text-foreground"
          >
            <span className="truncate">{pr.repo}</span>
            <span className={`shrink-0 ${look.color}`}>#{pr.number}</span>
            <ExternalLink aria-hidden className={`size-3.5 shrink-0 ${look.color}`} />
          </a>
          <span
            title={`${pr.comments.length} comments`}
            className="ml-auto flex shrink-0 items-center gap-1 text-body text-muted-foreground"
          >
            <MessageSquare aria-hidden className="size-4" />
            {pr.comments.length}
          </span>
          {open ? (
            <div className="flex shrink-0 items-center rounded-lg bg-accent text-body font-medium text-accent-foreground">
              <button
                type="button"
                disabled={busy}
                title={pr.autoMerge ? "Disable auto-merge" : "Merge this pull request"}
                onClick={() => act(pr.autoMerge ? "disableAutoMerge" : "merge")}
                className="flex items-center gap-1.5 rounded-l-lg py-1 pr-2 pl-2.5 enabled:hover:bg-black/10 disabled:opacity-60"
              >
                <GitMerge aria-hidden className="size-4" />
                {pr.autoMerge ? `Auto-merge (${pr.autoMerge})` : "Merge"}
              </button>
              <button
                type="button"
                popoverTarget={`${id}-merge`}
                aria-haspopup="menu"
                aria-label="Merge options"
                className="self-stretch rounded-r-lg border-l border-black/15 px-1 hover:bg-black/10"
              >
                <ChevronDown aria-hidden className="size-4" />
              </button>
            </div>
          ) : (
            <span className={`shrink-0 text-body ${look.color}`}>{look.label}</span>
          )}
          <button
            type="button"
            popoverTarget={`${id}-menu`}
            aria-haspopup="menu"
            aria-label="Pull request actions"
            title="Pull request actions"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
          >
            <Ellipsis />
          </button>
        </div>
        <h2 className="mt-2 truncate text-reading font-semibold" title={pr.title}>
          {pr.title}
        </h2>
        <p className="mt-1 flex items-center gap-1 text-body text-muted-foreground">
          {pr.author}
          <span className="min-w-0 flex-1 truncate text-faint-foreground">
            · updated {ago(pr.updatedAt)}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={refresh}
            title="Refresh"
            className="flex shrink-0 items-center gap-1 rounded-md px-1 text-faint-foreground hover:bg-hover hover:text-foreground"
          >
            <RefreshCw aria-hidden className={`size-3 ${busy ? "animate-spin" : ""}`} />
            {linked?.at ? `synced ${ago(linked.at)}` : "syncing…"}
          </button>
        </p>
        <div className="mt-2 flex items-center gap-3 text-body">
          <span
            className="min-w-0 flex-1 truncate font-mono text-faint-foreground"
            title={`${pr.headBranch} into ${pr.baseBranch}`}
          >
            {pr.baseBranch} ← {pr.headBranch}
          </span>
          {/* Its lines by kind of file show under it on hover or focus, when plxd lists its files. */}
          <span
            tabIndex={pr.files?.length ? 0 : undefined}
            aria-describedby={pr.files?.length ? `${id}-lines` : undefined}
            className="group relative flex shrink-0 items-center gap-1.5 rounded-md text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-border"
          >
            <FileDiff aria-hidden className="size-4" />
            {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
            <span className="font-mono text-added">+{pr.additions.toLocaleString(locale())}</span>
            <span className="font-mono text-danger">−{pr.deletions.toLocaleString(locale())}</span>
            {!!pr.files?.length && (
              <span
                id={`${id}-lines`}
                role="tooltip"
                className="pointer-events-none invisible absolute top-full right-0 z-20 mt-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-body whitespace-nowrap shadow-composer group-hover:visible group-focus-visible:visible"
              >
                <table>
                  <tbody>
                    {[
                      ...lineBreakdown(pr),
                      { kind: "Total", additions: pr.additions, deletions: pr.deletions },
                    ].map((r) => (
                      <tr
                        key={r.kind}
                        className={r.kind === "Total" ? "border-t border-border" : undefined}
                      >
                        <td className="py-1 pr-6 font-sans text-foreground">{r.kind}</td>
                        <td className="py-1 pr-4 text-right text-added">
                          +{r.additions.toLocaleString(locale())}
                        </td>
                        <td className="py-1 text-right text-danger">
                          −{r.deletions.toLocaleString(locale())}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </span>
            )}
          </span>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-border px-4 py-2">
        <div role="tablist" aria-label="Pull request" className="flex gap-1">
          {tabButton("summary", "Summary")}
          {tabButton("timeline", "Timeline")}
          {prs.diff && tabButton("code", "Code")}
        </div>
        <button
          type="button"
          popoverTarget={`${id}-checks`}
          aria-haspopup="dialog"
          className="ml-auto flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-body hover:bg-hover"
        >
          <summary.Icon aria-hidden className={`size-4 shrink-0 ${summary.color}`} />
          <span className="truncate whitespace-nowrap text-muted-foreground">{summary.text}</span>
        </button>
      </div>

      {failure && (
        <p role="alert" className="mx-4 mt-3 flex items-center gap-2 text-body text-danger">
          {failure}
          {setUp}
        </p>
      )}

      {tab === "timeline" && (
        <div className="px-4 pb-6">
          <div className="flex items-center gap-1.5 py-3 text-body text-muted-foreground">
            <MessageSquare aria-hidden className="size-3.5" />
            {pr.comments.length} · <GitCommitHorizontal aria-hidden className="size-3.5" />
            {pr.commits?.length ?? 0}
            {sort}
          </div>
          <ol aria-label="Timeline">
            {events.map((e) => (
              <Fragment key={e.key}>{e.node}</Fragment>
            ))}
          </ol>
        </div>
      )}

      {tab === "code" && (
        <div className="pb-6">
          {!diff ? (
            <p className="px-4 py-3 text-body text-faint-foreground">Loading…</p>
          ) : diff.error ? (
            <p role="alert" className="px-4 py-3 text-body text-danger">
              {diff.error}
            </p>
          ) : (
            <>
              <p className="border-b border-border px-4 py-2.5 text-body text-muted-foreground">
                {files.length} {files.length === 1 ? "file" : "files"} ·{" "}
                {files.filter((f) => viewed.has(f.path)).length} / {files.length} viewed
              </p>
              {diff.result?.truncated && (
                <p className="border-b border-border px-4 py-2.5 text-body text-warning">
                  This diff is too large to show whole. Open it on GitHub for the rest.
                </p>
              )}
              <ul aria-label="Changed files">
                {files.map((f) => (
                  <DiffFileView
                    key={f.path}
                    file={f}
                    viewed={viewed.has(f.path)}
                    onViewed={(on) => {
                      const next = new Set(viewed);
                      if (on) next.add(f.path);
                      else next.delete(f.path);
                      setViewed(next);
                    }}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className={tab === "summary" ? "px-4 pb-6" : "hidden"}>
        <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-2.5 text-body">
          <dt className="flex items-center gap-2 text-muted-foreground">
            <Users aria-hidden className="size-4" />
            Reviewers
          </dt>
          <dd className={pr.reviewRequests.length ? "" : "text-faint-foreground"}>
            {pr.reviewRequests.join(", ") || "None"}
          </dd>
          <dt className="flex items-center gap-2 text-muted-foreground">
            <Tag aria-hidden className="size-4" />
            Labels
          </dt>
          <dd className="flex flex-wrap gap-1">
            {pr.labels.length ? (
              pr.labels.map((l) => (
                <span key={l} className="rounded-full border border-border px-2 text-meta">
                  {l}
                </span>
              ))
            ) : (
              <span className="text-faint-foreground">None</span>
            )}
          </dd>
        </dl>

        <Section
          title="Description"
          open={description}
          onToggle={() => setDescription(!description)}
        >
          {pr.body.trim() ? (
            <MarkdownText text={githubText(pr.body)} images="github" />
          ) : (
            <p className="text-body text-faint-foreground">No description</p>
          )}
        </Section>

        <Section
          title={`Comments (${pr.comments.length})`}
          open={comments}
          onToggle={() => setComments(!comments)}
          aside={
            <span className="ml-auto flex items-center gap-1 text-body text-muted-foreground">
              <ArrowDownUp aria-hidden className="size-3.5" />
              Newest first
            </span>
          }
        >
          <ul className="flex flex-col gap-3">
            {newest.map(({ c, i }) => (
              <li key={i}>{card(c, i)}</li>
            ))}
            {pr.comments.length === 0 && (
              <li className="text-body text-faint-foreground">No comments</li>
            )}
          </ul>
        </Section>
      </div>

      <div
        ref={checksMenu}
        id={`${id}-checks`}
        popover="auto"
        role="dialog"
        aria-label="Checks"
        // Opens at most as wide as the side panel, less its padding, so it stays off the divider.
        onBeforeToggle={(e) => {
          if (e.newState === "open" && view.current)
            e.currentTarget.style.maxWidth = `${view.current.clientWidth - 32}px`;
        }}
        className={`${menuPanel("end")} w-[26rem] p-2`}
      >
        <ChecksList
          checks={pr.checks}
          onOpen={openOnGithub}
          onFix={(c) => {
            checksMenu.current?.hidePopover();
            compose(
              `The "${c.name}" check failed on this pull request: ${url}. Read its log with gh, fix the cause, and push.`,
              true,
            );
          }}
        />
      </div>

      {open && (
        <div
          ref={mergeMenu}
          id={`${id}-merge`}
          popover="auto"
          role="menu"
          aria-label="Merge"
          onKeyDown={moveFocus}
          className={`${menuPanel("end")} w-56 p-1`}
        >
          <Item Icon={GitMerge} label="Merge" disabled={busy} onClick={() => act("merge")} />
          <Item
            Icon={GitMerge}
            label="Squash and merge"
            disabled={busy}
            onClick={() => act("squash")}
          />
          <Item
            Icon={GitMerge}
            label={pr.autoMerge ? "Disable auto-merge" : "Enable auto-merge"}
            disabled={busy}
            onClick={() => act(pr.autoMerge ? "disableAutoMerge" : "autoMerge")}
          />
        </div>
      )}

      <div
        ref={menu}
        id={`${id}-menu`}
        popover="auto"
        role="menu"
        aria-label="Pull request"
        onKeyDown={moveFocus}
        className={`${menuPanel("end")} w-80 p-1`}
      >
        <Item Icon={RefreshCw} label="Refresh" disabled={busy} onClick={refresh} />
        <Item
          Icon={MessageCircleQuestionMark}
          label="Ask a question"
          hint="Adds the pull request to this thread's composer."
          onClick={() => compose(`${url} `, false)}
        />
        <Item
          Icon={BookOpen}
          label="Explain this PR"
          hint="A walk through the diff and what to read closely."
          onClick={() =>
            compose(
              `Explain this pull request: ${url}. Walk me through the diff and point out what to read closely.`,
              true,
            )
          }
        />
        <Item
          Icon={Hammer}
          label="Fix findings in this thread"
          onClick={() =>
            compose(
              `Fix the review findings on this pull request: ${url}. Read its comments and checks with gh, fix what they found, and push.`,
              true,
            )
          }
        />
        {separator}
        <Item
          Icon={pr.draft ? GitPullRequest : GitPullRequestDraft}
          label={pr.draft ? "Ready for review" : "Convert to draft"}
          disabled={busy || !open}
          onClick={() => act(pr.draft ? "ready" : "draft")}
        />
        <Item
          Icon={GitMerge}
          label={pr.autoMerge ? "Disable auto-merge" : "Enable auto-merge"}
          disabled={busy || !open}
          onClick={() => act(pr.autoMerge ? "disableAutoMerge" : "autoMerge")}
        />
        {separator}
        <Item Icon={GitMerge} label="Merge" disabled={busy || !open} onClick={() => act("merge")} />
        <Item
          Icon={GitMerge}
          label="Squash and merge"
          disabled={busy || !open}
          onClick={() => act("squash")}
        />
        {separator}
        <Item
          Icon={ArrowUpRight}
          label="Open on GitHub"
          onClick={() => {
            menu.current?.hidePopover();
            openOnGithub(pr.url);
          }}
        />
        <Item Icon={Link} label="Copy link" onClick={() => copy(pr.url)} />
        <Item Icon={Copy} label="Copy PR number" onClick={() => copy(String(pr.number))} />
        {separator}
        <Item
          Icon={GitPullRequestClosed}
          label="Close pull request"
          danger
          disabled={busy || !open}
          onClick={() => {
            menu.current?.hidePopover();
            closeDialog.current?.showModal();
          }}
        />
      </div>

      <ConfirmDialog
        ref={closeDialog}
        title={`Close pull request #${pr.number}?`}
        action="Close pull request"
        onConfirm={() => {
          closeDialog.current?.close();
          act("close");
        }}
      >
        “{pr.title}” closes without merging. It can be reopened on GitHub.
      </ConfirmDialog>

      {shots && (
        <Lightbox
          images={shots.images}
          index={shots.index}
          onIndex={(index) => setShots({ ...shots, index })}
          onClose={() => setShots(undefined)}
        />
      )}
    </div>
  );
}
