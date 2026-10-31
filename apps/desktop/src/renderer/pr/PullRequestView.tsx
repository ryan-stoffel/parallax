import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { RpcError } from "../../preload/bridge";
import type {
  PrComment,
  PrDiffResult,
  PrStatusResult,
  PrWrite,
  PullRequest,
} from "../../protocol/generated/protocol";
import { ChangesDiff } from "../ChangesDiff";
import { describeError, githubProblem } from "../errors";
import { shotName } from "../github";
import { icons } from "../icons";
import { Lightbox } from "../Lightbox";
import { dismiss, notify } from "../notifications";
import { behaviorPrefs } from "../prefs";
import type { PullRequests } from "../PullRequests";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  GroupHeading,
  IconButton,
  Menu,
  menuItem,
  SetUpGithub,
  Segmented,
} from "../ui";
import { CheckGroup, type CheckActions } from "./CheckGroup";
import { GithubMarkdown } from "./GithubMarkdown";
import { MergeBox } from "./MergeBox";
import {
  checkRollup,
  checksOf,
  groupChecks,
  lineBreakdown,
  threadsOf,
  type Check,
  type PrActExtra,
  type PrActionMore,
  type ThreadView,
} from "./model";
import { ago, BranchPair, DiffStat, StateBadge } from "./parts";
import { ReviewThread } from "./ReviewThread";

/** How long a read stays fresh enough that opening the view doesn't read it again. */
const FRESH_MS = 15_000;

type Tab = "overview" | "checks" | "files" | "activity";

/**
 * One linked pull request in the side panel (PLX-1153). A header that stays put: its state,
 * `repo#n` (to GitHub), Refresh, and a … menu; its title on up to two lines; its author, branches,
 * and size. Under it tabs that stay put too: Overview (its description, and the merge box,
 * reviewers, and labels, in a right rail once the panel is 900px wide), Checks (by workflow, with
 * logs and re-run), Files (the diff, with Viewed, a file tree when wide, and review threads at
 * their lines), and Activity (unresolved threads, the timeline, and a box to comment or review).
 * Only the tab's body scrolls. It reads `pr/status` beside `pr/view` for what's required, why it
 * can't merge, and its threads, and writes through `pr/write`, where plxd has them. A screenshot
 * opens in the Lightbox with the others beside it. `onCompose` hands a message to this thread's
 * chat: sent, or put in the composer to finish.
 */
