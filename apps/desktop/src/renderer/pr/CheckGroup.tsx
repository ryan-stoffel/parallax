import { useState, type ReactNode } from "react";

import type { PrFailureLog } from "../../protocol/generated/protocol";
import { icons } from "../icons";
import { Badge, Button, IconButton, Spinner } from "../ui";
import { checkStatus, checkTime, type Check, type CheckGroupData } from "./model";
import { checkLook, ChecksMark } from "./parts";

/** Eases its content open and shut by its rows, so a fold doesn't jump. */
export function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-base ease-in-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
    >
      <div className="min-h-0 overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}

/** What a check row can do, each present only where plxd can. */
export interface CheckActions {
  onOpen: (url: string) => void;
  onFix: (check: Check) => void;
  /** Reads a failed check's log lines (`pr/failureLog`). */
  log?: (check: Check) => Promise<{ result?: PrFailureLog; error?: string }>;
  /** Re-runs one job (PLX-1151's `rerunJob`). */
  onRerun?: (check: Check) => void;
  /** Re-runs a workflow run's failed jobs (PLX-1151's `rerunFailed`). */
  onRerunFailed?: (runId: number) => void;
}

/**
 * One workflow's checks in the Checks tab: a heading that folds them, with its rollup and, where
 * plxd can, Re-run failed; then a row per check (CheckRow). `now` ticks while one runs.
 */
export function CheckGroup({
  group,
  now,
  actions,
}: {
  group: CheckGroupData;
  now: number;
  actions: CheckActions;
}) {
  const [open, setOpen] = useState(true);
  const failedRun = group.checks.find((c) => c.state === "failed" && c.runId)?.runId;
  return (
    <section aria-label={group.name} className="rounded-xl border border-border">
      <div className="flex h-10 items-center gap-2 pr-2 pl-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md px-2 text-left"
        >
          <icons.next
            aria-hidden
            className={`size-3.5 shrink-0 text-faint-foreground transition-transform duration-base ${open ? "rotate-90" : ""}`}
          />
          <span className="min-w-0 truncate text-body font-medium">{group.name}</span>
          <ChecksMark checks={group.checks} count className="ml-1" />
        </button>
        {actions.onRerunFailed && failedRun && (
          <Button size="sm" onClick={() => actions.onRerunFailed!(failedRun)}>
            <icons.refresh aria-hidden />
            Re-run failed
          </Button>
        )}
      </div>
      <Reveal open={open}>
        <ul className="border-t border-border p-1">
          {group.checks.map((c, i) => (
            <CheckRow key={`${c.name} ${c.url} ${i}`} check={c} now={now} actions={actions} />
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

/**
 * One check: its state's icon, its name, Required when branch protection needs it, its status
 * and how long it ran, and on hover Re-run and Open on GitHub. A failed one opens its log's error
 * lines under it, read once, with Fix in this thread.
 */
export function CheckRow({
  check,
  now,
  actions,
}: {
  check: Check;
  now: number;
  actions: CheckActions;
}) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ result?: PrFailureLog; error?: string }>();
  const { Icon, color } = checkLook[check.state] ?? checkLook.skipped;
  const failed = check.state === "failed";
  const toggle = () => {
    setOpen(!open);
    if (!log && actions.log) void actions.log(check).then(setLog);
  };
  const time = checkTime(check, now);
  const name = (
    <>
      <Icon aria-label={check.state} className={`size-4 shrink-0 ${color}`} />
      <span className="min-w-0 flex-1 truncate" title={check.name}>
        {check.name}
      </span>
    </>
  );
  return (
    <li className="group">
      <div className="flex h-9 items-center gap-2 rounded-lg pr-1 pl-2 text-body hover:bg-hover">
        {failed ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
          >
            {name}
          </button>
        ) : (
          name
        )}
        {check.required && <Badge>Required</Badge>}
        <span className="w-28 shrink-0 truncate text-right text-meta text-faint-foreground tabular-nums">
          {checkStatus(check)}
          {time && ` · ${time}`}
        </span>
        <span className="flex w-14 shrink-0 justify-end">
          {actions.onRerun && check.state !== "pending" && (check.jobId || check.runId) && (
            <IconButton
              size="sm"
              reveal
              label={`Re-run ${check.name}`}
              onClick={() => actions.onRerun!(check)}
            >
              <icons.refresh aria-hidden />
            </IconButton>
          )}
          {check.url && (
            <IconButton
              size="sm"
              reveal
              label={`Open ${check.name} on GitHub`}
              onClick={() => actions.onOpen(check.url!)}
            >
              <icons.external aria-hidden />
            </IconButton>
          )}
        </span>
      </div>
      {failed && (
        <Reveal open={open}>
          <div className="mx-2 mt-1 mb-2 overflow-hidden rounded-lg border border-border">
            {!actions.log ? (
              <p className="px-3 py-2 text-meta text-faint-foreground">
                This host's plxd can't read check logs. Open it on GitHub.
              </p>
            ) : !log ? (
              <p className="flex items-center gap-2 px-3 py-2 text-meta text-faint-foreground">
                <Spinner /> Reading the log…
              </p>
            ) : log.error ? (
              <p role="alert" className="px-3 py-2 text-meta text-danger">
                {log.error}
              </p>
            ) : (
              <pre
                aria-label={`${check.name}'s log`}
                className="code-scroll code-lines max-h-72 overflow-auto bg-code px-3 py-2 font-mono text-meta leading-5 whitespace-pre"
              >
                {log.result?.log.trim() || "The log has no error lines."}
              </pre>
            )}
            <div className="flex items-center gap-1 border-t border-border px-1.5 py-1">
              <Button size="sm" onClick={() => actions.onFix(check)}>
                <icons.agent aria-hidden />
                Fix in this thread
              </Button>
              {check.url && (
                <Button size="sm" onClick={() => actions.onOpen(check.url!)}>
                  <icons.external aria-hidden />
                  Open on GitHub
                </Button>
              )}
            </div>
          </div>
        </Reveal>
      )}
    </li>
  );
}
