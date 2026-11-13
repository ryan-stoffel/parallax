// The pull request screens' pure pieces: the list's filters over the desktop's search, a unified
// diff split into rows with line numbers, where review threads and comments sit in it, the checks'
// and reviews' one-line summaries, and the activity timeline, as T3 Code's mobile app summarizes
// them. Pure, for the test.
import type {
  PrCheck,
  PrDiffSide,
  PrReview,
  PrReviewState,
  PrReviewThread,
  PullRequest,
} from "../../desktop/src/protocol/generated/protocol";
import { matches, sortRows, type PrRow } from "../../desktop/src/renderer/pullRequestSearch";

/** `owner/name` from a pull request's URL, for before it's read. */
export const repoOf = (url: string) => url.split("/").slice(3, 5).join("/");

/**
 * The list's filters: a state (Open includes drafts, as GitHub's does, and Draft is only them),
 * what its checks say, and the computer and repository it's on.
 */
export interface PrFilters {
  state: "open" | "draft" | "merged" | "closed" | "all";
  checks?: "passed" | "failed" | "pending";
  hostId?: string;
  repo?: string;
}

export const defaultFilters: PrFilters = { state: "open" };

/**
 * The rows the list shows, by the desktop Pull requests page's search and its state and checks
 * filters, then the computer and repository, most recently updated first. One not read yet skips
 * the state and checks filters, so it shows while it loads.
 */
export function shownRows<R extends PrRow>(rows: R[], query: string, f: PrFilters): R[] {
  const states = f.state === "all" ? [] : f.state === "open" ? ["open", "draft"] : [f.state];
  const chosen = new Set([...states, ...(f.checks ? [f.checks] : [])]);
  const none = new Set<string>();
  return sortRows(
    rows.filter(
      (r) =>
        (!f.hostId || r.entry.hostId === f.hostId) &&
        (!f.repo || (r.read?.pr?.repo ?? repoOf(r.entry.url)) === f.repo) &&
        matches(r, query, r.read?.pr ? chosen : none),
    ),
    "updated",
  );
}

export type DiffRow =
  | { kind: "file"; path: string; additions: number; deletions: number }
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "context"; text: string; line: number };

/**
 * A unified diff's rows: each file's header with its counts, each hunk's `@@` line, and each
 * changed or context line with its number (the new file's, or the old one's for a removed line).
 */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let file: Extract<DiffRow, { kind: "file" }> | undefined;
  let inHunk = false;
  let old = 0;
  let now = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { kind: "file", path: line.replace(/^diff --git a\/.* b\/(.*)$/, "$1"), additions: 0, deletions: 0 };
      rows.push(file);
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk && file) {
      old = Number(hunk[1]);
      now = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    // Before a file's first hunk come its `index`, `---`, and `+++` lines, which aren't changes.
    if (!file || !inHunk || line === "" || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), line: now++ });
      file.additions++;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), line: old++ });
      file.deletions++;
    } else {
      rows.push({ kind: "context", text: line.slice(1), line: now++ });
      old++;
    }
  }
  return rows;
}

export type Tone = "success" | "danger" | "warning" | "muted";

/** The checks row's title, count, and tone: failing first, then running, then passed. */
export function checksSummary(checks: PrCheck[]): { title: string; value: string; tone: Tone } {
  const count = (state: PrCheck["state"]) => checks.filter((c) => c.state === state).length;
  const [failed, pending, passed] = [count("failed"), count("pending"), count("passed")];
  const of = `${passed} of ${checks.length}`;
  if (failed) return { title: `${failed} ${failed === 1 ? "check" : "checks"} failing`, value: of, tone: "danger" };
  if (pending) return { title: "Checks running", value: `${pending} pending`, tone: "warning" };
  if (passed === checks.length) return { title: "All checks passed", value: of, tone: "success" };
  return { title: "Checks completed", value: of, tone: passed ? "success" : "muted" };
}

/** Each reviewer's latest verdict, a verdict over a comment, without dismissed ones. */
export function latestReviews(reviews: PrReview[]): PrReview[] {
  const byAuthor = new Map<string, PrReview>();
  for (const r of reviews) {
    const prior = byAuthor.get(r.author);
    if (!prior || r.state !== "commented" || prior.state === "commented") byAuthor.set(r.author, r);
  }
  return [...byAuthor.values()].filter((r) => r.state !== "dismissed");
}