export function PullRequestView({
  url,
  prs,
  onCompose,
  onSetUpGithub,
  onBrowse,
}: {
  url: string;
  prs: PullRequests;
  onCompose: (text: string, send: boolean) => void;
  /** Opens a page in the side panel's Browser, for Open on GitHub when Settings sends it there. */
  onBrowse?: (url: string) => void;
  /** Offered when a read or action fails because `gh` is missing or signed out (PLX-423). */
  onSetUpGithub?: () => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [shots, setShots] = useState<{ images: { src: string; name: string }[]; index: number }>();
  const [diff, setDiff] = useState<{ for: string; result?: PrDiffResult; error?: string }>();
  const [viewed, setViewed] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<PrStatusResult>();
  // Bumped after a write or an action, so `pr/status` is read again.
  const [statusTick, setStatusTick] = useState(0);
  const linked = prs.get(url);
  const pr = linked?.pr;
  const inBrowser = behaviorPrefs.use().openPrsIn === "browser" && !!onBrowse;
  const openOnGithub = useCallback(
    (to: string) => (inBrowser ? onBrowse?.(to) : window.open(to, "_blank", "noreferrer")),
    [inBrowser, onBrowse],
  );

  // Opening it reads it again, unless its last read is fresh or still on its way.
  const reread = prs.refresh;
  const last = useRef(linked);
  last.current = linked;
  useEffect(() => {
    const at = last.current?.at;
    if (at && Date.now() - Date.parse(at) > FRESH_MS) void reread(url);
  }, [reread, url]);

  // `pr/status` when it opens, after a write, and when GitHub's copy changes.
  const readStatus = prs.status;
  const updatedAt = pr?.updatedAt;
  const checksState = pr?.checksState;
  useEffect(() => {
    if (!readStatus || !updatedAt) return;
    let live = true;
    void readStatus(url).then((read) => live && read.result && setStatus(read.result));
    return () => {
      live = false;
    };
  }, [readStatus, url, updatedAt, checksState, statusTick]);

  const readDiff = prs.diff;
  useEffect(() => {
    if (tab !== "files" || !readDiff || !updatedAt || diff?.for === updatedAt) return;
    let live = true;
    void readDiff(url).then((read) => live && setDiff({ for: updatedAt, ...read }));
    return () => {
      live = false;
    };
  }, [tab, readDiff, url, updatedAt, diff?.for]);

  // Runs `fn`, closing the menu first; its error shows in a notification, with Set up GitHub when
  // `gh` is missing or signed out, until one works. Resolves to whether it worked.
  const run = async (fn: () => Promise<RpcError | undefined | void>, title: string) => {
    menu.current?.hidePopover();
    setBusy(true);
    const failed = await fn();
    setBusy(false);
    if (!failed) {
      dismiss(`pr/${url}`);
      setStatusTick((n) => n + 1);
      return true;
    }
    const short = onSetUpGithub && githubProblem(failed);
    notify({
      key: `pr/${url}`,
      tone: "error",
      title,
      body: short || describeError(failed),
      action: short ? { label: "Set up GitHub", run: onSetUpGithub } : undefined,
    });
    return false;
  };
  const act = (action: PrActionMore, extra?: PrActExtra) =>
    void run(() => prs.act(url, action, extra), "Couldn't update the pull request");
  const write = prs.write
    ? (w: PrWrite) =>
        run(async () => {
          const failed = await prs.write!(url, w);
          if (!failed) void prs.refresh(url);
          return failed;
        }, "Couldn't write to the pull request")
    : undefined;
  const refresh = () => void run(() => prs.refresh(url), "Couldn't read the pull request");
  const compose = (text: string, send: boolean) => {
    menu.current?.hidePopover();
    onCompose(text, send);
  };
  const copy = (text: string) => {
    menu.current?.hidePopover();
    void navigator.clipboard.writeText(text);
  };
  // A screenshot opens with the others in its description or comment.
  const showShot = (target: EventTarget) => {
    const shot = (target as Element).closest?.(".gh-markdown img[src^='https://']");
    if (!(shot instanceof HTMLImageElement)) return;
    const all = [
      ...(shot.closest(".gh-markdown") ?? shot.parentElement!).querySelectorAll<HTMLImageElement>(
        "img[src^='https://']",
      ),
    ];
    setShots({
      images: all.map((img) => ({
        src: img.currentSrc || img.src,
        name: shotName(img.src, img.alt),
      })),
      index: all.indexOf(shot),
    });
  };

  // Why it couldn't be read: `gh` missing or signed out, a short line by Set up GitHub.
  const failed = linked?.error;
  const github = onSetUpGithub && githubProblem(failed);
  const failure = failed && (github || describeError(failed));
  const setUp = github && <SetUpGithub onClick={onSetUpGithub!} />;

  if (!pr)
    return failure ? (
      <div className="grid flex-1 place-items-center pb-16">
        <EmptyState
          icon={<icons.error aria-hidden />}
          title="Couldn't read this pull request"
          body={<span role="alert">{failure}</span>}
          action={
            <span className="flex items-center gap-2">
              {setUp}
              <Button variant="outline" size="sm" disabled={busy} onClick={refresh}>
                Try again
              </Button>
            </span>
          }
        />
      </div>
    ) : (
      <Skeleton />
    );

  const checks = checksOf(pr, status);
  const rollup = checkRollup(checks);
  const threads = threadsOf(pr, status);
  const unresolved = threads.filter((t) => !t.resolved);
  const open = pr.state === "open";
  const breakdown = lineBreakdown(pr)
    .map((r) => `${r.kind}: +${r.additions} −${r.deletions}`)
    .join("\n");
  const fixCheck = (c: Check) =>
    compose(
      `The "${c.name}" check failed on this pull request: ${url}. Read its log with ci_failure_log, fix the cause, and push.`,
      true,
    );
  const threadProps = (t: ThreadView) => ({
    thread: t,
    repo: pr.repo,
    onOpen: openOnGithub,
    onReply:
      write && t.id
        ? (body: string) => write({ kind: "replyToThread", reviewThreadId: t.id!, body })
        : undefined,
    onResolve:
      write && t.id
        ? () => write({ kind: "replyToThread", reviewThreadId: t.id!, resolve: true })
        : undefined,
  });

  return (
    <div className="@container flex min-h-0 flex-1 flex-col" onClick={(e) => showShot(e.target)}>
      <header className="shrink-0 border-b border-border px-4 pt-3">
        <div className="flex h-7 items-center gap-2">
          <StateBadge pr={pr} />
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            onClick={(e) => {
              e.preventDefault();
              openOnGithub(pr.url);
            }}
            className="flex min-w-0 flex-1 items-center gap-1 text-body text-muted-foreground hover:text-foreground"
          >
            <span className="truncate">{pr.repo}</span>
            <span className="shrink-0 tabular-nums">#{pr.number}</span>
            <icons.external aria-hidden className="size-3.5 shrink-0" />
          </a>
          <IconButton
            label={linked?.at ? `Refresh (synced ${ago(linked.at)})` : "Refresh"}
            disabled={busy}
            onClick={refresh}
          >
            <icons.refresh aria-hidden className={busy ? "animate-spin" : ""} />
          </IconButton>
          <IconButton
            label="Pull request actions"
            aria-haspopup="menu"
            popoverTarget={`${id}-menu`}
          >
            <icons.more aria-hidden />
          </IconButton>
        </div>
        <h2
          className="mt-2 line-clamp-2 text-reading leading-snug font-semibold wrap-break-word"
          title={pr.title}
        >
          {pr.title}
        </h2>
        <p className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-meta text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground">{pr.author}</span>
          <span aria-hidden className="text-faint-foreground">
            ·
          </span>
          <BranchPair head={pr.headBranch} base={pr.baseBranch} />
          <span aria-hidden className="text-faint-foreground">
            ·
          </span>
          <DiffStat added={pr.additions} removed={pr.deletions} title={breakdown || undefined} />
        </p>
        <Tabs
          tab={tab}
          onTab={setTab}
          tabs={[
            { id: "overview", label: "Overview" },
            {
              id: "checks",
              label: "Checks",
              count: rollup.failed ? (
                <Badge shape="count" tone="danger">
                  {rollup.failed}
                </Badge>
              ) : undefined,
            },
            { id: "files", label: "Files", count: <Count n={pr.changedFiles} /> },
            {
              id: "activity",
              label: "Activity",
              count: <Count n={pr.comments.length + unresolved.length} />,
            },
          ]}
        />
      </header>

      {tab === "overview" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid gap-5 px-4 py-4 @min-[900px]:grid-cols-[minmax(0,1fr)_18rem] @min-[900px]:gap-8">
            <aside className="flex min-w-0 flex-col gap-5 @min-[900px]:sticky @min-[900px]:top-4 @min-[900px]:order-2 @min-[900px]:self-start">
              <MergeBox
                pr={pr}
                status={status}
                actions={!!prs.actions}
                busy={busy}
                onAct={act}
                onChecks={() => setTab("checks")}
              />
              <People pr={pr} />
              <section aria-label="Labels">
                <GroupHeading className="px-0!">Labels</GroupHeading>
                {pr.labels.length ? (
                  <div className="flex flex-wrap gap-1">
                    {pr.labels.map((l) => (
                      <Badge key={l} shape="pill">
                        {l}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-meta text-faint-foreground">None</p>
                )}
              </section>
            </aside>
            <article aria-label="Description" className="min-w-0">
              {pr.body.trim() ? (
                <GithubMarkdown text={pr.body} repo={pr.repo} onOpen={openOnGithub} />
              ) : (
                <EmptyState
                  icon={<icons.edit aria-hidden />}
                  title="No description"
                  body="The author didn't write one."
                  className="py-8"
                />
              )}
            </article>
          </div>
        </div>
      )}

      {tab === "checks" && (
        <ChecksTab
          checks={checks}
          actions={{
            onOpen: openOnGithub,
            onFix: fixCheck,
            log: prs.failureLog
              ? async (c) => {
                  const read = await prs.failureLog!(url, c.name);
                  if (read.error) return { error: describeError(read.error) };
                  const mine = read.result?.failures.find((f) => f.name === c.name);
                  return mine
                    ? { result: mine }
                    : {
                        error: "GitHub has no failed log for this check now. It may be re-running.",
                      };
                }
              : undefined,
            onRerun: prs.actions
              ? (c) =>
                  act(c.jobId ? "rerunJob" : "rerunFailed", {
                    jobId: c.jobId,
                    workflowRunId: c.runId,
                  })
              : undefined,
            onRerunFailed: prs.actions
              ? (runId) => act("rerunFailed", { workflowRunId: runId })
              : undefined,
          }}
        />
      )}

      {tab === "files" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {!prs.diff ? (
            <EmptyState
              icon={<icons.diff aria-hidden />}
              title="Files aren't available"
              body="This host's plxd can't read a pull request's diff."
            />
          ) : !diff ? (
            <DiffSkeleton />
          ) : diff.error ? (
            <EmptyState
              icon={<icons.error aria-hidden />}
              title="Couldn't read the diff"
              body={<span role="alert">{diff.error}</span>}
            />
          ) : (
            <ChangesDiff
              diff={diff.result!.diff}
              truncated={diff.result!.truncated}
              viewed={viewed}
              onViewed={(path, on) => {
                const next = new Set(viewed);
                if (on) next.add(path);
                else next.delete(path);
                setViewed(next);
              }}
              threads={threads}
              renderThread={(t) => <ReviewThread bare {...threadProps(t)} />}
              tree
            />
          )}
        </div>
      )}

      {tab === "activity" && (
        <Activity
          pr={pr}
          unresolved={unresolved}
          renderThread={(t) => <ReviewThread {...threadProps(t)} />}
          write={write}
          onOpen={openOnGithub}
        />
      )}

      {failure && (
        <p
          role="alert"
          className="flex items-center gap-2 border-t border-border px-4 py-2 text-meta text-danger"
        >
          <span className="min-w-0 flex-1">{failure}</span>
          {setUp}
        </p>
      )}

      <Menu ref={menu} id={`${id}-menu`} label="Pull request" align="end" className="w-80 p-1">
        <Item
          Icon={icons.question}
          label="Ask a question"
          hint="Adds the pull request to this thread's composer."
          onClick={() => compose(`${url} `, false)}
        />
        <Item
          Icon={icons.info}
          label="Explain this PR"
          hint="A walk through the diff and what to read closely."
          onClick={() =>
            compose(
              `Explain this pull request: ${url}. Walk me through the diff and point out what to read closely.`,
              true,
            )
          }
        />
        <Item
          Icon={icons.agent}
          label="Fix findings in this thread"
          hint="Review threads and failed checks, fixed and answered."
          onClick={() =>
            compose(
              `Fix the review findings on this pull request: ${url}. Read its review threads and checks with pull_request_status and failed checks' logs with ci_failure_log, fix what they found, push, and answer each thread you fixed with reply_to_review_thread.`,
              true,
            )
          }
        />
        {separator}
        <Item
          Icon={pr.draft ? icons.pullRequest : icons.draftPullRequest}
          label={pr.draft ? "Ready for review" : "Convert to draft"}
          disabled={busy || !open}
          onClick={() => act(pr.draft ? "ready" : "draft")}
        />
        {separator}
        <Item
          Icon={icons.external}
          label="Open on GitHub"
          onClick={() => {
            menu.current?.hidePopover();
            openOnGithub(pr.url);
          }}
        />
        <Item Icon={icons.copy} label="Copy link" onClick={() => copy(pr.url)} />
        <Item Icon={icons.copy} label="Copy PR number" onClick={() => copy(String(pr.number))} />
        {separator}
        <Item
          Icon={icons.closedPullRequest}
          label="Close pull request"
          danger
          disabled={busy || !open}
          onClick={() => {
            menu.current?.hidePopover();
            closeDialog.current?.showModal();
          }}
        />
      </Menu>

      <ConfirmDialog
        ref={closeDialog}
        title={`Close pull request #${pr.number}?`}
        action="Close pull request"
        onConfirm={() => {
          closeDialog.current?.close();
          act("close");
        }}
      >
        “{pr.title}” closes without merging. It can be reopened on GitHub.
      </ConfirmDialog>

      {shots && (
        <Lightbox
          images={shots.images}
          index={shots.index}
          onIndex={(index) => setShots({ ...shots, index })}
          onClose={() => setShots(undefined)}
        />
      )}
    </div>
  );
}

/** A tab's count, muted, or nothing for none. */
function Count({ n }: { n: number }) {
  return n ? <span className="text-meta text-faint-foreground tabular-nums">{n}</span> : null;
}

/**
 * The view's tabs, with a bar under the chosen one that slides to the next. Left and Right move
 * between them, as a tablist does.
 */
function Tabs({
  tab,
  onTab,
  tabs,
}: {
  tab: Tab;
  onTab: (tab: Tab) => void;
  tabs: { id: Tab; label: string; count?: ReactNode }[];
}) {
  const list = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ left: number; width: number }>();
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const chosen = el.querySelector<HTMLElement>('[aria-selected="true"]');
      if (chosen) setBar({ left: chosen.offsetLeft, width: chosen.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab]);
  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Pull request"
      onKeyDown={(e) => {
        const at = tabs.findIndex((t) => t.id === tab);
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        const next = tabs[(at + step + tabs.length) % tabs.length]!;
        onTab(next.id);
        list.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
      }}
      className="relative mt-2 -mb-px flex gap-4"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          data-tab={t.id}
          aria-selected={tab === t.id}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => onTab(t.id)}
          className="flex h-9 items-center gap-1.5 text-body text-muted-foreground transition-colors hover:text-foreground aria-selected:font-medium aria-selected:text-foreground"
        >
          {t.label}
          {t.count}
        </button>
      ))}
      {bar && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-0.5 rounded-full bg-foreground transition-[translate,width] duration-base ease-in-out"
          style={{ translate: `${bar.left}px 0`, width: bar.width }}
        />
      )}
    </div>
  );
}

