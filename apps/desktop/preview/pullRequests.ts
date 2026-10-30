// Made-up pull requests for the preview, shaped as plxd reports them: `pr/view`, `pr/status`,
// `pr/failureLog`, `pr/diff`, `pr/act`, and `pr/write`. #588 is open with a failed check, a
// review thread, and a rich description; #591 is merged; #612 is clean; #41 is behind.
import type {
  PrAction,
  PrCheck,
  PrStatusResult,
  PrWrite,
  PullRequest,
} from "../src/protocol/generated/protocol";

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const titles: Record<number, string> = {
  588: "Follow nightlies from a nightly build, and keep the channel in the build's own metadata",
  591: "Plainer copy on the first-run screens",
  612: "Pin the AUR package to the nightly's AppImages",
  41: "Move the pricing table to the shared grid",
};

const body = `Nightly builds read **Latest** today, so a nightly never updates to the next nightly. This keeps the channel in the build's own metadata (0028) and has the updater follow it.

<p align="center">
  <img src="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png" width="96" alt="GitHub mark">
</p>

## What changed

- [x] \`channel\` is written into \`app-update.yml\` at build time
- [x] The updater reads it instead of a setting
- [ ] Settings shows the channel, read-only

| Build | Follows | Before |
| --- | --- | --- |
| Nightly | Nightlies | Latest |
| Stable | Latest | Latest |

> [!NOTE]
> A stable build that's promoted from a nightly keeps \`stable\` (0051).

> [!WARNING]
> Anyone on a nightly older than v2610.12900 needs one manual update.

<details>
<summary>How it was tested</summary>

1. Built a nightly with \`channel: nightly\` and served two feeds locally.
2. Pressed <kbd>⌘</kbd><kbd>R</kbd> in About to check, and it found the newer nightly.
3. H<sub>2</sub>O stays H<sub>2</sub>O.<br>Line two after a break.

</details>

Fixes #571 and ryan-stoffel/parallax-site#12. Thanks @ryan-stoffel for the report in 3f9a2c1e[^1].

[^1]: The commit that first wrote \`channel\` into the build.
`;

const checkNames = ["lint", "types", "test (macos)", "test (linux)", "test (windows)", "e2e"];

function checksOf(n: number): PrCheck[] {
  const ci: PrCheck[] = checkNames.map((name, i) => {
    const failed = n === 588 && name === "test (windows)";
    const running = n === 41 && i > 3;
    return {
      name,
      state: failed ? "failed" : running ? "pending" : "passed",
      ...(!running && { conclusion: failed ? "failure" : "success" }),
      url: `https://github.com/ryan-stoffel/parallax/actions/runs/9${n}/job/${i + 1}`,
      workflow: "CI",
      startedAt: at(40 - i),
      ...(!running && { completedAt: at(34 - i) }),
    };
  });
  return [
    ...ci,
    {
      name: "bench",
      state: "passed",
      conclusion: "success",
      url: `https://github.com/ryan-stoffel/parallax/actions/runs/8${n}/job/1`,
      workflow: "Bench",
      startedAt: at(40),
      completedAt: at(31),
    },
    {
      name: "ci",
      state: n === 588 ? "failed" : "passed",
      workflow: "CI",
      startedAt: at(30),
      completedAt: at(29),
      conclusion: n === 588 ? "failure" : "success",
    },
    { name: "Vercel", state: "skipped", url: "https://vercel.com/ryan-stoffel/parallax" },
  ];
}

const files = [
  { path: "apps/desktop/src/main/updater.ts", additions: 42, deletions: 18 },
  { path: "apps/desktop/src/main/updater.test.ts", additions: 36, deletions: 2 },
  { path: "apps/desktop/electron-builder.yml", additions: 3, deletions: 1 },
  { path: "docs/decisions/0028-release-channels.md", additions: 6, deletions: 0 },
];

/** Each pull request as GitHub has it now, changed by the preview's actions and writes. */
const live = new Map<number, PullRequest>();

