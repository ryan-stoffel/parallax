import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CloudUpload,
  Copy,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { RpcError } from "../preload/bridge";
import type { AgentRun, GitStatus, RepoId } from "../protocol/generated/protocol";
import { useConnection } from "./ConnectionStatus";
import { describeError, githubProblem } from "./errors";
import { titleOf } from "./threads";
import { isRunning } from "./transcript";
import { notify, type Notice } from "./notifications";
import { DiffStat } from "./pr/parts";
import { Menu, menuItem } from "./ui";

type GitAction = "commit" | "push" | "pr";

const actions: { action: GitAction; label: string; busy: string; Icon: LucideIcon }[] = [
  { action: "commit", label: "Commit", busy: "Committing…", Icon: GitCommitHorizontal },
  { action: "push", label: "Push", busy: "Pushing…", Icon: CloudUpload },
  { action: "pr", label: "Create PR", busy: "Creating PR…", Icon: GitPullRequestArrow },
];

/**
 * What the Git menu offers a run whose folder is in `status`: why each action can't run (absent
 * when it can) and the main one (Commit with changes, else Push with unpushed commits, else Create
 * PR). `hasPr` is whether the thread already has an open pull request, which Create PR would repeat.
 */
export function gitActions(
  run: AgentRun,
  status: GitStatus | undefined,
  canOpenPr: boolean,
  hasPr = false,
): { why: Partial<Record<GitAction, string>>; main: GitAction } {
  const all = (reason: string) => ({ commit: reason, push: reason, pr: reason });
  if (isRunning(run.status)) return { why: all("Wait for the turn to end"), main: "commit" };
  if (!status) return { why: all("Loading…"), main: "commit" };
  const why: Partial<Record<GitAction, string>> = {};
  if (status.changes === 0) why.commit = "No changes";
  if (!status.origin) why.push = why.pr = "No origin remote";
  // The branch row says Detached HEAD, so this says what to do about it.
  else if (!status.branch) why.push = why.pr = "Check out a branch";
  else {
    if (status.ahead === 0) why.push = "Nothing to push";
    if (hasPr) why.pr = "A pull request is already open";
    else if (!canOpenPr) why.pr = "This host's plxd can't open pull requests";
    // A worktree's pull request is of the run's commits.
    else if (!run.checkout && !run.diff) why.pr = "No commits yet";
  }
  const main = !why.commit ? "commit" : !why.push ? "push" : "pr";
  return { why, main };
}

/** Where `status` stands, in a few words: uncommitted files, commits to push, and the upstream. */
export function syncText(status: GitStatus): string {
  const files = status.changes === 1 ? "1 uncommitted file" : `${status.changes} uncommitted files`;
  const commits = status.ahead === 1 ? "1 commit to push" : `${status.ahead} commits to push`;
  const remote = !status.origin
    ? "No origin remote"
    : !status.branch
      ? undefined
      : status.ahead
        ? commits
        : !status.upstream
          ? "Not pushed yet"
          : `Up to date with ${status.upstream}`;
  return [status.changes ? files : !status.ahead && "No uncommitted changes", remote]
    .filter(Boolean)
    .join(" · ");
}

/** `syncText` short enough to sit beside the branch on its row. */
export function syncBrief(status: GitStatus): string {
  const remote = !status.origin
    ? "No origin"
    : !status.branch
      ? undefined
      : status.ahead
        ? `${status.ahead} to push`
        : !status.upstream
          ? "Not pushed"
          : undefined;
  const brief = [status.changes && `${status.changes} uncommitted`, remote].filter(Boolean);
  // A detached HEAD has nothing to be in sync with.
  return brief.length ? brief.join(" · ") : status.branch ? "Synced" : "Clean";
}

/**
 * Git rows in Thread details (PLX-298): the branch, copyable, on one line with where it stands in
 * a few words (PLX-1086), the full words in its tooltip, the Changes row, and the next useful action as a button, its reason shown when it can't run. The
 * chevron lists Commit, Push, and Create PR, each disabled with its reason. Commit
 * asks for a message, prefilled with the thread's title. Create PR pushes and opens the pull
 * request through `agent/openPr`, in the browser, or with `onPrOpened`, in the PR view. The status
 * is read again after each action and whenever the run's status or commit changes, as when a turn
 * ends. Each action's result is a notification (PLX-507), except a failed commit, which stays in
 * its dialog; a push or Create PR that fails for `gh` offers `onSetUpGithub` (PLX-423). Absent
 * until the host's plxd has the `git` capability. A new repository thread reads its checkout
 * behind `repoGitStatus` and offers no writes until the thread starts. `hasPr` turns Create PR
 * off while the thread has an open pull request.
 */