/** The rail's reviewers: each one's latest verdict, then those asked who haven't reviewed. */
function People({ pr }: { pr: PullRequest }) {
  const latest = new Map<string, string>();
  for (const r of pr.reviews ?? [])
    if (r.state !== "commented" || !latest.has(r.author)) latest.set(r.author, r.state);
  const waiting = pr.reviewRequests.filter((who) => !latest.has(who));
  const verdict: Record<string, { Icon: typeof icons.success; color: string; text: string }> = {
    approved: { Icon: icons.success, color: "text-added", text: "Approved" },
    changesRequested: { Icon: icons.error, color: "text-danger", text: "Changes requested" },
    commented: { Icon: icons.comment, color: "text-muted-foreground", text: "Commented" },
    dismissed: { Icon: icons.skipped, color: "text-faint-foreground", text: "Dismissed" },
  };
  return (
    <section aria-label="Reviewers">
      <GroupHeading className="px-0!">Reviewers</GroupHeading>
      {latest.size + waiting.length === 0 ? (
        <p className="text-meta text-faint-foreground">None</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-body">
          {[...latest].map(([who, state]) => {
            const v = verdict[state] ?? verdict["commented"]!;
            return (
              <li key={who} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{who}</span>
                <v.Icon role="img" aria-label={v.text} className={`size-3.5 shrink-0 ${v.color}`} />
              </li>
            );
          })}
          {waiting.map((who) => (
            <li key={who} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{who}</span>
              <span className="text-meta text-faint-foreground">Requested</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Checks tab: its rollup, Failing and All, and the checks by workflow (CheckGroup). It opens
 * on Failing when one failed. Running times tick.
 */
function ChecksTab({ checks, actions }: { checks: Check[]; actions: CheckActions }) {
  const rollup = checkRollup(checks);
  const [filter, setFilter] = useState<"failing" | "all">(rollup.failed ? "failing" : "all");
  const running = rollup.pending > 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const shown = filter === "failing" ? checks.filter((c) => c.state === "failed") : checks;
  if (!checks.length)
    return (
      <EmptyState
        icon={<icons.skipped aria-hidden />}
        title="No checks"
        body="Nothing runs on this pull request's head commit."
        className="flex-1"
      />
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center gap-3 px-4 pt-3 pb-1">
        <p className="min-w-0 flex-1 truncate text-body text-muted-foreground">{rollup.words}</p>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "failing", name: `Failing ${rollup.failed}` },
            { value: "all", name: `All ${checks.length}` },
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <EmptyState
          icon={<icons.success aria-hidden />}
          title="Nothing failing"
          body={
            rollup.pending ? `${rollup.pending} still running.` : "Every check that ran passed."
          }
        />
      ) : (
        <div className="flex flex-col gap-3 px-4 pt-2 pb-6">
          {groupChecks(shown).map((g) => (
            <CheckGroup key={g.name} group={g} now={now} actions={actions} />
          ))}
        </div>
      )}
    </div>
  );
}

// ponytail: "long" by length, not rendered height; measure it if this cuts the wrong ones.
const isLong = (c: PrComment) => c.body.length > 600 || c.body.split("\n").length > 12;

/** A comment's card: its author, age, and Markdown, folded when long until Show full comment. */
function CommentCard({
  c,
  repo,
  onOpen,
}: {
  c: PrComment;
  repo: string;
  onOpen: (url: string) => void;
}) {
  const [full, setFull] = useState(false);
  const folded = isLong(c) && !full;
  return (
    <div className="rounded-xl border border-border px-4 py-3">
      <p className="text-meta">
        <span className="font-medium text-foreground">{c.author}</span>{" "}
        <span className="text-faint-foreground">{ago(c.createdAt)}</span>
      </p>
      <div
        className={`mt-2 ${folded ? "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" : ""}`}
      >
        <GithubMarkdown text={c.body} repo={repo} onOpen={onOpen} />
      </div>
      {folded && (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="mt-2 text-body text-muted-foreground hover:text-foreground"
        >
          Show full comment
        </button>
      )}
    </div>
  );
}

/** A review verdict in words, and its icon. A plain "commented" review shows as its comment. */
const verdicts: Record<string, { Icon: typeof icons.success; color: string; text: string }> = {
  commented: { Icon: icons.comment, color: "text-muted-foreground", text: "reviewed" },
  approved: { Icon: icons.success, color: "text-added", text: "approved these changes" },
  changesRequested: { Icon: icons.error, color: "text-danger", text: "requested changes" },
  dismissed: {
    Icon: icons.skipped,
    color: "text-faint-foreground",
    text: "had a review dismissed",
  },
};

/** One row of the timeline: its icon on the rail, a line of what happened, and what's under it. */
function TimelineEvent({
  Icon,
  color = "text-muted-foreground",
  title,
  sub,
  children,
}: {
  Icon: typeof icons.success;
  color?: string;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-5 before:absolute before:top-7 before:bottom-0 before:left-[11px] before:w-px before:bg-border last:before:hidden">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface">
        <Icon aria-hidden className={`size-4 ${color}`} />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-body">{title}</p>
        {sub && <p className="mt-0.5 text-meta text-faint-foreground">{sub}</p>}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

/**
 * The Activity tab: unresolved review threads first, each with reply and resolve; then the
 * timeline of commits, comments, reviews, and the merge, newest first unless flipped; then a box
 * to comment, approve, or request changes, through `pr/write` where plxd has it.
 */
function Activity({
  pr,
  unresolved,
  renderThread,
  write,
  onOpen,
}: {
  pr: PullRequest;
  unresolved: ThreadView[];
  renderThread: (t: ThreadView) => ReactNode;
  write?: (w: PrWrite) => Promise<boolean>;
  onOpen: (url: string) => void;
}) {
  const [oldestFirst, setOldestFirst] = useState(false);
  const events = timeline(pr, onOpen);
  if (!oldestFirst) events.reverse();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-5 px-4 pt-3 pb-6">
        {unresolved.length > 0 && (
          <section aria-label="Unresolved threads">
            <GroupHeading className="px-0!">Unresolved threads · {unresolved.length}</GroupHeading>
            <div className="flex flex-col gap-2">
              {unresolved.map((t, i) => (
                <Fragment key={t.id ?? i}>{renderThread(t)}</Fragment>
              ))}
            </div>
          </section>
        )}
        <section aria-label="Timeline">
          <GroupHeading
            className="px-0!"
            action={
              <Button size="sm" onClick={() => setOldestFirst(!oldestFirst)}>
                <icons.expand aria-hidden className={oldestFirst ? "rotate-180" : ""} />
                {oldestFirst ? "Oldest first" : "Newest first"}
              </Button>
            }
          >
            Timeline
          </GroupHeading>
          {events.length ? (
            <ol>
              {events.map((e) => (
                <Fragment key={e.key}>{e.node}</Fragment>
              ))}
            </ol>
          ) : (
            <p className="text-meta text-faint-foreground">Nothing yet.</p>
          )}
        </section>
        <ReviewBox write={write} open={pr.state === "open"} />
      </div>
    </div>
  );
}

/** Every event on a pull request, oldest first; a plain "commented" review shows as its comment. */
function timeline(pr: PullRequest, onOpen: (url: string) => void) {
  const events: { at: string; key: string; node: ReactNode }[] = [];
  if (pr.createdAt)
    events.push({
      at: pr.createdAt,
      key: "opened",
      node: (
        <TimelineEvent
          Icon={icons.pullRequest}
          color="text-added"
          title={
            <>
              <span className="font-medium">{pr.author}</span> opened this pull request
            </>
          }
          sub={ago(pr.createdAt)}
        />
      ),
    });
  for (const c of pr.commits ?? [])
    events.push({
      at: c.committedAt,
      key: `commit ${c.oid}`,
      node: (
        <TimelineEvent
          Icon={icons.commit}
          title={<span className="font-medium">{c.headline}</span>}
          sub={
            <>
              <span className="font-mono">{c.oid.slice(0, 7)}</span> · {c.author} ·{" "}
              {ago(c.committedAt)}
            </>
          }
        />
      ),
    });
  pr.comments.forEach((c, i) =>
    events.push({
      at: c.createdAt,
      key: `comment ${i}`,
      node: (
        <TimelineEvent
          Icon={icons.comment}
          title={
            <>
              <span className="font-medium">{c.author}</span> commented
            </>
          }
        >
          <CommentCard c={c} repo={pr.repo} onOpen={onOpen} />
        </TimelineEvent>
      ),
    }),
  );
  (pr.reviews ?? []).forEach((r, i) => {
    const verdict = verdicts[r.state];
    const said = pr.comments.some((c) => c.author === r.author && c.createdAt === r.submittedAt);
    if (!verdict || (r.state === "commented" && said)) return;
    events.push({
      at: r.submittedAt,
      key: `review ${i}`,
      node: (
        <TimelineEvent
          Icon={verdict.Icon}
          color={verdict.color}
          title={
            <>
              <span className="font-medium">{r.author}</span> {verdict.text}
            </>
          }
          sub={ago(r.submittedAt)}
        />
      ),
    });
  });
  const end = pr.mergedAt ?? (pr.state === "closed" ? pr.closedAt : undefined);
  if (end)
    events.push({
      at: end,
      key: "end",
      node: pr.mergedAt ? (
        <TimelineEvent
          Icon={icons.merged}
          color="text-project-violet"
          title={
            <>
              <span className="font-medium">{pr.mergedBy ?? "Someone"}</span> merged{" "}
              <span className="font-mono">{pr.headBranch}</span> into{" "}
              <span className="font-mono">{pr.baseBranch}</span>
            </>
          }
          sub={ago(end)}
        />
      ) : (
        <TimelineEvent
          Icon={icons.closedPullRequest}
          color="text-danger"
          title="Closed without merging"
          sub={ago(end)}
        />
      ),
    });
  return events.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The box at the end of Activity: a comment, sent as one, or as a review that approves or asks
 * for changes. Asking for changes needs words; approving doesn't. The text stays until GitHub
 * takes it. Without `write` (a plxd without `prWatch`) it says why it's missing.
 */
function ReviewBox({ write, open }: { write?: (w: PrWrite) => Promise<boolean>; open: boolean }) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState<string>();
  if (!write)
    return (
      <p className="text-meta text-faint-foreground">
        Commenting and reviewing need a newer plxd on this host.
      </p>
    );
  const send = async (kind: string, w: PrWrite) => {
    setSending(kind);
    if (await write(w)) setBody("");
    setSending(undefined);
  };
  const text = body.trim();
  return (
    <form
      aria-label="Comment"
      className="overflow-hidden rounded-xl border border-border bg-surface focus-within:border-faint-foreground/60"
      onSubmit={(e) => {
        e.preventDefault();
        if (text) void send("comment", { kind: "comment", body: text });
      }}
    >
      <textarea
        aria-label="Comment"
        placeholder="Leave a comment"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
        className="field-sizing-content block max-h-64 min-h-20 w-full resize-none bg-transparent px-3 py-2.5 text-body placeholder:text-faint-foreground focus-visible:outline-none"
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border px-2 py-2">
        {open && (
          <>
            <Button
              size="sm"
              disabled={!text || !!sending}
              onClick={() =>
                void send("changes", { kind: "review", event: "requestChanges", body: text })
              }
            >
              <icons.error aria-hidden />
              {sending === "changes" ? "Sending…" : "Request changes"}
            </Button>
            <Button
              size="sm"
              disabled={!!sending}
              onClick={() => void send("approve", { kind: "review", event: "approve", body: text })}
            >
              <icons.success aria-hidden />
              {sending === "approve" ? "Sending…" : "Approve"}
            </Button>
          </>
        )}
        <Button size="sm" variant="primary" type="submit" disabled={!text || !!sending}>
          {sending === "comment" ? "Sending…" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

/** A menu row: its icon, label, and an optional line under it. */
function Item({
  Icon,
  label,
  hint,
  danger,
  disabled,
  onClick,
}: {
  Icon: typeof icons.success;
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`${menuItem} ${hint ? "items-start" : ""} ${danger ? "text-danger" : ""} disabled:opacity-50 disabled:hover:bg-transparent`}
    >
      <span className="grid h-5 place-items-center">
        <Icon aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block leading-5">{label}</span>
        {hint && <span className="block text-meta text-faint-foreground">{hint}</span>}
      </span>
    </button>
  );
}

const separator = <div role="separator" className="-mx-1 my-1 h-px bg-border" />;

const bone = "animate-pulse rounded-sm bg-hover";

/** The view's shape while it's first read: header, tabs, and a few lines of body. */
function Skeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the pull request"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="border-b border-border px-4 pt-3 pb-3">
        <div className="flex h-7 items-center gap-2">
          <span className={`${bone} h-5 w-14`} />
          <span className={`${bone} h-3.5 w-40`} />
        </div>
        <div className={`${bone} mt-3 h-4 w-4/5`} />
        <div className={`${bone} mt-2 h-3 w-3/5`} />
        <div className="mt-4 flex gap-4">
          {[16, 14, 10, 14].map((w, i) => (
            <span key={i} className={`${bone} h-3.5`} style={{ width: `${w * 4}px` }} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-4 py-5">
        <div className={`${bone} h-24 w-full rounded-xl`} />
        {[100, 92, 96, 60].map((w, i) => (
          <div key={i} className={`${bone} h-3`} style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** The Files tab while its diff is read. */
function DiffSkeleton() {
  return (
    <div role="status" aria-label="Loading the diff" className="flex flex-col gap-2 px-3 py-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border">
          <div className={`${bone} h-10 rounded-none`} />
          <div className="flex flex-col gap-1.5 p-3">
            {[70, 90, 40].map((w, j) => (
              <div key={j} className={`${bone} h-3`} style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
