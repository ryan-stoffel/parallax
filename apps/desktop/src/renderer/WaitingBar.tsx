import { Info } from "lucide-react";
import { useId, useState } from "react";

import type { AgentBackgroundTask } from "../protocol/generated/protocol";
import { numberOf } from "./github";
import { GitHubLogo } from "./logos";
import { notify } from "./notifications";
import { lookOf, type PullRequests } from "./PullRequests";
import { menuPanel, popoverBeside } from "./ui";
import { presentWaiting } from "./waiting";

/**
 * What a thread's settled agent still waits on, in its composer's top row, as T3 Code's strip
 * (PLX-777): one line naming its background tasks, such as a Monitor, and the pull requests plxd
 * watches for it, and Stop, which ends them all. Hidden while it waits on nothing. `compact` shows
 * only how many, opening the details and Stop above itself, for a place beside other tabs. Each
 * watched pull request shows as GitHub's mark and its number, the number in its state's color
 * from `pullRequests`, a link the thread's pane opens as it opens any of the thread's pull requests.
 */
export function WaitingBar({
  hostId,
  runId,
  background,
  watching,
  agentsShown,
  compact,
  pullRequests,
}: {
  hostId: string;
  runId: string;
  background: AgentBackgroundTask[];
  watching: string[];
  /** Whether the subagents tab shows over it, naming its subagents. */
  agentsShown?: boolean;
  compact?: boolean;
  /** The thread's pull requests as the app reads them, for each watched one's state. */
  pullRequests?: PullRequests;
}) {
  const [stopping, setStopping] = useState(false);
  const id = useId();
  const shown = presentWaiting(background, watching, agentsShown);
  if (!shown) return null;

  async function stop() {
    setStopping(true);
    const answers = await Promise.all([
      ...background.map((task) =>
        window.parallax.request(hostId, "agent/stopTask", { runId, taskId: task.taskId }),
      ),
      ...watching.map((url) => window.parallax.request(hostId, "pr/unwatch", { runId, url })),
    ]);
    // Taking the request doesn't end the work: what ends leaves with plxd's events, and what
    // didn't can be stopped again.
    setStopping(false);
    const failed = answers.find((answer) => "error" in answer);
    if (failed && "error" in failed)
      notify({ tone: "error", title: "Couldn't stop waiting", body: failed.error.message });
  }

  const stopButton = (
    <button
      type="button"
      disabled={stopping}
      onClick={() => void stop()}
      className="shrink-0 rounded-md px-2 py-0.5 font-medium text-foreground hover:bg-hover disabled:opacity-40"
    >
      {stopping ? "Stopping…" : "Stop"}
    </button>
  );
  // As the title counts them: the subagents the tab beside it lists only when they're all there is.
  const others = shown.items.filter((item) => !agentsShown || item.kind !== "subagent");
  const counted = others.length > 0 ? others : shown.items;
  const kindsShown = new Set(counted.map((item) => item.kind));
  const verb =
    kindsShown.size === 1 && kindsShown.has("command")
      ? "Running"
      : kindsShown.size === 1 && kindsShown.has("pull request")
        ? "Monitoring"
        : "Waiting";
  // The pull requests' numbers show as their chips, not in the title or labels.
  const title =
    counted.length === 1 && watching.length === 1 ? "Monitoring pull request" : shown.title;
  const labels =
    shown.labels &&
    others
      .filter((item) => item.kind !== "pull request")
      .map((item) => item.label)
      .join(", ");

  return (
    <section aria-label="Waiting on" className="min-w-0 text-body">
      {compact ? (
        <button
          type="button"
          popoverTarget={`${id}-details`}
          aria-haspopup="dialog"
          title={shown.title}
          className="flex h-7 items-center gap-1.5 rounded-lg px-1.5 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-foreground" />
          {verb}
          <span className="rounded-sm bg-hover px-1.5 text-foreground tabular-nums">
            {counted.length}
          </span>
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5 py-0.5 pr-2.5 pl-4">
          <span
            aria-hidden
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground"
          />
          <span className="min-w-0 truncate font-medium">{title}</span>
          {labels && <span className="min-w-0 truncate text-muted-foreground">{labels}</span>}
          {watching.map((url) => {
            const { color, tint } = lookOf(pullRequests?.get(url)?.pr);
            return (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 font-medium tabular-nums hover:brightness-125 ${color} ${tint}`}
              >
                <GitHubLogo className="size-3.5 text-foreground" />#{numberOf(url)}
              </a>
            );
          })}
          <button
            type="button"
            popoverTarget={`${id}-details`}
            aria-label="What it waits on"
            aria-haspopup="dialog"
            className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
          >
            <Info aria-hidden />
          </button>
          {stopButton}
        </div>
      )}
      <div
        id={`${id}-details`}
        popover="auto"
        role="dialog"
        aria-label="Waiting on"
        className={
          compact
            ? `inset-auto m-0 mb-2 rounded-xl border border-border bg-surface p-3 text-body text-foreground shadow-composer [position-try-fallbacks:flip-block] ${popoverBeside}`
            : `${menuPanel("end")} w-80 p-3 text-body`
        }
      >
        <p className="mb-2 text-muted-foreground">
          The agent picks up when one of these ends or changes.
        </p>
        <ul className="space-y-1.5">
          {shown.items.map((item, i) => (
            <li key={i} className="flex min-w-0 gap-2">
              <span className="w-20 shrink-0 text-muted-foreground capitalize">{item.kind}</span>
              <span className="min-w-0 break-words">{item.label}</span>
            </li>
          ))}
        </ul>
        {compact && <div className="mt-2 flex justify-end">{stopButton}</div>}
      </div>
    </section>
  );
}
