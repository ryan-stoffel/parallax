import { useEffect, useId, useRef, useState } from "react";

import type { PrMergeMethod, PrStatusResult, PullRequest } from "../../protocol/generated/protocol";
import { icons } from "../icons";
import { animate, duration, easing } from "../motion";
import { Button, Checkbox, Menu, MenuOption, Spinner } from "../ui";
import { CheckGroup, Reveal, type CheckActions } from "./CheckGroup";
import {
  commitPreview,
  groupChecks,
  mergeGate,
  mergeTone,
  methodHint,
  methodLabels,
  methodsOf,
  more,
  statusRows,
  type Check,
  type CommitPreview,
  type GateTone,
  type MergeTone,
  type PrActExtra,
  type PrActionMore,
  type RowTone,
  type StatusRow,
} from "./model";
import { ago } from "./parts";

const toneLook: Record<GateTone, { Icon: typeof icons.success; color: string }> = {
  ready: { Icon: icons.success, color: "text-added" },
  warning: { Icon: icons.warning, color: "text-warning" },
  blocked: { Icon: icons.failed, color: "text-danger" },
  pending: { Icon: icons.loading, color: "animate-spin text-warning" },
  merged: { Icon: icons.merged, color: "text-project-violet" },
  closed: { Icon: icons.closedPullRequest, color: "text-danger" },
};

const rowLook: Record<RowTone, { Icon: typeof icons.success; color: string }> = {
  passed: { Icon: icons.success, color: "text-added" },
  failed: { Icon: icons.failed, color: "text-danger" },
  running: { Icon: icons.loading, color: "animate-spin text-warning" },
  waiting: { Icon: icons.warning, color: "text-warning" },
  neutral: { Icon: icons.skipped, color: "text-faint-foreground" },
};

// The merge button's fill by mergeTone, each with its readable black or white text (index.css).
const fills: Record<MergeTone, string> = {
  ready: "bg-merge-ready text-merge-ready-foreground",
  running: "bg-merge-running text-merge-running-foreground",
  blocked: "bg-merge-blocked text-merge-blocked-foreground",
  merged: "bg-merge-merged text-merge-merged-foreground",
  neutral: "bg-merge-neutral text-merge-neutral-foreground",
};

/** How long after merging a pull request still says "just now". */
const JUST_NOW_MS = 60_000;

/**
 * The Summary's status box and the one place a pull request merges, as GitHub's: a row each for
 * its checks, reviews, and whether it merges cleanly (statusRows), the checks row folding open to
 * every check by workflow; then, when it can't merge, why (mergeGate); then GitHub's split merge
 * button, its main part the chosen method and its chevron a menu of the methods the repository
 * allows. Auto-merge, Ready for review for a draft, and with PLX-1151's `actions`, update branch
 * and delete branch, as plxd allows. Once merged it says who and when, and a merge made just now
 * lands with a small spring.
 */
