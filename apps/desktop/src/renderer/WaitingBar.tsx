import { t } from "i18next";
import { Info } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";

import type { AgentBackgroundTask } from "../protocol/generated/protocol";
import { PullRequestChip } from "./Mention";
import { notify } from "./notifications";
import type { PullRequests } from "./PullRequests";
import { menuPanel, popoverBeside } from "./ui";
import { presentWaiting } from "./waiting";

/**
 * What a thread's settled agent still waits on, in its composer's top row, as T3 Code's strip
 * (PLX-777): one line naming its background tasks, such as a Monitor, and the pull requests plxd
 * watches for it, and Stop, which ends them all. Hidden while it waits on nothing. `compact` shows
 * only how many, opening the details and Stop above itself, for a place beside other tabs. Each
 * watched pull request shows as the composer's chip, its state from `pullRequests`, a link the
 * thread's pane opens as it opens any of the thread's pull requests. Those that don't fit the line
 * count as `+N`, which opens the details, where they're all listed. With `barShowsPrs`, the
 * thread's bar under the composer shows them, so the line doesn't, and only the details list them.
 */
export function WaitingBar({
  hostId,
  runId,
  background,
  watching,
  agentsShown,
  compact,
  pullRequests,
  barShowsPrs,
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
  /** Whether the thread's bar under the composer shows its pull requests (ThreadBar.tsx). */
  barShowsPrs?: boolean;
}) {
  const [stopping, setStopping] = useState(false);
  const id = useId();
  const pullRequest = (url: string) => (
    <a
      key={url}
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex h-6 shrink-0 items-center rounded-md hover:brightness-125"
    >
      <PullRequestChip url={url} pr={pullRequests?.get(url)?.pr} />
    </a>
  );
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
      notify({ tone: "error", title: t("Couldn't stop waiting"), body: failed.error.message });
  }

  const stopButton = (
    <button
      type="button"
      disabled={stopping}
      onClick={() => void stop()}
      className="shrink-0 rounded-md px-2 py-0.5 font-medium text-foreground hover:bg-hover disabled:opacity-40"
    >
      {stopping ? t("Stopping…") : t("Stop")}
    </button>
  );
  // As the title counts them: the subagents the tab beside it lists only when they're all there is.
  const others = shown.items.filter((item) => !agentsShown || item.kind !== "subagent");
  const counted = others.length > 0 ? others : shown.items;
  const kindsShown = new Set(counted.map((item) => item.kind));
  const verb =
    kindsShown.size === 1 && kindsShown.has("command")
      ? t("Running")
      : kindsShown.size === 1 && kindsShown.has("pull request")
        ? t("Monitoring")
        : t("Waiting");
  // The pull requests' numbers show as their chips, not in the title or labels.
  const title =
    counted.length === 1 && watching.length === 1 ? t("Monitoring pull request") : shown.title;
  const labels =
    shown.labels &&
    others
      .filter((item) => item.kind !== "pull request")
      .map((item) => item.label)
      .join(", ");

  return (
    <section aria-label={t("Waiting on")} className="min-w-0 text-body">
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
          {/* Only what the chips leave, so in a short line the labels give way first. */}
          {labels && (
            <span className="min-w-0 flex-[1_1_0] truncate text-muted-foreground">{labels}</span>
          )}
          {watching.length > 0 && !barShowsPrs && (
            <FittingChips details={`${id}-details`}>{watching.map(pullRequest)}</FittingChips>
          )}
          <button
            type="button"
            popoverTarget={`${id}-details`}
            aria-label={t("What it waits on")}
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
        aria-label={t("Waiting on")}
        className={
          compact
            ? `inset-auto m-0 mb-2 rounded-xl border border-border bg-surface p-3 text-body text-foreground shadow-composer [position-try-fallbacks:flip-block] ${popoverBeside}`
            : `${menuPanel("end")} w-80 p-3 text-body`
        }
      >
        <p className="mb-2 text-muted-foreground">
          {t("The agent picks up when one of these ends or changes.")}
        </p>
        <ul className="max-h-60 space-y-1.5 overflow-y-auto">
          {shown.items
            .filter((item) => item.kind !== "pull request")
            .map((item, i) => (
              <li key={i} className="flex min-w-0 gap-2">
                <span className="w-20 shrink-0 text-muted-foreground capitalize">
                  {kindName(item.kind)}
                </span>
                <span className="min-w-0 break-words">{item.label}</span>
              </li>
            ))}
          {watching.map((url) => (
            <li key={url} className="flex min-w-0 items-center gap-2">
              <span className="w-20 shrink-0 text-muted-foreground capitalize">
                {t("Pull request")}
              </span>
              {pullRequest(url)}
              <span className="min-w-0 truncate text-muted-foreground">
                {pullRequests?.get(url)?.pr?.title}
              </span>
            </li>
          ))}
        </ul>
        {compact && <div className="mt-2 flex justify-end">{stopButton}</div>}
      </div>
    </section>
  );
}

/** An item's kind as `presentWaiting` names it in English ("command"), in the current language. */
function kindName(kind: string) {
  const context = "kind of background task";
  switch (kind) {
    case "subagent":
      return t("subagent", { context });
    case "command":
      return t("command", { context });
    case "monitor":
      return t("monitor", { context });
    case "pull request":
      return t("pull request", { context });
    default:
      return kind;
  }
}

/**
 * `children`, each a line tall, on one line: the ones that don't fit wrap out of sight, and `+N`
 * counts them and opens `details`.
 */
function FittingChips({ details, children }: { details: string; children: ReactElement[] }) {
  const row = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(0);
  useLayoutEffect(() => {
    const el = row.current!;
    const measure = () => {
      const chips = [...el.children] as HTMLElement[];
      setWrapped(chips.filter((chip) => chip.offsetTop > chips[0]!.offsetTop).length);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children.length]);
  const fit = children.length - wrapped;
  return (
    // It gives up room before the title does, and always holds one chip and the count.
    <div className="flex min-w-28 flex-[0_1000000_auto] items-center gap-1">
      {/* Beside `+N` once there's one, so the count reads as theirs. */}
      <div
        ref={row}
        className={`flex h-6 min-w-0 flex-1 flex-wrap overflow-clip ${wrapped > 0 ? "justify-end" : ""}`}
      >
        {/* Hidden too, so Tab and a screen reader skip what's out of sight. */}
        {children.map((chip, i) => (
          <div key={chip.key} className={i < fit ? "" : "invisible"}>
            {chip}
          </div>
        ))}
      </div>
      {wrapped > 0 && (
        <button
          type="button"
          popoverTarget={details}
          aria-haspopup="dialog"
          aria-label={t("{{count}} more pull requests", {
            count: wrapped,
            defaultValue_one: "{{count}} more pull request",
          })}
          className="shrink-0 rounded-sm bg-hover px-1.5 text-foreground tabular-nums hover:brightness-125"
        >
          +{wrapped}
        </button>
      )}
    </div>
  );
}