export function GitMenu({
  hostId,
  run,
  repo,
  title,
  onPrOpened,
  onSetUpGithub,
  onChanges,
  hasPr,
}: {
  hostId: string;
  run?: AgentRun;
  repo?: RepoId;
  /** The thread's title, for the commit message and pull request. Else, its run's. */
  title?: string;
  onPrOpened?: (url: string) => void;
  onSetUpGithub?: () => void;
  onChanges?: () => void;
  hasPr?: boolean;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const connection = useConnection(hostId);
  const capabilities = connection?.status === "connected" ? connection.capabilities : undefined;
  const able =
    !!capabilities && (run ? "git" in capabilities : !!repo && "repoGitStatus" in capabilities);
  const [status, setStatus] = useState<GitStatus>();
  // Why the status couldn't load, which the branch row says.
  const [error, setError] = useState<string>();
  const [diagnostic, setDiagnostic] = useState<string>();
  const [busy, setBusy] = useState<GitAction>();
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const runId = run?.id;

  const load = useCallback(
    async (live: () => boolean = () => true) => {
      if (!runId && !repo) return;
      const answer = runId
        ? await window.parallax.request(hostId, "agent/gitStatus", { runId })
        : await window.parallax.request(hostId, "repo/gitStatus", { repo: repo! });
      if (!live()) return;
      if ("error" in answer) {
        setStatus(undefined);
        setDiagnostic(describeError(answer.error));
        setError(
          answer.error.data?.kind === "worktreeMissing"
            ? "Worktree no longer exists"
            : "Git status unavailable",
        );
      } else {
        setStatus(answer.result);
        setError(undefined);
        setDiagnostic(undefined);
      }
    },
    [hostId, runId, repo],
  );
  const runStatus = run?.status;
  const commit = run?.diff?.commit;
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    setDiagnostic(undefined);
    if (!able) return;
    let live = true;
    void load(() => live);
    return () => {
      live = false;
    };
  }, [able, load, runStatus, commit]);

  if (!able) return null;
  const { why, main } = run
    ? gitActions(run, status, "openPr" in capabilities!, hasPr)
    : {
        why: {
          commit: "Start the thread to commit",
          push: "Start the thread to push",
          pr: "Start the thread to open a PR",
        },
        main: "commit" as const,
      };
  const primary = actions.find((a) => a.action === main)!;

  // Runs `action`. Its result is a notification. A failed commit leaves its dialog open to retry.
  const perform = async (action: GitAction) => {
    if (!run || !status) return;
    setBusy(action);
    let failed: RpcError | undefined;
    let done: Notice | undefined;
    if (action === "pr") {
      const prTitle = title ?? titleOf(run);
      const answer = await window.parallax.request(hostId, "agent/openPr", {
        runId: run.id,
        title: prTitle,
      });
      if ("error" in answer) failed = answer.error;
      else {
        const { url } = answer.result;
        if (onPrOpened) onPrOpened(url);
        else window.open(url, "_blank");
        done = {
          tone: "success",
          title: "Pull request opened",
          body: prTitle,
          action: { label: "View on GitHub", href: url },
        };
        await load();
      }
    } else {
      const answer =
        action === "commit"
          ? await window.parallax.request(hostId, "agent/commit", { runId: run.id, message })
          : await window.parallax.request(hostId, "agent/push", { runId: run.id });
      if ("error" in answer) failed = answer.error;
      else {
        setStatus(answer.result);
        done =
          action === "commit"
            ? { tone: "success", title: "Committed", body: message.trim().split("\n")[0] }
            : { tone: "success", title: "Pushed", body: answer.result.branch ?? undefined };
      }
    }
    setBusy(undefined);
    const key = `git/${hostId}/${run.id}`;
    if (done) notify({ ...done, key });
    if (action === "commit" && !failed) dialog.current?.close();
    else if (action === "commit" && failed)
      notify({ key, tone: "error", title: "Couldn't commit", body: describeError(failed) });
    else if (failed) {
      const short = onSetUpGithub && githubProblem(failed);
      notify({
        key,
        tone: "error",
        title: action === "push" ? "Push failed" : "Couldn't create the pull request",
        body: short || describeError(failed),
        action: short ? { label: "Set up GitHub", run: onSetUpGithub } : undefined,
      });
    }
  };
  const start = (action: GitAction) => {
    menu.current?.hidePopover();
    if (action !== "commit") return void perform(action);
    if (!run || !status) return;
    setMessage(title ?? titleOf(run));
    dialog.current?.showModal();
  };

  const copyBranch = () => {
    if (!status?.branch) return;
    void navigator.clipboard.writeText(status.branch);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  const lines = (status?.insertions ?? 0) + (status?.deletions ?? 0);
  // Nothing to commit or push: the button says so rather than naming an action that can't run.
  const settled = !busy && !!why[main] && !!status && !status.changes && !status.ahead;
  return (
    <>
      <h3 className="px-2 pt-1 pb-1 text-meta text-muted-foreground">Git</h3>
      <div
        role={status || !error ? undefined : "alert"}
        title={status ? `${status.branch ?? "Detached HEAD"}\n${syncText(status)}` : diagnostic}
        className="group/branch flex items-center gap-2 rounded-md px-2 py-1.5"
      >
        <GitBranch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span
          className={`min-w-0 flex-1 truncate text-body ${!status && error ? "text-danger" : ""}`}
        >
          {status ? (status.branch ?? "Detached HEAD") : (error ?? "Loading branch…")}
        </span>
        {status && (
          <span className="shrink-0 text-meta text-faint-foreground">{syncBrief(status)}</span>
        )}
        {status?.branch && (
          <button
            type="button"
            onClick={copyBranch}
            aria-label={copied ? "Copied" : "Copy branch name"}
            title={copied ? "Copied" : "Copy branch name"}
            className="-my-0.5 grid size-6 shrink-0 place-items-center rounded-md text-faint-foreground opacity-0 group-hover/branch:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5!"
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onChanges}
        disabled={!status || !onChanges}
        className={`${menuItem} disabled:opacity-50 [&_svg]:size-4`}
      >
        <FileDiff aria-hidden className="text-muted-foreground" />
        <span className="flex-1">Changes</span>
        <span className="text-meta text-muted-foreground">
          {status
            ? lines > 0 && (
                <DiffStat added={status.insertions ?? 0} removed={status.deletions ?? 0} />
              )
            : error
              ? "Unavailable"
              : "Loading…"}
        </span>
        <ChevronRight aria-hidden className="text-faint-foreground" />
      </button>
      <div className="mx-2 mt-1.5 mb-1 flex h-8 items-stretch rounded-lg border border-border">
        <button
          type="button"
          disabled={!!why[main] || !!busy}
          onClick={() => start(main)}
          title={why[main]}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-l-lg px-2.5 text-body font-medium enabled:hover:bg-hover disabled:font-normal disabled:text-muted-foreground [&_svg]:size-4"
        >
          {settled ? (
            <CircleCheck aria-hidden className="text-added" />
          ) : (
            <primary.Icon aria-hidden />
          )}
          <span className="truncate">
            {busy
              ? actions.find((a) => a.action === busy)!.busy
              : settled
                ? "Nothing to commit or push"
                : primary.label}
          </span>
        </button>
        <button
          type="button"
          popoverTarget={id}
          aria-haspopup="menu"
          aria-label="Git actions"
          className="grid w-8 shrink-0 place-items-center rounded-r-lg border-l border-border text-muted-foreground hover:bg-hover [&_svg]:size-4"
        >
          <ChevronDown aria-hidden />
        </button>
      </div>
      {!busy && !settled && why[main] && (
        <p className="px-2 pb-1 text-meta text-faint-foreground">{why[main]}</p>
      )}
      <Menu ref={menu} id={id} label="Git" align="end" className="w-80 p-1" focus="button:enabled">
        {actions.map(({ action, label, Icon }) => (
          <button
            key={action}
            type="button"
            role="menuitem"
            disabled={!!why[action] || !!busy}
            onClick={() => start(action)}
            className={`${menuItem} disabled:opacity-50 disabled:hover:bg-transparent [&_svg]:size-4`}
          >
            <Icon aria-hidden />
            <span className="flex-1">{label}</span>
            {why[action] && <span className="text-meta text-faint-foreground">{why[action]}</span>}
          </button>
        ))}
      </Menu>
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-commit`}
        className="m-auto w-[28rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform("commit");
          }}
        >
          <div className="px-5 pt-4 pb-3">
            <h2 id={`${id}-commit`} className="text-reading font-semibold">
              Commit changes
            </h2>
            <p className="mt-0.5 text-body text-muted-foreground">
              Stages every change on {status?.branch ?? "the detached HEAD"} and commits it.
            </p>
          </div>
          <div className="px-5 pb-4">
            <textarea
              aria-label="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              spellCheck={false}
              className="w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-body focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>
          <div className="flex items-center gap-3 border-t border-border px-5 py-3">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="ml-auto shrink-0 rounded-md px-3 py-1.5 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!message.trim() || !!busy}
              className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-body font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
            >
              {busy === "commit" ? "Committing…" : "Commit"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
