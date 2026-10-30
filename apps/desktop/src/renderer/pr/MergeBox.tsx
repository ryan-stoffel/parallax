import { useEffect, useId, useRef, useState } from "react";

import type { PrMergeMethod, PrStatusResult, PullRequest } from "../../protocol/generated/protocol";
import { icons } from "../icons";
import { animate, duration, easing } from "../motion";
import { Button, Checkbox, Menu, menuItem, Spinner } from "../ui";
import {
  checkRollup,
  mergeGate,
  methodLabels,
  methodsOf,
  more,
  type GateTone,
  type PrActExtra,
  type PrActionMore,
} from "./model";
import { ago, ChecksMark } from "./parts";

const toneLook: Record<GateTone, { Icon: typeof icons.success; color: string }> = {
  ready: { Icon: icons.success, color: "text-added" },
  warning: { Icon: icons.warning, color: "text-warning" },
  blocked: { Icon: icons.failed, color: "text-danger" },
  pending: { Icon: icons.loading, color: "animate-spin text-warning" },
  merged: { Icon: icons.merged, color: "text-project-violet" },
  closed: { Icon: icons.closedPullRequest, color: "text-danger" },
};

/** How long after merging a pull request still says "just now". */
const JUST_NOW_MS = 60_000;

/**
 * The one place a pull request merges (mergeGate): whether it can and, when it can't, why, its
 * checks in a line that opens the Checks tab, and what plxd allows: merge by the chosen method,
 * auto-merge, Ready for review for a draft, and with PLX-1151's `actions`, update branch and
 * delete branch. Merge is off unless GitHub would take it. Once merged it says who and when, and
 * a merge made just now lands with a small spring.
 */
export function MergeBox({
  pr,
  status,
  actions,
  busy,
  onAct,
  onChecks,
}: {
  pr: PullRequest;
  status?: PrStatusResult;
  /** plxd takes PLX-1151's actions: a merge's method, update and delete branch. */
  actions: boolean;
  busy: boolean;
  onAct: (action: PrActionMore, extra?: PrActExtra) => void;
  onChecks: () => void;
}) {
  const gate = mergeGate(pr, status);
  const methods = methodsOf(pr);
  const [method, setMethod] = useState<PrMergeMethod>(methods[0]!);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  // The state it showed last, so a change (a merge, checks passing) lands with motion.
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
  const { Icon, color } = toneLook[gate.tone];
  const rollup = checkRollup(pr.checks);
  const chosen = methods.includes(method) ? method : methods[0]!;
  const extra = (): PrActExtra =>
    actions ? { method: chosen, deleteBranch, headSha: status?.headSha ?? more(pr).headSha } : {};

  const justNow = pr.mergedAt && Date.now() - Date.parse(pr.mergedAt) < JUST_NOW_MS;
  const title = gate.tone === "merged" && justNow ? "Merged just now" : gate.title;
  const detail =
    gate.tone === "merged"
      ? `${pr.mergedBy ?? "Someone"} merged ${pr.headBranch} into ${pr.baseBranch}${pr.mergedAt && !justNow ? ` ${ago(pr.mergedAt)}` : ""}.`
      : gate.tone === "closed" && pr.closedAt
        ? `Closed ${ago(pr.closedAt)}.`
        : undefined;
  const open = pr.state === "open";

  return (
    <section
      aria-label="Merge"
      className="overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex gap-2.5 px-3 pt-3 pb-2.5">
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
      {rollup.state !== "none" && (
        <button
          type="button"
          onClick={onChecks}
          className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-meta text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <ChecksMark checks={pr.checks} />
          <span className="min-w-0 flex-1 truncate">{rollup.words}</span>
          <icons.next aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
        </button>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
          {pr.autoMerge && (
            <div className="flex items-center gap-2 text-meta text-muted-foreground">
              <icons.merged aria-hidden className="size-3.5 shrink-0 text-added" />
              <span className="min-w-0 flex-1">
                Auto-merge is on{methodLabels[pr.autoMerge] && ` (${methodLabels[pr.autoMerge]})`}.
                It merges once it can.
              </span>
              <Button size="sm" disabled={busy} onClick={() => onAct("disableAutoMerge")}>
                Turn off
              </Button>
            </div>
          )}
          {gate.draft ? (
            <Button variant="primary" disabled={busy} onClick={() => onAct("ready")}>
              {busy ? <Spinner /> : <icons.pullRequest aria-hidden />}
              Ready for review
            </Button>
          ) : (
            <div className="flex gap-2">
              <div className="flex min-w-0 flex-1">
                <Button
                  variant="primary"
                  disabled={busy || !gate.canMerge}
                  title={gate.canMerge ? undefined : gate.title}
                  onClick={() => onAct(chosen, extra())}
                  className="min-w-0 flex-1 rounded-r-none"
                >
                  {busy ? <Spinner className="text-current" /> : <icons.merged aria-hidden />}
                  <span className="truncate">{methodLabels[chosen]}</span>
                </Button>
                <Button
                  variant="primary"
                  aria-label="Merge method"
                  aria-haspopup="menu"
                  popoverTarget={`${id}-method`}
                  disabled={busy || !gate.canMerge || methods.length < 2}
                  className="rounded-l-none border-l border-black/15 px-1.5"
                >
                  <icons.expand aria-hidden />
                </Button>
              </div>
              {gate.behind && actions && (
                <Button variant="outline" disabled={busy} onClick={() => onAct("updateBranch")}>
                  Update branch
                </Button>
              )}
            </div>
          )}
          {!pr.autoMerge && !gate.canMerge && gate.canAutoMerge && (
            <Button variant="outline" disabled={busy} onClick={() => onAct("autoMerge", extra())}>
              Merge when ready
            </Button>
          )}
          {actions && !gate.draft && (
            <Checkbox checked={deleteBranch} onChange={setDeleteBranch}>
              <span className="text-meta text-muted-foreground">Delete branch after merging</span>
            </Checkbox>
          )}
        </div>
      )}
      {pr.state === "merged" && actions && (
        <div className="border-t border-border px-3 py-2.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("deleteBranch")}>
            <icons.delete aria-hidden />
            Delete {pr.headBranch}
          </Button>
        </div>
      )}
      <Menu ref={menu} id={`${id}-method`} label="Merge method" align="end" className="w-60 p-1">
        {methods.map((m) => (
          <button
            key={m}
            type="button"
            role="menuitemradio"
            aria-checked={m === chosen}
            onClick={() => {
              setMethod(m);
              menu.current?.hidePopover();
            }}
            className={menuItem}
          >
            <span className="flex-1">{methodLabels[m]}</span>
            <icons.done aria-hidden className={m === chosen ? "" : "invisible"} />
          </button>
        ))}
      </Menu>
    </section>
  );
}