/** The reviews row's title, count, and tone: changes requested, then approved, then waiting. */
export function reviewsSummary(pr: Pick<PullRequest, "reviews" | "reviewRequests">): {
  title: string;
  value: string;
  tone: Tone;
} {
  const latest = latestReviews(pr.reviews ?? []);
  const changes = latest.filter((r) => r.state === "changesRequested");
  const approved = latest.filter((r) => r.state === "approved");
  const people = (n: number) => `${n} ${n === 1 ? "reviewer" : "reviewers"}`;
  if (changes.length) return { title: "Changes requested", value: people(changes.length), tone: "danger" };
  if (approved.length)
    return {
      title: approved.length === 1 ? `Approved by ${approved[0]!.author}` : "Reviews approved",
      value: `${approved.length} approved`,
      tone: "success",
    };
  if (pr.reviewRequests.length)
    return { title: "Awaiting review", value: `${pr.reviewRequests.length} requested`, tone: "muted" };
  if (latest.length) return { title: "Reviews", value: `${latest.length} commented`, tone: "muted" };
  return { title: "No reviews", value: "None requested", tone: "muted" };
}

export type Activity =
  | { kind: "comment"; author: string; at: string; body: string; verdict?: PrReviewState }
  | { kind: "review"; author: string; at: string; verdict: PrReviewState }
  | { kind: "commit"; author: string; at: string; headline: string; oid: string }
  | { kind: "thread"; author: string; at: string; thread: PrReviewThread }
  | { kind: "merged"; author?: string; at: string }
  | { kind: "closed"; author?: string; at: string };

/**
 * A pull request's activity, oldest first: comments, reviews (a review's text is one of the
 * comments, by the same author within a minute, so it shows once, with its verdict), review
 * threads, commits, and its merge or close.
 */
export function activityOf(pr: PullRequest): Activity[] {
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) < 60_000;
  const reviews = pr.reviews ?? [];
  const told = new Set<PrReview>();
  const events: Activity[] = pr.comments.map((c) => {
    const review = reviews.find((r) => !told.has(r) && r.author === c.author && near(r.submittedAt, c.createdAt));
    if (review) told.add(review);
    return { kind: "comment", author: c.author, at: c.createdAt, body: c.body, verdict: review?.state };
  });
  for (const r of reviews)
    if (!told.has(r) && r.state !== "commented") events.push({ kind: "review", author: r.author, at: r.submittedAt, verdict: r.state });
  for (const thread of pr.reviewThreads ?? []) {
    // A thread of only pending comments shows too, so one whose line left the diff isn't lost.
    const first = thread.comments.find((c) => !c.pending) ?? thread.comments[0];
    if (first) events.push({ kind: "thread", author: first.author, at: first.createdAt, thread });
  }
  for (const c of pr.commits ?? [])
    events.push({ kind: "commit", author: c.author, at: c.committedAt, headline: c.headline, oid: c.oid });
  if (pr.state === "merged" && pr.mergedAt) events.push({ kind: "merged", author: pr.mergedBy, at: pr.mergedAt });
  else if (pr.state === "closed" && pr.closedAt) events.push({ kind: "closed", at: pr.closedAt });
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/** The diff side a line row is on: a removed line is the old file's, the rest the new one's. */
export const sideOf = (row: Extract<DiffRow, { line: number }>): PrDiffSide => (row.kind === "del" ? "left" : "right");

/** The file each row is in, by index, for rows that only carry a line number. */
function filesOf(rows: DiffRow[]): (string | undefined)[] {
  let path: string | undefined;
  return rows.map((r) => (r.kind === "file" ? (path = r.path) : path));
}

/**
 * Each diff row's review threads, by the row's index: a thread on a line under that line, on its
 * side, and one on the whole file under the file's header. An outdated thread, whose line number
 * is from older code, and one whose line isn't in the diff sit under no row; the Activity tab shows
 * them.
 */
export function threadsAt(rows: DiffRow[], threads: PrReviewThread[]): Map<number, PrReviewThread[]> {
  const files = filesOf(rows);
  const at = new Map<number, PrReviewThread[]>();
  for (const t of threads) {
    if (t.isOutdated) continue;
    const index = rows.findIndex((r, i) =>
      t.line === undefined
        ? r.kind === "file" && r.path === t.path
        : r.kind !== "file" && r.kind !== "hunk" && files[i] === t.path && r.line === t.line && sideOf(r) === (t.side ?? "right"),
    );
    if (index >= 0) at.set(index, [...(at.get(index) ?? []), t]);
  }
  return at;
}

/** Where a diff line row is, to comment on it: its file, line, and side. */
export function lineAt(rows: DiffRow[], index: number): { path: string; line: number; side: PrDiffSide } | undefined {
  const row = rows[index];
  if (!row || row.kind === "file" || row.kind === "hunk") return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const above = rows[i]!;
    if (above.kind === "file") return { path: above.path, line: row.line, side: sideOf(row) };
  }
  return undefined;
}

/** The row to scroll to for `path`: its first new-side line at or after `line`, else its header. */
export function rowOf(rows: DiffRow[], path: string, line?: number): number {
  const files = filesOf(rows);
  const header = rows.findIndex((r) => r.kind === "file" && r.path === path);
  if (line === undefined || header < 0) return header;
  const at = rows.findIndex((r, i) => i > header && files[i] === path && r.kind !== "file" && r.kind !== "hunk" && r.kind !== "del" && r.line >= line);
  return at >= 0 ? at : header;
}
