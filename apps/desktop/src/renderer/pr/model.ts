// What the PR view works out from plxd's reads: checks rolled up and grouped, whether a pull
// request can merge and why not, its review threads, and its lines by kind of file. Pure.
import type {
  PrAction,
  PrCheck,
  PrMergeMethod,
  PrStatusResult,
  PullRequest,
} from "../../protocol/generated/protocol";

// PLX-1151 adds these to `pr/view`, `pr/act`, and the capabilities. They're optional here, so the
// view works on today's plxd and lights up each part once a plxd sends its field.

/** A review thread with every comment, as PLX-1151's `pr/view` lists them. */
export interface ReviewThreadData {
  id: string;
  path?: string;
  line?: number;
  isOutdated?: boolean;
  isResolved?: boolean;
  comments: {
    id?: string;
    url?: string;
    author: string;
    avatarUrl?: string;
    body: string;
    createdAt?: string;
  }[];
}

/** PLX-1151's fields on a pull request. */
export interface PullRequestMore {
  reviewDecision?: string;
  mergeable?: string;
  behindBy?: number;
  ready?: boolean;
  reasons?: string[];
  headSha?: string;
  mergeMethods?: PrMergeMethod[];
  reviewThreads?: ReviewThreadData[];
}

/** A check with whether branch protection requires it and its Actions run and job. */
export type Check = PrCheck & { required?: boolean; runId?: number; jobId?: number };

/** `pr/act`'s actions, with PLX-1151's, which a plxd with `prActions` takes. */
export type PrActionMore =
  | PrAction
  | "rebase"
  | "updateBranch"
  | "rerunFailed"
  | "rerunJob"
  | "cancelRun"
  | "deleteBranch";

/** PLX-1151's `pr/act` params: a merge's method and branch, and a re-run's run or job. */
export interface PrActExtra {
  method?: PrMergeMethod;
  deleteBranch?: boolean;
  headSha?: string;
  workflowRunId?: number;
  jobId?: number;
}

export const more = (pr: PullRequest) => pr as PullRequest & PullRequestMore;

/** A pull request's checks, each with what `pr/status` says of it by name: required, its run. */
export function checksOf(pr: PullRequest, status?: PrStatusResult): Check[] {
  const byName = new Map((status?.checks ?? []).map((c) => [c.name, c]));
  return pr.checks.map((c: Check) => {
    const s = byName.get(c.name);
    return {
      ...c,
      required: c.required ?? s?.required,
      runId: c.runId ?? s?.runId,
    };
  });
}

/** Checks in a few numbers, and their state together: failed over running over passed. */
export interface Rollup {
  state: "failed" | "pending" | "passed" | "skipped" | "none";
  passed: number;
  failed: number;
  pending: number;
  /** Those that count: every check but skipped ones. */
  total: number;
  /** "2 of 7 checks passed, 1 failed, 4 running", for a screen reader or a tooltip. */
  words: string;
}

/** `checks` rolled up. Skipped ones don't count, so all skipped is "skipped", not passed. */
export function checkRollup(checks: readonly Pick<PrCheck, "state">[]): Rollup {
  const count = (state: PrCheck["state"]) => checks.filter((c) => c.state === state).length;
  const [passed, failed, pending] = [count("passed"), count("failed"), count("pending")];
  const total = checks.length - count("skipped");
  const state = failed
    ? "failed"
    : pending
      ? "pending"
      : passed
        ? "passed"
        : checks.length
          ? "skipped"
          : "none";
  const words = !checks.length
    ? "No checks"
    : !total
      ? "Checks skipped"
      : [
          `${passed} of ${total} checks passed`,
          failed && `${failed} failed`,
          pending && `${pending} running`,
        ]
          .filter(Boolean)
          .join(", ");
  return { state, passed, failed, pending, total, words };
}

/** A span of time in a few words: `45s`, `3m 12s`, or `1h 4m`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** How long a check ran, or has run so far, or undefined when GitHub didn't say when it started. */
export function checkTime(c: PrCheck, now = Date.now()): string | undefined {
  if (!c.startedAt) return undefined;
  return span((c.completedAt ? Date.parse(c.completedAt) : now) - Date.parse(c.startedAt));
}

/** Where a check is, in a word or two: Queued, Running, or how it ended, as "Timed out". */
export function checkStatus(c: PrCheck): string {
  if (c.state === "pending") return c.startedAt ? "Running" : "Queued";
  const ended = (c.conclusion ?? c.state).replaceAll("_", " ");
  return `${ended[0]!.toUpperCase()}${ended.slice(1)}`;
}