export function MergeBox({
  pr,
  status,
  checks,
  checkActions,
  actions,
  busy,
  onAct,
  onReviews,
  onCommits,
}: {
  pr: PullRequest;
  status?: PrStatusResult;
  checks: Check[];
  checkActions: CheckActions;
  /** plxd takes PLX-1151's actions: a merge's method, update and delete branch. */
  actions: boolean;
  busy: boolean;
  onAct: (action: PrActionMore, extra?: PrActExtra) => void;
  /** Opens the reviews, from the reviews row. */
  onReviews: () => void;
  /** Opens the commits, from the merge row. */
  onCommits: () => void;
}) {
  const gate = mergeGate(pr, status);
  const methods = methodsOf(pr);
  const [method, setMethod] = useState<PrMergeMethod>(methods[0]!);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [checksOpen, setChecksOpen] = useState(false);
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  // The state it showed last, so a change (a merge, checks failing) lands with motion.
  const shown = useRef(gate.tone);
  useEffect(() => {
    if (shown.current === gate.tone || !mark.current) return;
    shown.current = gate.tone;
    animate(
      mark.current,
      [
        { transform: "scale(0.6)", opacity: 0 },
        { transform: "scale(1)", opacity: 1 },
      ],
      { duration: duration.slow, easing: easing.spring },
    );
  }, [gate.tone]);
  // Running checks' times tick while their list is open.
  const running = checksOpen && checks.some((c) => c.state === "pending");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const chosen = methods.includes(method) ? method : methods[0]!;
  const tone = mergeTone(gate, checks);
  const rows = statusRows(pr, checks, gate, status);
  const commits = pr.commits?.length;
  const extra = (): PrActExtra =>
    actions ? { method: chosen, deleteBranch, headSha: status?.headSha ?? more(pr).headSha } : {};
  const { Icon, color } = toneLook[gate.tone];
  const justNow = pr.mergedAt && Date.now() - Date.parse(pr.mergedAt) < JUST_NOW_MS;
  const title = gate.tone === "merged" && justNow ? "Merged just now" : gate.title;
  const detail =
    gate.tone === "merged"
      ? `${pr.mergedBy ?? "Someone"} merged ${pr.headBranch} into ${pr.baseBranch}${pr.mergedAt && !justNow ? ` ${ago(pr.mergedAt)}` : ""}.`
      : gate.tone === "closed" && pr.closedAt
        ? `Closed ${ago(pr.closedAt)}.`
        : undefined;
  const open = pr.state === "open";
  const onRow: Record<StatusRow["key"], () => void> = {
    checks: () => setChecksOpen(!checksOpen),
    reviews: onReviews,
    merge: onCommits,
  };

  return (
    <section
      aria-label="Merge"
      className="overflow-hidden rounded-xl border border-border bg-surface"
    >
      {rows.map((row) => {
        const look = rowLook[row.tone];
        const folds = row.key === "checks";
        return (
          <div key={row.key} className="border-b border-border">
            <button
              type="button"
              aria-expanded={folds ? checksOpen : undefined}
              title={[row.label, row.detail].filter(Boolean).join(" · ")}
              onClick={onRow[row.key]}
              className="flex w-full items-start gap-2.5 px-3.5 py-3 text-left transition-colors hover:bg-hover"
            >
              <look.Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${look.color}`} />
              {/* The detail sits at the row's end, or wraps under the label when there's no room. */}
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="min-w-0 text-body font-medium wrap-break-word">{row.label}</span>
                {row.detail && (
                  <span className="text-meta text-muted-foreground tabular-nums">{row.detail}</span>
                )}
              </span>
              <icons.next
                aria-hidden
                className={`mt-[3px] size-3.5 shrink-0 text-faint-foreground transition-transform duration-base ${folds && checksOpen ? "rotate-90" : ""}`}
              />
            </button>
            {folds && (
              <Reveal open={checksOpen}>
                <div className="flex flex-col gap-2 px-3 pb-3">
                  {groupChecks(checks).map((g) => (
                    <CheckGroup key={g.name} group={g} now={now} actions={checkActions} />
                  ))}
                </div>
              </Reveal>
            )}
          </div>
        );
      })}
      {gate.tone === "ready" ? (
        // The rows say it; a screen reader hears it.
        <p role="status" className="sr-only">
          {title}
        </p>
      ) : (
        <div className="flex gap-2.5 px-3.5 pt-3">
          <span ref={mark} className="mt-px grid size-5 shrink-0 place-items-center">
            <Icon aria-hidden className={`size-4 ${color}`} />
          </span>
          <div className="min-w-0 flex-1">
            <p role="status" className="text-body font-medium">
              {title}
            </p>
            {detail && <p className="mt-0.5 text-meta text-muted-foreground">{detail}</p>}
            {gate.reasons.length > 0 && (
              <ul className="mt-0.5 flex flex-col gap-0.5 text-meta text-muted-foreground">
                {gate.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2.5 px-3.5 pt-3 pb-3.5">
        {pr.autoMerge && open && (
          <div className="flex items-center gap-2 text-meta text-muted-foreground">
            <icons.merged aria-hidden className="size-3.5 shrink-0 text-added" />
            <span className="min-w-0 flex-1">
              Auto-merge is on{methodLabels[pr.autoMerge] && ` (${methodLabels[pr.autoMerge]})`}. It
              merges once it can.
            </span>
            <Button size="sm" disabled={busy} onClick={() => onAct("disableAutoMerge")}>
              Turn off
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          {/* GitHub's split button: the merge, a thin rule, and the method's chevron. Each part
              takes the fill, so a merge GitHub won't take dims (0092) while the method can still
              change. */}
          <div data-tone={tone} className="flex h-8 min-w-0 flex-1 text-body font-medium">
            <button
              type="button"
              disabled={busy || !gate.canMerge}
              title={gate.canMerge ? undefined : gate.title}
              onClick={() => onAct(chosen, extra())}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 px-3 transition-opacity enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:size-4 [&_svg]:shrink-0 ${fills[tone]} ${open ? "rounded-l-md" : "rounded-md"}`}
            >
              {busy ? (
                <Spinner className="text-current" />
              ) : pr.state === "closed" ? (
                <icons.closedPullRequest aria-hidden />
              ) : (
                <icons.merged aria-hidden />
              )}
              <span className="truncate">
                {pr.state === "merged"
                  ? "Merged"
                  : pr.state === "closed"
                    ? "Closed"
                    : methodLabels[chosen]}
              </span>
            </button>
            {open && (
              <>
                {/* GitHub lets the method change while merging waits, as auto-merge takes it. */}
                <button
                  type="button"
                  aria-label="Merge method"
                  aria-haspopup="menu"
                  popoverTarget={`${id}-method`}
                  disabled={busy || methods.length < 2}
                  className={`grid w-8 shrink-0 place-items-center rounded-r-md border-l border-current/25 transition-opacity enabled:hover:opacity-90 disabled:opacity-60 [&_svg]:size-4 ${fills[tone]}`}
                >
                  <icons.expand aria-hidden />
                </button>
              </>
            )}
          </div>
          {gate.draft && (
            <Button variant="outline" disabled={busy} onClick={() => onAct("ready")}>
              <icons.pullRequest aria-hidden />
              Ready for review
            </Button>
          )}
          {gate.behind && actions && (
            <Button variant="outline" disabled={busy} onClick={() => onAct("updateBranch")}>
              Update branch
            </Button>
          )}
        </div>
        {open && <CommitMessage preview={commitPreview(pr, chosen)} base={pr.baseBranch} />}
        {open && !pr.autoMerge && !gate.canMerge && gate.canAutoMerge && (
          <Button variant="outline" disabled={busy} onClick={() => onAct("autoMerge", extra())}>
            Merge when ready
          </Button>
        )}
        {open && actions && !gate.draft && (
          <Checkbox checked={deleteBranch} onChange={setDeleteBranch}>
            <span className="text-meta text-muted-foreground">Delete branch after merging</span>
          </Checkbox>
        )}
        {pr.state === "merged" && actions && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onAct("deleteBranch")}
            className="self-start"
          >
            <icons.delete aria-hidden />
            Delete {pr.headBranch}
          </Button>
        )}
      </div>
      <Menu
        ref={menu}
        id={`${id}-method`}
        label="Merge method"
        align="end"
        focus='[aria-checked="true"]'
        className="w-80 p-1"
      >
        {methods.map((m) => (
          <MenuOption
            key={m}
            option={{ value: m, label: methodLabels[m], description: methodHint(m, commits) }}
            checked={m === chosen}
            onClick={() => {
              setMethod(m);
              menu.current?.hidePopover();
            }}
          />
        ))}
      </Menu>
    </section>
  );
}

/**
 * The commit the chosen method makes, read-only, as GitHub shows it before merging: a squash's or
 * merge commit's title and body, or the commits a rebase replays as they are. Editing it needs
 * plxd (PLX-1190).
 */
function CommitMessage({ preview, base }: { preview: CommitPreview; base: string }) {
  return (
    <div
      role="note"
      aria-label="Commit message"
      className="min-w-0 rounded-lg border border-border px-3 py-2 text-meta"
    >
      {preview.replayed ? (
        <>
          <p className="text-muted-foreground">
            {preview.replayed.length
              ? `Replays these commits onto ${base} as they are:`
              : `Replays this branch's commits onto ${base} as they are.`}
          </p>
          {preview.replayed.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {preview.replayed.map((c) => (
                <li key={c.oid} className="flex min-w-0 gap-2">
                  <span className="shrink-0 font-mono text-faint-foreground">{c.oid}</span>
                  <span className="truncate">{c.headline}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <p className="truncate font-medium" title={preview.title}>
            {preview.title}
          </p>
          {preview.body && (
            <p className="mt-1 line-clamp-4 whitespace-pre-line text-muted-foreground">
              {preview.body}
            </p>
          )}
        </>
      )}
    </div>
  );
}
