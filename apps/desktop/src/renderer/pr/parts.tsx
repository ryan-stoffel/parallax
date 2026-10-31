import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { RpcError } from "../../preload/bridge";
import type { PrCheck, PullRequest } from "../../protocol/generated/protocol";
import { describeError } from "../errors";
import { numberOf } from "../github";
import { icons } from "../icons";
import { locale } from "../locale";
import { age } from "../Sidebar";
import { Badge } from "../ui";
import { checkRollup, type Rollup } from "./model";

/**
 * How a pull request's state looks: open green, draft gray, merged violet, closed red. `tint` is
 * the background a chip of it takes. One not read yet, or in a state this version doesn't know,
 * is muted and has no label.
 */
export function lookOf(pr?: PullRequest): {
  Icon: LucideIcon;
  color: string;
  tint: string;
  label?: string;
} {
  if (pr?.state === "merged")
    return {
      Icon: icons.merged,
      color: "text-project-violet",
      tint: "bg-project-violet/12",
      label: "Merged",
    };
  if (pr?.state === "closed")
    return {
      Icon: icons.closedPullRequest,
      color: "text-danger",
      tint: "bg-danger/12",
      label: "Closed",
    };
  if (pr?.state === "open" && pr.draft)
    return {
      Icon: icons.draftPullRequest,
      color: "text-faint-foreground",
      tint: "bg-hover",
      label: "Draft",
    };
  if (pr?.state === "open")
    return { Icon: icons.pullRequest, color: "text-added", tint: "bg-added/12", label: "Open" };
  return { Icon: icons.pullRequest, color: "text-muted-foreground", tint: "bg-hover" };
}

/** "3m ago", or "just now" under a minute. */
export const ago = (time: string) => (age(time) === "now" ? "just now" : `${age(time)} ago`);

/** A pull request's state as a chip: its icon and Open, Draft, Merged, or Closed, in its color. */
export function StateBadge({ pr }: { pr: PullRequest }) {
  const { Icon, label } = lookOf(pr);
  const merged = pr.state === "merged";
  const tone =
    pr.state === "closed" ? "danger" : pr.state === "open" && !pr.draft ? "success" : "neutral";
  return (
    // Badge has no violet tone, so a merged one's tint and color win over neutral's.
    <Badge tone={tone} className={merged ? "bg-project-violet/12! text-project-violet!" : ""}>
      <Icon aria-hidden />
      {label ?? pr.state}
    </Badge>
  );
}

/** Lines added and removed, as `+120 −40` in green and red. */
export function DiffStat({
  added,
  removed,
  title,
  className = "",
}: {
  added: number;
  removed: number;
  /** A tooltip, such as the lines by kind of file. */
  title?: string;
  className?: string;
}) {
  const n = (v: number) => v.toLocaleString(locale());
  return (
    <span title={title} className={`shrink-0 font-mono text-meta tabular-nums ${className}`}>
      <span className="text-added">+{n(added)}</span>{" "}
      <span className="text-danger">−{n(removed)}</span>
    </span>
  );
}

/** A pull request's branches, the way it merges: `head → base`, the head truncating first. */
export function BranchPair({ head, base }: { head: string; base: string }) {
  return (
    <span
      title={`Merges ${head} into ${base}`}
      className="flex min-w-0 items-baseline gap-1 font-mono text-meta"
    >
      <span className="min-w-0 truncate">{head}</span>
      <span aria-label="into" className="shrink-0 text-faint-foreground">
        →
      </span>
      <span className="max-w-[45%] shrink-0 truncate">{base}</span>
    </span>
  );
}

/** A check's state, or all of them together, as an icon and its color. A running one spins. */
export const checkLook: Record<
  Rollup["state"] | PrCheck["state"],
  { Icon: LucideIcon; color: string }
> = {
  passed: { Icon: icons.success, color: "text-added" },
  failed: { Icon: icons.failed, color: "text-danger" },
  pending: { Icon: icons.loading, color: "animate-spin text-warning" },
  skipped: { Icon: icons.skipped, color: "text-faint-foreground" },
  none: { Icon: icons.skipped, color: "text-faint-foreground" },
};

/**
 * Checks together as one mark: their state's icon, spinning while any runs, and with `count`,
 * passed of those that count. Its label says it in words. Nothing when there are none.
 */
export function ChecksMark({
  checks,
  count,
  className = "",
}: {
  checks: readonly Pick<PrCheck, "state">[];
  count?: boolean;
  className?: string;
}) {
  const rollup = checkRollup(checks);
  if (rollup.state === "none") return null;
  const { Icon, color } = checkLook[rollup.state];
  return (
    <span
      role="img"
      aria-label={rollup.words}
      title={rollup.words}
      className={`flex shrink-0 items-center gap-1 text-meta tabular-nums ${className}`}
    >
      <Icon aria-hidden className={`size-3.5 ${color}`} />
      {count && rollup.total > 0 && (
        <span className={rollup.failed ? "text-danger" : "text-muted-foreground"}>
          {rollup.passed}/{rollup.total}
        </span>
      )}
    </span>
  );
}

const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? "";

/**
 * One pull request in a list (the side panel's, Thread details', the Pull requests page's): its
 * state's icon, its title on up to two lines, and its checks; then its number, `context` (its
 * repository unless given, such as its thread's title), its size, and how long since it changed.
 * Before it's read, its repository and Loading…, or why it couldn't be read. `action` sits at its
 * end, outside the row's button, such as Open on GitHub.
 */
export function PrRow({
  url,
  pr,
  error,
  context,
  labels,
  action,
  onOpen,
}: {
  url: string;
  pr?: PullRequest;
  error?: RpcError;
  context?: string;
  /** Shows its labels after its title. */
  labels?: boolean;
  action?: ReactNode;
  onOpen: () => void;
}) {
  const { Icon, color } = lookOf(pr);
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        title={pr ? `#${pr.number} ${pr.title}` : url}
        className={`flex w-full gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-hover ${action ? "pr-9" : ""}`}
      >
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${color}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="line-clamp-2 min-w-0 flex-1 text-body leading-snug wrap-break-word">
              {pr?.title ?? repoOf(url)}
            </span>
            {labels &&
              pr?.labels.map((l) => (
                <Badge key={l} shape="pill">
                  {l}
                </Badge>
              ))}
            {pr && <ChecksMark checks={pr.checks} count className="mt-px" />}
          </span>
          <span className="mt-1 flex items-baseline gap-1.5 text-meta text-faint-foreground">
            <span className="shrink-0 tabular-nums">#{numberOf(url)}</span>
            {pr ? (
              <>
                <span className="min-w-0 flex-1 truncate">· {context ?? pr.repo}</span>
                <DiffStat added={pr.additions} removed={pr.deletions} />
                <span className="shrink-0">· {age(pr.updatedAt)}</span>
              </>
            ) : (
              <span className={`min-w-0 truncate ${error ? "text-danger" : ""}`}>
                · {error ? describeError(error) : "Loading…"}
              </span>
            )}
          </span>
        </span>
      </button>
      {action}
    </div>
  );
}