// Failed first, then running, then the rest, as GitHub lists them.
const order: Record<string, number> = { failed: 0, pending: 1, passed: 2 };
const byState = (a: PrCheck, b: PrCheck) => (order[a.state] ?? 3) - (order[b.state] ?? 3);

/** A workflow's checks: its name ("Other checks" for another CI's statuses) and its jobs. */
export interface CheckGroupData {
  name: string;
  checks: Check[];
  rollup: Rollup;
}

/**
 * `checks` by workflow, each failed first, and the groups with a failure first, then those still
 * running, then the rest, each in the order GitHub listed them.
 */
export function groupChecks(checks: readonly Check[]): CheckGroupData[] {
  const groups = new Map<string, Check[]>();
  for (const c of checks) {
    const name = c.workflow || "Other checks";
    groups.set(name, [...(groups.get(name) ?? []), c]);
  }
  return [...groups]
    .map(([name, list]) => ({ name, checks: list.sort(byState), rollup: checkRollup(list) }))
    .sort((a, b) => (order[a.rollup.state] ?? 3) - (order[b.rollup.state] ?? 3));
}

/** How the merge box looks: ready, ready with notes, blocked, waiting, merged, or closed. */
export type GateTone = "ready" | "warning" | "blocked" | "pending" | "merged" | "closed";

/** Whether a pull request can merge, in a line and its reasons, and what the merge box offers. */
export interface Gate {
  tone: GateTone;
  title: string;
  reasons: string[];
  canMerge: boolean;
  /** Auto-merge waits for what's blocking it: checks, reviews, or an update. */
  canAutoMerge: boolean;
  behind: boolean;
  draft: boolean;
  conflicts: boolean;
}

const gate = (tone: GateTone, title: string, reasons: string[] = [], more: Partial<Gate> = {}) => ({
  tone,
  title,
  reasons,
  canMerge: false,
  canAutoMerge: false,
  behind: false,
  draft: false,
  conflicts: false,
  ...more,
});

/**
 * Whether `pr` can merge, from GitHub's merge state and, when read, matching `pr/status` (or
 * PLX-1151's on the pull request). Merge is offered only when GitHub would take it: clean, with
 * hooks, or unstable (a check that isn't required failed). Auto-merge is offered while it waits on
 * checks, reviews, or the base.
 */
export function mergeGate(pr: PullRequest, status?: PrStatusResult): Gate {
  if (pr.state === "merged") return gate("merged", "Merged");
  if (pr.state === "closed") return gate("closed", "Closed without merging");
  if (pr.draft)
    return gate("blocked", "This pull request is a draft", ["Mark it ready for review to merge."], {
      draft: true,
    });
  const extra = more(pr);
  const matchingStatus =
    status?.url === pr.url &&
    (!status.headSha || !extra.headSha || status.headSha === extra.headSha)
      ? status
      : undefined;
  const reasons = matchingStatus?.reasons ?? extra.reasons ?? [];
  const mergeable = matchingStatus?.mergeable ?? extra.mergeable;
  const mergeState =
    matchingStatus?.mergeState?.replaceAll("_", "").toLowerCase() ?? pr.mergeState?.toLowerCase();
  if (mergeable === "CONFLICTING" || mergeState === "dirty")
    return gate(
      "blocked",
      "This branch has conflicts",
      [`Resolve its conflicts with ${pr.baseBranch} to merge.`],
      { conflicts: true },
    );
  const checks = checkRollup(pr.checks);
  if (mergeState === "behind") {
    const by = matchingStatus?.behindBy ?? extra.behindBy;
    const commits = by ? `${by} ${by === 1 ? "commit" : "commits"}` : "Commits";
    return gate(
      "blocked",
      `This branch is behind ${pr.baseBranch}`,
      [`${commits} on ${pr.baseBranch} must be merged in first.`],
      { behind: true, canAutoMerge: true },
    );
  }
  if (mergeState === undefined)
    return gate("pending", "Checking whether it can merge", [], { canAutoMerge: true });
  if (mergeState === "blocked") {
    const why = reasons.length
      ? reasons
      : [
          checks.failed
            ? `${checks.failed} ${checks.failed === 1 ? "check" : "checks"} failed.`
            : checks.pending
              ? `${checks.pending} ${checks.pending === 1 ? "check is" : "checks are"} still running.`
              : "Branch protection needs a review or a check first.",
        ];
    return checks.pending && !checks.failed
      ? gate("pending", "Waiting for checks", why, { canAutoMerge: true })
      : gate("blocked", checks.failed ? "Checks failed" : "Merging is blocked", why, {
          canAutoMerge: true,
        });
  }
  if (mergeState === "unstable")
    return gate("warning", "Some checks didn't pass", reasons, { canMerge: true });
  if (mergeState === "clean" || mergeState === "hashooks")
    return reasons.length
      ? gate("warning", "Can merge", reasons, { canMerge: true })
      : gate("ready", "Ready to merge", [], { canMerge: true });
  // A merge state this version doesn't know: GitHub decides when asked.
  return gate("pending", "Checking whether it can merge");
}

