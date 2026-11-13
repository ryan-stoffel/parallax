import { t } from "i18next";
import { Folder, FolderGit2, GitBranch, GitPullRequestArrow, LoaderCircle } from "lucide-react";
import { useState } from "react";

import type { AgentRun } from "../protocol/generated/protocol";
import { describeError, githubProblem } from "./errors";
import type { Host } from "./hosts";
import { numberOf } from "./github";
import { GitHubLogo } from "./logos";
import { lookOf } from "./pr/parts";
import { notify } from "./notifications";
import { majorityLook, type PullRequests } from "./PullRequests";
import { hostIcon } from "./RunTargetMenu";
import { titleOf } from "./threads";

// One of the bar's items, as tall as a new thread's pickers in the same bar.
const item =
  "composer-bar-item flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-body text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * A thread's bar under the composer (PLX-1459), as a new thread's shows where it will run: the
 * computer and checkout as icons on the left, and its branch and pull requests on the right, marked as the
 * sidebar marks them after GitHub's: the state icon of most of them in its color, then the one's
 * number, which opens in the app as the thread's other PR links do, or `+N` more, which opens them
 * all (`onOpenPrs`).
 * With none, Create PR once it has a commit (`canOpenPr`). Create PR runs `agent/openPr` and hands the pull request to `onPrOpened`; one that
 * fails for `gh` offers `onSetUpGithub` (PLX-423). `prs` reads each one's state for its color.
 */
export function ThreadBar({
  hostId,
  host,
  run,
  title,
  prs,
  canOpenPr,
  onPrOpened,
  onOpenPrs,
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
  onOpenPrs: () => void;
  onSetUpGithub?: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const urls = run.pullRequests ?? [];
  const place = run.checkout ? t("Local checkout") : t("Worktree");
  // Neutral in a pane that isn't focused, which reads no pull requests' state.
  const most = prs ? majorityLook(prs) : lookOf();
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
      title: t("Couldn't create the pull request"),
      body: short || describeError(answer.error),
      action: short ? { label: t("Set up GitHub"), run: onSetUpGithub } : undefined,
    });
  };
  return (
    <>
      <span className="flex shrink-0 items-center">
        <span className={item} role="img" aria-label={host.name} title={host.name}>
          {hostIcon(host)}
        </span>
        <span className={item} role="img" aria-label={place} title={place}>
          {run.checkout ? <Folder aria-hidden /> : <FolderGit2 aria-hidden />}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1">
        {run.branch && (
          <span className={item} title={t("Branch: {{branch}}", { branch: run.branch })}>
            <GitBranch aria-hidden />
            <span className="truncate">{run.branch}</span>
          </span>
        )}
        {urls.length > 0 &&
          (() => {
            // As the sidebar marks them: the state icon of most of them, then the one's number or
            // how many more.
            const mark = (
              <>
                <GitHubLogo aria-hidden className="text-foreground" />
                <span className={`flex items-center gap-0.5 tabular-nums ${most.color}`}>
                  <most.Icon aria-hidden />
                  {urls.length > 1 ? `+${urls.length - 1}` : `#${numberOf(urls[0]!)}`}
                </span>
              </>
            );
            return urls.length === 1 ? (
              // The thread's pane opens a linked pull request in the app.
              <a
                href={urls[0]}
                title={prs?.get(urls[0]!)?.pr?.title ?? urls[0]}
                className={`${item} shrink-0 hover:bg-hover`}
              >
                {mark}
              </a>
            ) : (
              <button
                type="button"
                aria-label={t("{{count}} pull requests", {
                  count: urls.length,
                  defaultValue_one: "{{count}} pull request",
                })}
                title={urls.map((url) => `#${numberOf(url)}`).join(", ")}
                onClick={onOpenPrs}
                className={`${item} shrink-0 hover:bg-hover`}
              >
                {mark}
              </button>
            );
          })()}
        {urls.length === 0 && canOpenPr && (
          <button
            type="button"
            disabled={opening}
            onClick={() => void openPr()}
            className={`${item} shrink-0 enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-60`}
          >
            {opening ? (
              <LoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <GitPullRequestArrow aria-hidden />
            )}
            {opening ? t("Creating PR…") : t("Create PR")}
          </button>
        )}
      </span>
    </>
  );
}