function view(url: string): PullRequest {
  const number = Number(url.split("/").pop());
  const known = live.get(number);
  if (known) return known;
  const merged = number === 591;
  const pr: PullRequest = {
    number,
    title: titles[number] ?? `Pull request ${number}`,
    url,
    repo: url.split("/").slice(3, 5).join("/"),
    state: merged ? "merged" : "open",
    draft: false,
    author: "ryan-stoffel",
    updatedAt: at(number === 588 ? 4 : 30),
    baseBranch: "develop",
    headBranch: number === 588 ? "feature/PLX-912-nightly-channel" : `feature/${number}`,
    changedFiles: files.length,
    additions: 87,
    deletions: 21,
    files,
    body: number === 588 ? body : "Copy-only change. No behavior moves.",
    comments: [
      {
        author: "claude-reviewer",
        body: "Verdict: changes needed\n\n- `test (windows)` fails on the path join in `updater.ts:88`.\n- The read-only channel row isn't in Settings yet.",
        createdAt: at(20),
      },
      { author: "ryan-stoffel", body: "Fixing the Windows path now.", createdAt: at(12) },
    ],
    reviewRequests: ["claude-reviewer", "release-team"],
    labels: number === 591 ? ["docs"] : ["feature", "app", "release"],
    checks: checksOf(number),
    checksState: number === 588 ? "failed" : number === 41 ? "pending" : "passed",
    createdAt: at(60 * 5),
    commits: [
      {
        oid: "3f9a2c1e8b7d",
        headline: "feat: write the channel into the build",
        author: "ryan-stoffel",
        committedAt: at(60 * 5),
      },
      {
        oid: "a41c09d2e3f4",
        headline: "test: the updater follows its channel",
        author: "ryan-stoffel",
        committedAt: at(60 * 3),
      },
    ],
    reviews: [{ author: "claude-reviewer", state: "changesRequested", submittedAt: at(19) }],
    mergeState: merged
      ? undefined
      : number === 588
        ? "blocked"
        : number === 41
          ? "behind"
          : "clean",
    ...(merged && { mergedAt: at(90), mergedBy: "ryan-stoffel", closedAt: at(90) }),
  };
  live.set(number, pr);
  return pr;
}

function status(url: string): PrStatusResult {
  const pr = view(url);
  const checks = pr.checks.map((c) => ({
    name: c.name,
    how: c.state === "failed" ? (c.conclusion ?? "failure") : c.state,
    required: c.name.startsWith("test") || c.name === "ci",
    url: c.url,
    ...(c.workflow && { runId: 9000 + pr.number }),
  }));
  const threads =
    pr.number === 588 && !resolved.has(url)
      ? [
          {
            id: "PRRT_588_1",
            path: "apps/desktop/src/main/updater.ts",
            author: "claude-reviewer",
            body: "This joins with `/`, which breaks on Windows. Use `path.join`.",
            url: `${url}#discussion_r1`,
          },
        ]
      : [];
  const failing = checks.filter((c) => !["passed", "pending", "skipped"].includes(c.how));
  const reasons = [
    ...(failing.length
      ? [`${failing.length} checks failed: ${failing.map((c) => c.name).join(", ")}.`]
      : []),
    ...(threads.length ? [`${threads.length} unresolved review thread.`] : []),
    ...(pr.reviews?.some((r) => r.state === "changesRequested") ? ["Changes were requested."] : []),
  ];
  return {
    url,
    title: pr.title,
    body: pr.body,
    state: pr.state.toUpperCase(),
    draft: pr.draft,
    headSha: "a41c09d2e3f4",
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    files,
    behindBy: pr.mergeState === "behind" ? 3 : 0,
    mergeable: "MERGEABLE",
    mergeState: (pr.mergeState ?? "unknown").toUpperCase(),
    reviewDecision: "CHANGES_REQUESTED",
    failing,
    pending: checks.filter((c) => c.how === "pending").map((c) => c.name),
    passed: checks.filter((c) => c.how === "passed").map((c) => c.name),
    checks,
    unresolvedThreads: threads,
    watching: false,
    ready: pr.state === "open" && reasons.length === 0,
    reasons: pr.state === "open" ? reasons : [],
  };
}

const resolved = new Set<string>();

const windowsLog = `Run pnpm test
 FAIL  src/main/updater.test.ts > follows the build's channel
AssertionError: expected 'C:\\\\Users\\\\runner/app-update.yml' to be 'C:\\\\Users\\\\runner\\\\app-update.yml'
 ❯ src/main/updater.test.ts:41:22
     39|   const feed = feedPath(app);
     40|   expect(channelOf(feed)).toBe("nightly");
     41|   expect(feed).toBe(join(home, "app-update.yml"));
       |                      ^
 Test Files  1 failed | 63 passed (64)
Error: Process completed with exit code 1.`;