/** The ways a pull request can merge: the repository's, once plxd says them, else today's two. */
export const methodsOf = (pr: PullRequest): PrMergeMethod[] =>
  more(pr).mergeMethods?.length ? more(pr).mergeMethods! : ["squash", "merge"];

export const methodLabels: Record<PrMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** GitHub's line under a merge method in its menu, with the branch's commits when known. */
export function methodHint(method: PrMergeMethod, commits?: number): string {
  const these = commits ? `The ${plural(commits, "commit")}` : "The commits";
  if (method === "merge")
    return "All commits from this branch will be added to the base branch via a merge commit.";
  if (method === "squash")
    return `${these} from this branch will be combined into one commit in the base branch.`;
  return `${these} from this branch will be rebased and added to the base branch.`;
}

/** How a status row's icon looks: passed, failed, running, waiting on someone, or neither. */
export type RowTone = "passed" | "failed" | "running" | "waiting" | "neutral";

/** A row of the Summary's status box: what it's about, its state, and a muted detail. */
export interface StatusRow {
  key: "checks" | "reviews" | "merge";
  tone: RowTone;
  label: string;
  detail?: string;
}

const names = (who: string[]) =>
  who.length <= 2 ? who.join(" and ") : `${who[0]} and ${who.length - 1} others`;

/**
 * The status box's rows, each only when it applies: checks when any ran, reviews when one was
 * given, asked for, or required, and, while open, whether it merges cleanly into its base.
 */
