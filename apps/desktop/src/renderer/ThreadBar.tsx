import { GitBranch, GitPullRequestArrow, LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { describeError, githubProblem } from "./errors";
import type { Host } from "./hosts";
import { PullRequestChip } from "./Mention";
import { notify } from "./notifications";
import type { PullRequests } from "./PullRequests";
import { hostIcon } from "./RunTargetMenu";
import { titleOf } from "./threads";

// One of the bar's items, as tall as a new thread's pickers in the same bar.
const item =
  "composer-bar-item flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-body text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * A thread's bar under the composer (PLX-1459), as a new thread's shows where it will run: the
 * computer and checkout the thread runs in and its branch, then its pull requests, which open in
 * the app as the thread's other PR links do, or Create PR once it has a commit and none yet
 * (`canOpenPr`). Create PR runs `agent/openPr` and hands the pull request to `onPrOpened`; one that
 * fails for `gh` offers `onSetUpGithub` (PLX-423). `prs` reads each one's state for its chip.
 */
export function ThreadBar({
  hostId,
  host,
  run,
  title,
  prs,
  canOpenPr,
  onPrOpened,
  onSetUpGithub,
}: {
  hostId: string;
  host: Host;
  run: AgentRun;
  /** The thread's title, which Create PR names the pull request after. Else, its run's. */
  title?: string;
  prs?: PullRequests;
  canOpenPr: boolean;
  onPrOpened: (url: string) => void;
  onSetUpGithub?: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const urls = run.pullRequests ?? [];
  const place = run.checkout ? "Local checkout" : "Worktree";
  const openPr = async () => {
    setOpening(true);
    const prTitle = title ?? titleOf(run);
    const answer = await window.parallax.request(hostId, "agent/openPr", {
      runId: run.id,
      title: prTitle,
    });
    setOpening(false);
    if ("result" in answer) return onPrOpened(answer.result.url);
    const short = onSetUpGithub && githubProblem(answer.error);
    notify({
      tone: "error",
      title: "Couldn't create the pull request",
      body: short || describeError(answer.error),
      action: short ? { label: "Set up GitHub", run: onSetUpGithub } : undefined,
    });
  };
  return (
    <>
      <span className="flex min-w-0 items-center">
        <span className={`${item} shrink-0`} title={`${host.name} · ${place}`}>
          {hostIcon(host)}
          <span className="composer-host truncate">{host.name}</span>
          <span className="composer-detail flex shrink-0 items-center gap-1.5">
            <span aria-hidden className="text-faint-foreground">
              ·
            </span>
            {place}
          </span>
        </span>
        {run.branch && (
          <span className={item} title={`Branch: ${run.branch}`}>
            <GitBranch aria-hidden />
            <span className="truncate">{run.branch}</span>
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {urls.map((url) => (
          // The thread's pane opens a linked pull request in the app.
          <a
            key={url}
            href={url}
            className="flex shrink-0 items-center rounded-md px-1 hover:bg-hover"
          >
            <PullRequestChip url={url} pr={prs?.get(url)?.pr} />
          </a>
        ))}
        {urls.length === 0 && canOpenPr && (
          <button
            type="button"
            disabled={opening}
            onClick={() => void openPr()}
            className={`${item} enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-60`}
          >
            {opening ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <GitPullRequestArrow aria-hidden />
            )}
            {opening ? "Creating PR…" : "Create PR"}
          </button>
        )}
      </span>
    </>
  );
}