const diff = `diff --git a/apps/desktop/src/main/updater.ts b/apps/desktop/src/main/updater.ts
index 1a2b3c4..5d6e7f8 100644
--- a/apps/desktop/src/main/updater.ts
+++ b/apps/desktop/src/main/updater.ts
@@ -80,12 +80,18 @@ export function startUpdater(app: App) {
   const updater = new AppUpdater();
-  // Every build reads Latest.
-  updater.channel = "latest";
+  // A build follows the channel it was built for (0028).
+  const channel = channelOf(feedPath(app));
+  updater.channel = channel;
+  updater.allowPrerelease = channel === "nightly";
   updater.autoDownload = true;

-function feedPath(app: App) {
-  return app.getPath("userData") + "/app-update.yml";
+/** Where electron-builder wrote the build's update metadata. */
+export function feedPath(app: App) {
+  return \`\${app.getPath("userData")}/app-update.yml\`;
 }
+
+export const channelOf = (feed: string) =>
+  /channel:\\s*(\\w+)/.exec(readFileSync(feed, "utf8"))?.[1] ?? "latest";
diff --git a/apps/desktop/src/main/updater.test.ts b/apps/desktop/src/main/updater.test.ts
index 2b3c4d5..6e7f8a9 100644
--- a/apps/desktop/src/main/updater.test.ts
+++ b/apps/desktop/src/main/updater.test.ts
@@ -36,6 +36,12 @@ describe("updater", () => {
   test("starts", () => {
     expect(startUpdater(app)).toBeDefined();
   });
+
+  test("follows the build's channel", () => {
+    const feed = feedPath(app);
+    expect(channelOf(feed)).toBe("nightly");
+    expect(feed).toBe(join(home, "app-update.yml"));
+  });
 });
diff --git a/apps/desktop/electron-builder.yml b/apps/desktop/electron-builder.yml
index 3c4d5e6..7f8a9b0 100644
--- a/apps/desktop/electron-builder.yml
+++ b/apps/desktop/electron-builder.yml
@@ -12,3 +12,5 @@ publish:
   provider: github
-  releaseType: release
+  releaseType: \${env.RELEASE_TYPE}
+  channel: \${env.CHANNEL}
diff --git a/docs/decisions/0028-release-channels.md b/docs/decisions/0028-release-channels.md
index 4d5e6f7..8a9b0c1 100644
--- a/docs/decisions/0028-release-channels.md
+++ b/docs/decisions/0028-release-channels.md
@@ -20,3 +20,9 @@ A stable release is a promoted nightly.

 ## Consequences
+
+- A build's channel is in its own metadata, so a nightly follows nightlies.
`;

const merge = (n: number, change: Partial<PullRequest>) => {
  const pr = { ...live.get(n)!, ...change, updatedAt: new Date().toISOString() };
  live.set(n, pr);
  return pr;
};

/** The preview's pull request handlers, keyed by method. */
export const pullRequestHandlers = {
  "pr/view": (p: { url: string }) => view(p.url),
  "pr/status": (p: { url: string }) => status(p.url),
  "pr/failureLog": (p: { url: string; check?: string }) => ({
    url: p.url,
    headSha: "a41c09d2e3f4",
    failures: view(p.url)
      .checks.filter((c) => c.state === "failed")
      .filter((c) => !p.check || c.name.toLowerCase().includes(p.check.toLowerCase()))
      .map((c) => ({
        name: c.name,
        how: c.conclusion ?? "failure",
        workflowRunId: 9588,
        jobId: 5,
        url: c.url,
        log: c.name === "ci" ? "One or more jobs failed: test (windows)." : windowsLog,
      })),
  }),
  "pr/diff": () => ({ diff, truncated: false }),
  "pr/act": (p: { url: string; action: PrAction }) => {
    const n = view(p.url).number;
    if (p.action === "merge" || p.action === "squash")
      return merge(n, {
        state: "merged",
        mergedAt: new Date().toISOString(),
        mergedBy: "ryan-stoffel",
        mergeState: undefined,
      });
    if (p.action === "draft" || p.action === "ready")
      return merge(n, { draft: p.action === "draft" });
    if (p.action === "autoMerge") return merge(n, { autoMerge: "merge" });
    if (p.action === "disableAutoMerge") return merge(n, { autoMerge: undefined });
    return merge(n, { state: "closed", closedAt: new Date().toISOString() });
  },
  "pr/write": (p: { url: string; write: PrWrite }) => {
    const pr = view(p.url);
    const w = p.write;
    if (w.kind === "replyToThread" && w.resolve) resolved.add(p.url);
    if (
      w.kind === "comment" ||
      (w.kind === "review" && w.body) ||
      (w.kind === "replyToThread" && w.body)
    )
      merge(pr.number, {
        comments: [
          ...pr.comments,
          { author: "ryan-stoffel", body: w.body!, createdAt: new Date().toISOString() },
        ],
      });
    return { url: p.url };
  },
};