export function statusRows(
  pr: PullRequest,
  checks: readonly Pick<PrCheck, "state">[],
  gate: Gate,
  status?: PrStatusResult,
): StatusRow[] {
  const rows: StatusRow[] = [];

  const c = checkRollup(checks);
  const of = `${c.passed} of ${c.total}`;
  if (c.state === "passed")
    rows.push({ key: "checks", tone: "passed", label: "All checks passed", detail: of });
  else if (c.state === "failed")
    rows.push({
      key: "checks",
      tone: "failed",
      label: `${plural(c.failed, "check")} failed`,
      detail: `${of} passed`,
    });
  else if (c.state === "pending")
    rows.push({
      key: "checks",
      tone: "running",
      label: `${plural(c.pending, "check")} running`,
      detail: `${of} passed`,
    });
  else if (c.state === "skipped")
    rows.push({ key: "checks", tone: "neutral", label: "Checks skipped" });

  // Each reviewer's latest verdict; a later comment doesn't undo an approval.
  const latest = new Map<string, string>();
  for (const r of pr.reviews ?? [])
    if (r.state !== "commented" || !latest.has(r.author)) latest.set(r.author, r.state);
  const by = (state: string) => [...latest].filter(([, s]) => s === state).map(([who]) => who);
  const [approvers, blockers] = [by("approved"), by("changesRequested")];
  // `pr/view` says "changesRequested"; `pr/status` says GitHub's "CHANGES_REQUESTED".
  const decision = (pr.reviewDecision ?? status?.reviewDecision)?.replaceAll("_", "").toLowerCase();
  // Those asked who haven't reviewed yet, by name, as the reviewers panel listed them.
  const waiting = pr.reviewRequests.filter((who) => !latest.has(who));
  const detail =
    [
      approvers.length && plural(approvers.length, "approval"),
      waiting.length && `${names(waiting)} requested`,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  if (decision === "changesrequested" || blockers.length)
    rows.push({
      key: "reviews",
      tone: "failed",
      label: blockers.length ? `Changes requested by ${names(blockers)}` : "Changes requested",
      detail,
    });
  else if (decision === "approved" || (!decision && approvers.length))
    rows.push({
      key: "reviews",
      tone: "passed",
      label: approvers.length ? `Approved by ${names(approvers)}` : "Approved",
      detail,
    });
  else if (decision === "reviewrequired" || pr.reviewRequests.length)
    rows.push({
      key: "reviews",
      tone: "waiting",
      label: decision === "reviewrequired" ? "Review required" : "Waiting for review",
      detail,
    });

  if (pr.state !== "open") return rows;
  const base = pr.baseBranch;
  const behindBy = status?.behindBy ?? more(pr).behindBy;
  const commits = pr.commits?.length;
  const merge = (tone: RowTone, label: string, detail?: string) =>
    rows.push({ key: "merge", tone, label, detail });
  if (gate.draft) merge("neutral", "This pull request is a draft");
  else if (gate.conflicts) merge("failed", `Conflicts with ${base}`);
  else if (gate.behind)
    merge("waiting", `Behind ${base}`, behindBy ? plural(behindBy, "commit") : undefined);
  else if (pr.mergeState === undefined) merge("running", "Checking for conflicts");
  else if (pr.mergeState === "blocked") merge("waiting", "Merging is blocked");
  else
    merge("passed", `No conflicts with ${base}`, commits ? plural(commits, "commit") : undefined);
  return rows;
}

/**
 * The merge button's color, from the merge gate: ready (green) when it can merge, running
 * (yellow) while any check runs or it waits on GitHub, blocked (red) when something stops it,
 * merged (purple), and neutral (gray) for a draft or a closed one. A check still running turns it
 * yellow even when GitHub would take the merge (unstable), and the button stays enabled.
 */
export type MergeTone = "ready" | "running" | "blocked" | "merged" | "neutral";

export function mergeTone(gate: Gate, checks: readonly Pick<PrCheck, "state">[]): MergeTone {
  if (gate.tone === "merged") return "merged";
  if (gate.tone === "closed" || gate.draft) return "neutral";
  if (gate.canMerge) return checkRollup(checks).pending ? "running" : "ready";
  return gate.tone === "pending" ? "running" : "blocked";
}

/** The commit a merge makes, as GitHub would write it, for a read-only preview. */
export interface CommitPreview {
  /** Its title; none for a rebase, which keeps each commit's own. */
  title?: string;
  body?: string;
  /** The commits a rebase replays, as they are. */
  replayed?: { oid: string; headline: string }[];
}

/**
 * The commit `method` makes, with GitHub's default messages (plxd doesn't report a repository's
 * own squash message setting): a squash of one commit takes that commit's title, `<headline>
 * (#n)`, and of several the pull request's, `<title> (#n)`, over their headlines (none sent, the
 * pull request's title); a merge commit is GitHub's "Merge pull request #n from <owner>/<head>" over
 * the title; a rebase replays the commits as they are. The owner is the base repository's, as
 * plxd doesn't say a fork's.
 */
export function commitPreview(pr: PullRequest, method: PrMergeMethod): CommitPreview {
  const commits = pr.commits ?? [];
  if (method === "rebase")
    return { replayed: commits.map((c) => ({ oid: c.oid.slice(0, 7), headline: c.headline })) };
  if (method === "merge")
    return {
      title: `Merge pull request #${pr.number} from ${pr.repo.split("/")[0]}/${pr.headBranch}`,
      body: pr.title,
    };
  // plxd sends only headlines, so a one-commit squash has no body to show.
  if (commits.length === 1) return { title: `${commits[0]!.headline} (#${pr.number})` };
  return {
    title: `${pr.title} (#${pr.number})`,
    body: commits.length ? commits.map((c) => `* ${c.headline}`).join("\n\n") : undefined,
  };
}

/** A review thread as the view draws it, from PLX-1151's full threads or `pr/status`'s first lines. */
export interface ThreadView {
  id?: string;
  path?: string;
  line?: number;
  outdated?: boolean;
  resolved: boolean;
  url?: string;
  comments: { author?: string; body: string; createdAt?: string; url?: string }[];
}

/**
 * `pr`'s review threads: every one with its comments once plxd sends them (PLX-1151), else the
 * unresolved ones `pr/status` lists by their first comment.
 */
export function threadsOf(pr: PullRequest, status?: PrStatusResult): ThreadView[] {
  const full = more(pr).reviewThreads;
  if (full)
    return full.map((t) => ({
      id: t.id,
      path: t.path,
      line: t.line,
      outdated: t.isOutdated,
      resolved: !!t.isResolved,
      url: t.comments[0]?.url,
      comments: t.comments,
    }));
  return (status?.unresolvedThreads ?? []).map((t) => ({
    id: t.id,
    path: t.path,
    resolved: false,
    url: t.url,
    comments: [{ author: t.author, body: t.body }],
  }));
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
