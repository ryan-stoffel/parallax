// What the preview's mock plxd holds: one host, "macbook", with the parallax repository, a busy
// Project on it with a coordinator and seven children, a quiet second Project, and a few plain
// threads. Times are relative to when the page loads, so ages in the sidebar read as recent.
import type {
  AccountLimits,
  AccountUsage,
  AgentCommand,
  AgentOutputItem,
  AgentRun,
  AgentRunState,
  ContextFile,
  DetectedCli,
  InboxItem,
  JsonValue,
  KeyAccount,
  MemoryFile,
  MemoryKind,
  ParallaxEvent,
  Project,
  ProviderInfo,
  Question,
  Repo,
  Thread,
  UsageDay,
  UsageSessions,
  UsageHour,
} from "../src/protocol/generated/protocol";

export const HOME = "/Users/ryan";
export const PARALLAX_PATH = `${HOME}/Developer/personal/parallax`;
export const DOCS_PATH = `${HOME}/Developer/personal/docs-site`;

/** A run's logged event, before the mock numbers it. */
export interface RunEvent {
  time: string;
  event: ParallaxEvent;
}

export interface MemoryDoc {
  file: MemoryFile;
  content: string;
}

export interface ContextDoc {
  file: ContextFile;
  content: string;
}

export interface Fixtures {
  repos: Repo[];
  projects: Project[];
  threads: Thread[];
  runs: AgentRun[];
  /** By run id, oldest first. */
  events: Record<string, RunEvent[]>;
  /** By Project id. */
  inbox: Record<string, InboxItem[]>;
  questions: Record<string, Question[]>;
  context: Record<string, ContextDoc[]>;
  /** By scope key: `you`, `repo:<id>`, `project:<id>`. */
  memory: Record<string, MemoryDoc[]>;
  providers: ProviderInfo[];
  clis: DetectedCli[];
  keys: KeyAccount[];
  usage: AccountUsage[];
  limits: AccountLimits[];
  usageHours: UsageHour[];
  usageDays: UsageDay[];
  usageSessions: UsageSessions[];
  commands: AgentCommand[];
  repoFiles: string[];
}

// Fixed ids, shaped like the version 7 UUIDs plxd wants.
const uuid = (n: number) =>
  `0199a6f0-${(0x1000 + n).toString(16)}-7a4c-8e21-5b3f0c9d${(0x1000 + n).toString(16)}`;

export const ids = {
  repoParallax: uuid(1),
  repoDocs: uuid(2),
  repoScratch: uuid(3),
  projectParallax: uuid(10),
  projectDocs: uuid(11),
  coordinator: uuid(20),
  retry: uuid(21),
  palette: uuid(22),
  proposals: uuid(23),
  scheduler: uuid(24),
  inboxRead: uuid(25),
  brief: uuid(26),
  iconPicker: uuid(27),
  updater: uuid(40),
  onboarding: uuid(41),
  tahoe: uuid(42),
  scratchThread: uuid(43),
  docsSearch: uuid(44),
  docsLinks: uuid(45),
  questionInbox: uuid(60),
  questionPalette: uuid(61),
  approvalScheduler: uuid(70),
} as const;

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5";
const GPT = "gpt-6.1-sol";

/** Builds fixtures with times counted back from `now`. */
export function createFixtures(now = Date.now()): Fixtures {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const ahead = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);

  const repos: Repo[] = [
    {
      id: ids.repoParallax,
      name: "parallax",
      path: PARALLAX_PATH,
      icon: { name: "orbit", color: "violet" },
      createdAt: ago(60 * 24 * 40),
    },
    {
      id: ids.repoDocs,
      name: "docs-site",
      path: DOCS_PATH,
      createdAt: ago(60 * 24 * 12),
    },
    {
      id: ids.repoScratch,
      name: "No Repo",
      path: `${HOME}/.parallax/scratch`,
      scratch: true,
      createdAt: ago(60 * 24 * 40),
    },
  ];

  const projects: Project[] = [
    {
      id: ids.projectParallax,
      name: "parallax",
      icon: { name: "orbit", color: "violet" },
      repoPath: PARALLAX_PATH,
      branch: "develop",
      coordinator: ids.coordinator,
      permission: "auto",
      autonomy: "routine",
      baseBranch: "develop",
      integrationBranch: "parallax/parallax",
      createdAt: ago(60 * 24 * 6),
      updatedAt: ago(3),
    },
    {
      id: ids.projectDocs,
      name: "docs-site",
      icon: { name: "book-open", color: "green" },
      repoPath: DOCS_PATH,
      branch: "main",
      permission: "auto",
      autonomy: "ask",
      createdAt: ago(60 * 26),
      updatedAt: ago(60 * 26),
    },
  ];

  const runs: AgentRun[] = [];
  const threads: Thread[] = [];
  const events: Record<string, RunEvent[]> = {};

  /** A run's log: `agent.started`, then output and updates, in order. */
  const log = (run: AgentRun) => {
    const list: RunEvent[] = [];
    events[run.id] = list;
    const started: AgentRun = {
      ...run,
      status: "running",
      error: undefined,
      diff: undefined,
      updatedAt: run.createdAt,
    };
    list.push({
      time: run.createdAt,
      event: { kind: "agent.started", runId: run.id, run: started },
    });
    const api = {
      out(at: string, ...items: AgentOutputItem[]) {
        list.push({ time: at, event: { kind: "agent.output", runId: run.id, items } });
        return api;
      },
      update(at: string, change: Partial<AgentRunState> = {}) {
        const state: AgentRunState = {
          status: run.status,
          accountId: run.accountId,
          backend: run.backend,
          sessionId: run.sessionId,
          error: run.error,
          diff: run.diff,
          model: run.model,
          effort: run.effort,
          contextWindow: run.contextWindow,
          fast: run.fast,
          permission: run.permission,
          pullRequests: run.pullRequests,
          updatedAt: at,
          ...change,
        };
        list.push({ time: at, event: { kind: "agent.updated", runId: run.id, state } });
        return api;
      },
      finish(at: string, outcome: Extract<ParallaxEvent, { kind: "agent.finished" }>["outcome"]) {
        list.push({ time: at, event: { kind: "agent.finished", runId: run.id, outcome } });
        return api;
      },
      raw(at: string, event: ParallaxEvent) {
        list.push({ time: at, event });
        return api;
      },
    };
    return api;
  };

  let call = 0;
  const callId = () => `toolu_01Prev${(++call).toString().padStart(4, "0")}`;
  /** A tool call and its result, as two items. */
  const tool = (
    name: string,
    input: JsonValue,
    output?: string,
    status: "ok" | "error" | "denied" = "ok",
  ): AgentOutputItem[] => {
    const id = callId();
    return [
      { kind: "toolCall", callId: id, name, input },
      { kind: "toolResult", callId: id, status, ...(output !== undefined && { output }) },
    ];
  };
  const session = (model = OPUS): AgentOutputItem => ({
    kind: "sessionStarted",
    sessionId: `sess_${(++call).toString(36)}9f2c41d`,
    model,
  });
  const usageItem = (input: number, output: number): AgentOutputItem => ({
    kind: "usage",
    model: OPUS,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: input * 6,
    cacheWriteTokens: Math.round(input / 3),
    costUsdMicros: Math.round((input * 15 + output * 75) / 1),
  });

  // ---- The coordinator -------------------------------------------------------------------

  const coordinatorPrompt =
    "Pick up the M4 inbox work and the scheduler spill. Keep me out of anything routine.";
  const coordinator: AgentRun = {
    id: ids.coordinator,
    project: ids.projectParallax,
    prompt: coordinatorPrompt,
    policy: "noWrite",
    status: "completed",
    backend: "claude",
    accountId: "claude",
    sessionId: "sess_coord_7f31a2",
    model: OPUS,
    effort: "high",
    contextWindow: 1_000_000,
    permission: "auto",
    approvals: true,
    worktreePath: PARALLAX_PATH,
    createdAt: ago(185),
    updatedAt: ago(6),
  };
  runs.push(coordinator);

  /** A Project child the coordinator launched: its run and its thread. */
  const child = (c: {
    id: string;
    title: string;
    slug: string;
    prompt: string;
    status: AgentRun["status"];
    started: number;
    updated: number;
    model?: string;
    backend?: string;
    diff?: { files: number; insertions: number; deletions: number };
    error?: string;
  }) => {
    const backend = c.backend ?? "claude";
    const run: AgentRun = {
      id: c.id,
      project: ids.projectParallax,
      prompt: c.prompt,
      policy: "workspaceWrite",
      status: c.status,
      backend,
      accountId: backend,
      branch: `parallax/${c.slug}`,
      worktreePath: `${HOME}/.parallax/worktrees/parallax/${c.slug}`,
      sessionId: `sess_${c.slug.slice(0, 6)}_${c.started}`,
      coordinatorThread: ids.coordinator,
      model: c.model ?? OPUS,
      effort: "high",
      contextWindow: backend === "claude" ? 1_000_000 : 272_000,
      permission: "auto",
      approvals: true,
      ...(c.diff && {
        diff: {
          commit: `${c.slug.length.toString(16)}e4b9c1d07a2f53e8b6c4d190a7f2e3b5c8d1f0`,
          ...c.diff,
        },
      }),
      ...(c.error && { error: c.error }),
      createdAt: ago(c.started),
      updatedAt: ago(c.updated),
    };
    runs.push(run);
    threads.push({
      id: c.id,
      repo: ids.projectParallax,
      parent: ids.coordinator,
      title: c.title,
      createdAt: ago(c.started),
      lastPromptAt: ago(c.started),
    });
    return run;
  };

  const retry = child({
    id: ids.retry,
    title: "Retry failed update downloads",
    slug: "retry-update-downloads",
    prompt:
      "Retry failed update downloads. When electron-updater's download fails mid-way (a dropped connection, a 5xx from GitHub's CDN), the Update button sits on the error until the app restarts. Retry with backoff (2s, 8s, 30s), keep the partial file when the server supports ranges, and say \"Retrying…\" on the button meanwhile. Cover it in Update.test.ts.",
    status: "completed",
    started: 172,
    updated: 41,
    diff: { files: 4, insertions: 142, deletions: 37 },
  });
  const palette = child({
    id: ids.palette,
    title: "Command palette for project actions",
    slug: "project-command-palette",
    prompt:
      "Add a command palette (Mod+K) for project actions: open a Project, start a task, open its Context, Memory, or Agents view, and jump to any child by title. Reuse ui.tsx's menu styles and keybindings.ts, and keep it keyboard-first.",
    status: "running",
    started: 168,
    updated: 2,
  });
  const proposals = child({
    id: ids.proposals,
    title: "Memory proposals from child threads",
    slug: "memory-proposals",
    prompt:
      "Show memory proposals from a Project's children in the coordinator's wake-up, and let the coordinator save or discard each with memory_write. A plain thread's proposal waits for the user in the Memory panel (0044).",
    status: "running",
    started: 160,
    updated: 1,
    model: SONNET,
  });
  const scheduler = child({
    id: ids.scheduler,
    title: "Scheduler: spill to devbox when Claude is capped",
    slug: "scheduler-spill-devbox",
    prompt:
      "Scheduler: when the Claude subscription on this host reports its five-hour window above 90%, start new Project children on the devbox host instead, over plxd attach. Read the limit from usage/get, keep the choice per Project, and say where each child went in its row.",
    status: "running",
    started: 150,
    updated: 4,
  });
  const inboxRead = child({
    id: ids.inboxRead,
    title: "Inbox read state",
    slug: "inbox-read-state",
    prompt:
      "Inbox read state: mark a Project's inbox items seen when the user opens them or scrolls past them, with inbox/seen, and keep the unread count on the Project's sidebar row in step.",
    status: "running",
    started: 120,
    updated: 3,
    model: GPT,
    backend: "codex",
  });
  const brief = child({
    id: ids.brief,
    title: "Brief editor",
    slug: "brief-editor",
    prompt:
      "Brief editor: let the user edit a Project's brief.md in the Memory panel with the same Markdown editor as the composer, saving with memory_write. Show the last writer and when.",
    status: "completed",
    started: 110,
    updated: 23,
    diff: { files: 3, insertions: 96, deletions: 12 },
  });
  const iconPicker = child({
    id: ids.iconPicker,
    title: "Project icon picker in light mode",
    slug: "icon-picker-light-mode",
    prompt:
      "Project icon picker in light mode: the swatches for yellow and gray drop below 3:1 against the light popover. Adjust the --project-* light tokens so every swatch passes, and update IconPicker.test.tsx's contrast check.",
    status: "failed",
    started: 95,
    updated: 52,
    error: "pnpm test failed: IconPicker.test.tsx contrast check still fails for yellow (2.7:1).",
  });

  // The coordinator's transcript: the user's ask, its plan, five launches, a status board, and
  // a wake-up after two children finished.
  const launch = (run: AgentRun, title: string) =>
    tool(
      "mcp__plxd__thread_launch",
      { project: ids.projectParallax, title, prompt: run.prompt },
      JSON.stringify({
        runId: run.id,
        status: "starting",
        title,
        prompt: run.prompt.split("\n")[0],
        branch: run.branch,
      }),
    );
  log(coordinator)
    .out(
      ago(185),
      session(),
      { kind: "turnStarted" },
      {
        kind: "reasoning",
        text: "Two threads of work: M4's inbox (read state, proposals from children, the brief) and the scheduler spill to the devbox. Check the board and the open issues first, then split them into children that don't touch the same files.",
      },
      ...tool("mcp__plxd__read_context", { path: "notes.md" }, "# parallax\n\n## Now\n\n(empty)"),
      ...tool(
        "mcp__plxd__thread_list",
        { project: ids.projectParallax },
        JSON.stringify({ runs: [] }),
      ),
      ...tool(
        "Bash",
        {
          command: "gh issue list --milestone M4 --state open --limit 20",
          description: "List open M4 issues",
        },
        "PLX-488  Inbox read state                       feature  app\nPLX-489  Memory proposals from child threads    feature  daemon\nPLX-490  Brief editor                           feature  app\nPLX-491  Retry failed update downloads          bug      app\nPLX-492  Command palette for project actions    feature  app\nPLX-493  Icon picker swatches fail in light     bug      app\nPLX-497  Scheduler: spill to devbox when capped feature  daemon",
      ),
    )
    .out(ago(184), {
      kind: "text",
      text: "Seven open M4 issues, and none of them overlap much. I'll run them as separate children, all in auto mode on the integration branch `parallax/parallax`:\n\n- **Inbox read state**, **Memory proposals**, and **Brief editor** for the inbox work\n- **Scheduler: spill to devbox** for the scheduler\n- **Retry failed update downloads**, **Command palette**, and the **icon picker** contrast fix, since they're small and independent\n\nI'll answer routine questions myself and only bring you the ones that change behavior you'd notice.",
    })
    .out(ago(183), ...launch(retry, "Retry failed update downloads"))
    .out(ago(182), ...launch(palette, "Command palette for project actions"))
    .out(ago(181), ...launch(proposals, "Memory proposals from child threads"))
    .out(ago(180), ...launch(scheduler, "Scheduler: spill to devbox when Claude is capped"))
    .out(ago(179), ...launch(inboxRead, "Inbox read state"))
    .out(ago(178), ...launch(brief, "Brief editor"))
    .out(ago(177), ...launch(iconPicker, "Project icon picker in light mode"))
    .out(
      ago(176),
      ...tool(
        "mcp__plxd__write_context",
        { path: "notes.md", content: "# parallax\n\n## Now\n…" },
        "Wrote notes.md (1.4 KB)",
      ),
      {
        kind: "text",
        text: "All seven are running. The status board is `notes.md` in shared context, and I'll keep it current as they report back. You'll hear from me when something needs a decision.",
      },
      usageItem(48_200, 3_900),
      { kind: "turnFinished" },
    )
    .update(ago(176), { status: "completed" })
    .finish(ago(176), { status: "completed" })
    .update(ago(41), { status: "running" })
    .out(
      ago(41),
      {
        kind: "turnStarted",
        turnId: uuid(90),
        wake: true,
        text: 'Finished: Retry failed update downloads (completed, 4 files +142 -37). Command palette for project actions asked: "Should Mod+K open over an open dialog, or wait for it to close?", assuming "Wait for it to close".',
      },
      {
        kind: "reasoning",
        text: "The palette question is routine: every other shortcut waits for open dialogs, so it should too. Answer it myself. Check the retry diff before marking it ready.",
      },
      ...tool(
        "mcp__plxd__answer",
        { question: ids.questionPalette, text: "Wait for it to close, as Mod+N does." },
        JSON.stringify({ status: "decided" }),
      ),
      ...tool(
        "mcp__plxd__thread_read",
        { runId: retry.id },
        JSON.stringify({
          runId: retry.id,
          status: "completed",
          prompt: retry.prompt.split(".")[0],
        }),
      ),
    )
    .out(
      ago(40),
      ...tool(
        "mcp__plxd__memory_write",
        {
          scope: "project",
          path: "memory/convention/shortcuts-wait-for-dialogs.md",
          title: "Shortcuts wait for an open dialog to close",
        },
        "Saved memory/convention/shortcuts-wait-for-dialogs.md",
      ),
      {
        kind: "text",
        text: "**Retry failed update downloads** is done: 4 files, +142 −37, with retries at 2s, 8s, and 30s and range resumes. Tests pass; it's ready to land when you are.\n\nI answered the palette's question myself (Mod+K waits for an open dialog, like Mod+N) and saved that as a convention.\n\nOne thing does need you: **Inbox read state** is asking whether scrolling past an item should mark it seen. It's waiting for you in the inbox.",
      },
      usageItem(31_800, 1_250),
      { kind: "turnFinished" },
    )
    .update(ago(40), { status: "completed" })
    .finish(ago(40), { status: "completed" })
    .update(ago(6), { status: "completed", updatedAt: ago(6) });

  // ---- The children's transcripts -----------------------------------------------------------

  log(retry)
    .out(
      ago(172),
      session(),
      { kind: "turnStarted" },
      {
        kind: "todoList",
        items: [
          { text: "Read Update.tsx and main's updater wiring", status: "completed" },
          { text: "Retry downloads with backoff", status: "completed" },
          { text: "Resume partial downloads with ranges", status: "completed" },
          { text: "Show Retrying… on the button", status: "completed" },
          { text: "Tests", status: "completed" },
        ],
      },
      ...tool("Read", { file_path: "apps/desktop/src/main/updater.ts" }, "…"),
      ...tool(
        "Grep",
        { pattern: "download-progress|error", path: "apps/desktop/src" },
        "src/main/updater.ts:88\nsrc/renderer/Update.tsx:41",
      ),
      ...tool(
        "Edit",
        {
          file_path: "apps/desktop/src/main/updater.ts",
          old_string: 'autoUpdater.on("error"',
          new_string: 'autoUpdater.on("error"',
        },
        "The file has been updated.",
      ),
      ...tool(
        "Bash",
        {
          command: "corepack pnpm exec vp test run src/renderer/Update.test.ts",
          description: "Run the updater tests",
        },
        " ✓ src/renderer/Update.test.ts (14 tests) 212ms\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)",
      ),
      {
        kind: "text",
        text: "Downloads now retry three times with backoff (2s, 8s, 30s). A partial file resumes with a `Range` request when the CDN answers with `Accept-Ranges: bytes`, and starts over otherwise. The button says **Retrying…** meanwhile, and the last error only shows once every retry fails.\n\nCommitted on `parallax/retry-update-downloads`: 4 files, +142 −37.",
      },
      usageItem(62_000, 5_400),
      { kind: "turnFinished" },
    )
    .update(ago(41), { status: "completed" })
    .finish(ago(41), { status: "completed" });

  log(palette)
    .out(
      ago(168),
      session(),
      { kind: "turnStarted" },
      {
        kind: "todoList",
        items: [
          { text: "Survey keybindings.ts and the existing menus", status: "completed" },
          { text: "Palette component with fuzzy search", status: "completed" },
          { text: "Project actions as commands", status: "inProgress" },
          { text: "Jump to a child by title", status: "pending" },
          { text: "Tests and keyboard checks", status: "pending" },
        ],
      },
      ...tool("Read", { file_path: "apps/desktop/src/renderer/keybindings.ts" }, "…"),
      ...tool(
        "mcp__plxd__ask",
        {
          question: "Should Mod+K open over an open dialog, or wait for it to close?",
          assumption: "Wait for it to close",
        },
        JSON.stringify({ status: "open" }),
      ),
      ...tool(
        "Write",
        { file_path: "apps/desktop/src/renderer/CommandPalette.tsx" },
        "File created successfully.",
      ),
      {
        kind: "text",
        text: "The palette opens with Mod+K and lists the open Project's actions first. Wiring the child list next.",
      },
    )
    .out(
      ago(40),
      {
        kind: "turnStarted",
        turnId: uuid(91),
        from: ids.coordinator,
        text: "Wait for it to close, as Mod+N does.",
      },
      { kind: "text", text: "Got it: Mod+K now waits for an open dialog to close, like Mod+N." },
      ...tool(
        "Edit",
        { file_path: "apps/desktop/src/renderer/App.tsx" },
        "The file has been updated.",
      ),
    )
    .out(
      ago(2),
      ...tool("Bash", {
        command: "corepack pnpm exec vp test run src/renderer/CommandPalette.test.tsx",
        description: "Run the palette tests",
      }),
    );

  log(proposals)
    .out(
      ago(160),
      session(SONNET),
      { kind: "turnStarted" },
      ...tool("Read", { file_path: "daemon/src/mcp/memory.rs" }, "…"),
      ...tool("Read", { file_path: "docs/decisions/0044-memory.md" }, "…"),
      {
        kind: "text",
        text: "A child's proposal already lands in `proposals/` in the Project's folder. I'm adding it to the coordinator's next wake-up text, then removing it once delivered.",
      },
      ...tool("Edit", { file_path: "daemon/src/agents/wake.rs" }, "The file has been updated."),
    )
    .out(
      ago(1),
      ...tool("Bash", {
        command: "cargo test -p plxd wake::",
        description: "Run the wake-up tests",
      }),
    );

  const pendingCall = callId();
  log(scheduler)
    .out(
      ago(150),
      session(),
      { kind: "turnStarted" },
      ...tool("Read", { file_path: "daemon/src/routing.rs" }, "…"),
      ...tool("Read", { file_path: "daemon/src/usage.rs" }, "…"),
      {
        kind: "text",
        text: "Routing already picks an account per run; the spill is a host choice on top of it. Before wiring it I want to confirm the devbox's plxd speaks this protocol version.",
      },
      {
        kind: "toolCall",
        callId: pendingCall,
        name: "Bash",
        input: {
          command: "ssh devbox plxd --version",
          description: "Check plxd's version on the devbox",
        },
      },
    )
    .out(ago(4), {
      kind: "approvalRequested",
      approvalId: ids.approvalScheduler,
      toolName: "Bash",
      input: {
        command: "ssh devbox plxd --version",
        description: "Check plxd's version on the devbox",
      },
      callId: pendingCall,
      reason: "Runs a command on another computer over ssh.",
      alwaysAllow: ["Bash(ssh devbox plxd:*)"],
      expiresAt: ahead(26),
    });

  log(inboxRead).out(
    ago(120),
    session(GPT),
    { kind: "turnStarted" },
    ...tool("Read", { file_path: "apps/desktop/src/renderer/Inbox.tsx" }, "…"),
    ...tool(
      "mcp__plxd__ask",
      {
        question: "Should scrolling past an inbox item mark it seen, or only opening it?",
        assumption: "Only opening it marks it seen",
      },
      JSON.stringify({ status: "open" }),
    ),
    {
      kind: "text",
      text: "Going on with opening-only for now. Wiring inbox/seen into the row's open handler and the sidebar's unread count.",
    },
    ...tool(
      "Edit",
      { file_path: "apps/desktop/src/renderer/Sidebar.tsx" },
      "The file has been updated.",
    ),
  );

  log(brief)
    .out(
      ago(110),
      session(),
      { kind: "turnStarted" },
      ...tool("Read", { file_path: "apps/desktop/src/renderer/MemoryPanel.tsx" }, "…"),
      ...tool(
        "Edit",
        { file_path: "apps/desktop/src/renderer/MemoryPanel.tsx" },
        "The file has been updated.",
      ),
      ...tool(
        "Bash",
        { command: "corepack pnpm exec vp test run src/renderer/MemoryPanel.test.tsx" },
        " ✓ src/renderer/MemoryPanel.test.tsx (19 tests) 340ms",
      ),
      {
        kind: "text",
        text: "The brief opens in the composer's editor and saves with `memory/write`. Its row shows who wrote it last and when. 3 files, +96 −12.",
      },
      { kind: "turnFinished" },
    )
    .update(ago(23), { status: "completed" })
    .finish(ago(23), { status: "completed" });

  log(iconPicker)
    .out(
      ago(95),
      session(),
      { kind: "turnStarted" },
      ...tool("Read", { file_path: "apps/desktop/src/renderer/index.css" }, "…"),
      ...tool(
        "Edit",
        { file_path: "apps/desktop/src/renderer/index.css" },
        "The file has been updated.",
      ),
      ...tool(
        "Bash",
        { command: "corepack pnpm exec vp test run src/renderer/IconPicker.test.tsx" },
        " ✗ IconPicker.test.tsx > every swatch keeps 3:1 on the light popover\n   AssertionError: yellow: expected 2.7 to be greater than or equal to 3",
        "error",
      ),
      {
        kind: "text",
        text: "Darkening yellow further makes it read as orange next to the orange swatch. I need a call on whether to change the hue or drop yellow from the light palette.",
      },
    )
    .update(ago(52), { status: "failed", error: iconPicker.error })
    .finish(ago(52), {
      status: "failed",
      failure: "vendorError",
      message: iconPicker.error ?? "failed",
    });

  // ---- Plain threads -------------------------------------------------------------------------

  const thread = (t: {
    id: string;
    repo: string;
    title: string;
    prompt: string;
    status: AgentRun["status"];
    started: number;
    updated: number;
    seen?: number;
    slug: string;
    diff?: { files: number; insertions: number; deletions: number };
    pullRequests?: string[];
  }) => {
    const run: AgentRun = {
      id: t.id,
      project: t.repo,
      prompt: t.prompt,
      policy: "workspaceWrite",
      status: t.status,
      backend: "claude",
      accountId: "claude",
      branch: `parallax/${t.slug}`,
      worktreePath: `${HOME}/.parallax/worktrees/${t.slug}`,
      sessionId: `sess_${t.slug.slice(0, 8)}`,
      model: OPUS,
      effort: "high",
      contextWindow: 1_000_000,
      permission: "edit",
      approvals: true,
      ...(t.pullRequests && { pullRequests: t.pullRequests }),
      ...(t.diff && { diff: { commit: "9c1d07a2f53e8b6c4d190a7f2e3b5c8d1f0e4b9c", ...t.diff } }),
      createdAt: ago(t.started),
      updatedAt: ago(t.updated),
    };
    runs.push(run);
    threads.push({
      id: t.id,
      repo: t.repo,
      title: t.title,
      createdAt: ago(t.started),
      lastPromptAt: ago(t.updated + 1),
      ...(t.seen !== undefined && { seenAt: ago(t.seen) }),
    });
    return run;
  };

  const updater = thread({
    id: ids.updater,
    repo: ids.repoParallax,
    title: "Rework the updater",
    slug: "rework-updater",
    prompt:
      "Rework the updater so a nightly build follows nightlies and a stable build follows Latest (0028). Today both read Latest. Keep the channel in the build's own metadata, not a setting.",
    status: "completed",
    started: 60 * 5,
    updated: 18,
    diff: { files: 6, insertions: 211, deletions: 88 },
    pullRequests: ["https://github.com/ryan-stoffel/parallax/pull/588"],
  });
  log(updater)
    .out(
      ago(300),
      session(),
      { kind: "turnStarted" },
      {
        kind: "reasoning",
        text: "electron-updater reads `channel` from app-update.yml at build time. The release workflow already knows the channel, so stamp it there instead of guessing from the version string.",
      },
      ...tool("Read", { file_path: ".github/workflows/release.yml" }, "…"),
      ...tool("Read", { file_path: "apps/desktop/electron-builder.yml" }, "…"),
      ...tool(
        "Edit",
        { file_path: "apps/desktop/src/main/updater.ts" },
        "The file has been updated.",
      ),
      {
        kind: "text",
        text: "A build now carries its channel in `app-update.yml`, which the release workflow stamps: `nightly` for a nightly, `latest` for a promoted one. The updater reads it at startup and sets `autoUpdater.channel`, so a nightly only ever offers newer nightlies.\n\n| Build | Follows |\n| --- | --- |\n| Nightly | `v2610.*-nightly` prereleases |\n| Stable | Latest |\n| `pnpm dev` | `main`, rebuilt in place |\n\nI also dropped the version-string sniffing in `Update.tsx`, which had a bug with `-nightly.1` suffixes.",
      },
      { kind: "turnFinished" },
    )
    .update(ago(290), { status: "completed" })
    .finish(ago(290), { status: "completed" })
    .update(ago(20), { status: "running" })
    .out(
      ago(20),
      {
        kind: "turnStarted",
        turnId: uuid(92),
        text: "Can a stable user opt in to nightlies from Settings?",
      },
      {
        kind: "text",
        text: "Not without a setting, and 0028 keeps the channel out of settings on purpose: switching a stable install to nightlies would mean a downgrade path back. The supported way is to install a nightly build, which then follows nightlies on its own. I'd leave it as is; if you want an opt-in, it should be its own decision record.",
      },
      { kind: "turnFinished" },
    )
    .update(ago(18), { status: "completed" })
    .finish(ago(18), { status: "completed" });

  const onboarding = thread({
    id: ids.onboarding,
    repo: ids.repoParallax,
    title: "Onboarding copy pass",
    slug: "onboarding-copy",
    prompt:
      "Do a copy pass on the first-run screens: sign in, add a repository, start a thread. Shorter, plainer, no exclamation marks.",
    status: "completed",
    started: 60 * 26,
    updated: 60 * 25,
    seen: 60 * 24,
    diff: { files: 2, insertions: 31, deletions: 44 },
    pullRequests: ["https://github.com/ryan-stoffel/parallax/pull/591"],
  });
  log(onboarding)
    .out(
      ago(60 * 26),
      session(),
      { kind: "turnStarted" },
      ...tool("Read", { file_path: "apps/desktop/src/renderer/NewThread.tsx" }, "…"),
      ...tool(
        "Edit",
        { file_path: "apps/desktop/src/renderer/NewThread.tsx" },
        "The file has been updated.",
      ),
      {
        kind: "text",
        text: "Tightened the three screens: 44 lines out, 31 in. The main change is **Start a thread** losing its two-sentence intro for one line: *Describe a change; Parallax runs it in its own worktree.*",
      },
      { kind: "turnFinished" },
    )
    .update(ago(60 * 25), { status: "completed" })
    .finish(ago(60 * 25), { status: "completed" });

  const tahoe = thread({
    id: ids.tahoe,
    repo: ids.repoParallax,
    title: "Tahoe icon variants",
    slug: "tahoe-icon-variants",
    prompt:
      "Make the app icon's Tahoe variants: default, dark, clear, and tinted, as an .icon bundle from design/icon. Check them against the Dock at 32 and 128 px.",
    status: "running",
    started: 14,
    updated: 1,
  });
  log(tahoe).out(
    ago(14),
    session(),
    { kind: "turnStarted" },
    {
      kind: "todoList",
      items: [
        { text: "Read design/icon and the current .icns", status: "completed" },
        { text: "Layered .icon bundle", status: "inProgress" },
        { text: "Dark, clear, and tinted variants", status: "pending" },
        { text: "Check at 32 and 128 px", status: "pending" },
      ],
    },
    {
      kind: "reasoning",
      text: "Icon Composer wants each layer as its own SVG, so first check whether design/icon already splits the glyph from the background.",
    },
    ...tool(
      "Bash",
      { command: "ls design/icon", description: "List the icon sources" },
      "glyph.svg\nbackground.svg\nparallax.icns\nREADME.md",
    ),
    ...tool("Read", { file_path: "design/icon/README.md" }, "…"),
    ...tool("Grep", { pattern: "icns|AppIcon", path: "apps/desktop" }, "electron-builder.yml:14"),
    ...tool("Read", { file_path: "apps/desktop/electron-builder.yml" }, "…"),
    {
      kind: "text",
      text: "The glyph and background are already separate layers, which is what Icon Composer wants. Building the bundle now.",
    },
    { kind: "contextCompaction", done: false },
    { kind: "contextCompaction", done: true },
    ...tool(
      "Write",
      { file_path: "design/icon/Parallax.icon/icon.json", content: "{}" },
      "File created successfully.",
    ),
    ...tool(
      "Bash",
      { command: "xcrun actool design/icon/Parallax.icon --compile build/icon --platform macosx" },
      "/* com.apple.actool.compilation-results */",
    ),
    {
      kind: "reasoning",
      text: "**Checking the Dock sizes.** The 32 px render loses the glyph's inner ring, so the tinted variant needs a heavier stroke there.",
    },
    {
      kind: "toolCall",
      callId: callId(),
      name: "Bash",
      input: { command: "pnpm exec icon-preview --sizes 32,128 build/icon/Assets.car" },
    },
  );

  const scratch = thread({
    id: ids.scratchThread,
    repo: ids.repoScratch,
    title: "Compare SSE vs WebSocket for plxd attach",
    slug: "sse-vs-websocket",
    prompt:
      "Compare server-sent events and WebSockets for streaming plxd's events to a remote client, given attach already runs over ssh stdio.",
    status: "completed",
    started: 60 * 50,
    updated: 60 * 49,
    seen: 60 * 48,
  });
  log(scratch)
    .out(
      ago(60 * 50),
      session(),
      { kind: "turnStarted" },
      {
        kind: "text",
        text: "Neither, for now: `plxd attach` already gives a full-duplex byte stream over ssh, and JSON-RPC lines on it are simpler than either. WebSockets only win once a client can't run ssh, such as a browser.",
      },
      { kind: "turnFinished" },
    )
    .update(ago(60 * 49), { status: "completed" })
    .finish(ago(60 * 49), { status: "completed" });

  // A repository's setup script (PLX-650): one holds its thread's first turn, one failed.
  const setupScript = {
    kind: "thread.script",
    trigger: "setup",
    name: "Install",
    terminalId: "setup-install",
    blocking: true,
  } as const;
  const docsSearch = thread({
    id: ids.docsSearch,
    repo: ids.repoDocs,
    title: "Index the docs for search",
    slug: "docs-search",
    prompt: "Add Pagefind to the docs build and a search box to the header.",
    status: "starting",
    started: 1,
    updated: 0,
  });
  log(docsSearch)
    .update(ago(1), { status: "starting" })
    .raw(ago(1), { ...setupScript, runId: docsSearch.id, status: "running" });
  const linksError =
    "The setup script Install exited with code 1. Its terminal setup-install stays open.";
  const docsLinks = thread({
    id: ids.docsLinks,
    repo: ids.repoDocs,
    title: "Fix broken links in the docs",
    slug: "docs-links",
    prompt: "Find and fix the broken links in the docs, then add a link check to CI.",
    status: "failed",
    started: 30,
    updated: 29,
  });
  log(docsLinks)
    .raw(ago(30), { ...setupScript, runId: docsLinks.id, status: "running" })
    .raw(ago(29), { ...setupScript, runId: docsLinks.id, status: "failed", exitCode: 1 })
    .update(ago(29), { status: "failed", error: linksError })
    .finish(ago(29), { status: "failed", failure: "spawnFailed", message: linksError });

  // ---- Questions and the inbox --------------------------------------------------------------

  const inboxQuestion = "Should scrolling past an inbox item mark it seen, or only opening it?";
  const paletteQuestion = "Should Mod+K open over an open dialog, or wait for it to close?";
  const questions: Question[] = [
    {
      id: ids.questionPalette,
      run: palette.id,
      question: paletteQuestion,
      assumption: "Wait for it to close",
      status: "decided",
      answer: "Wait for it to close, as Mod+N does.",
      createdAt: ago(150),
    },
    {
      id: ids.questionInbox,
      run: inboxRead.id,
      question: inboxQuestion,
      assumption: "Only opening it marks it seen",
      status: "escalated",
      createdAt: ago(38),
    },
  ];

  const inbox: InboxItem[] = [
    {
      id: uuid(100),
      kind: "decided",
      run: palette.id,
      text: `Command palette for project actions: asked ${JSON.stringify(paletteQuestion)}, went with ${JSON.stringify("Wait for it to close, as Mod+N does.")}`,
      createdAt: ago(41),
    },
    {
      id: uuid(101),
      kind: "done",
      run: retry.id,
      text: "Retry failed update downloads: done, 4 files (+142 -37)",
      createdAt: ago(41),
    },
    {
      id: uuid(102),
      kind: "learned",
      run: ids.coordinator,
      text: "Memory: Shortcuts wait for an open dialog to close (project scope)",
      createdAt: ago(40),
    },
    {
      id: uuid(103),
      kind: "needsYou",
      run: inboxRead.id,
      text: `Inbox read state: asks ${JSON.stringify(inboxQuestion)}, went on assuming ${JSON.stringify("Only opening it marks it seen")}`,
      createdAt: ago(38),
    },
    {
      id: uuid(104),
      kind: "failed",
      run: iconPicker.id,
      text: `Project icon picker in light mode: failed: ${iconPicker.error}`,
      createdAt: ago(52),
    },
    {
      id: uuid(106),
      kind: "learned",
      run: ids.coordinator,
      text: "Memory: plxd on the devbox is one protocol version behind; spill needs a version gate",
      createdAt: ago(12),
    },
    {
      id: uuid(107),
      kind: "learned",
      run: ids.coordinator,
      text: "Memory: yellow project icons need a darker hue in light mode to reach 3:1",
      createdAt: ago(6),
    },
    {
      id: uuid(105),
      kind: "done",
      run: brief.id,
      text: "Brief editor: done, 3 files (+96 -12)",
      createdAt: ago(23),
    },
  ];

  // ---- Shared context -------------------------------------------------------------------------

  const contextFile = (
    path: string,
    content: string,
    minutes: number,
    writer?: string,
  ): ContextDoc => ({
    file: {
      path,
      size: new TextEncoder().encode(content).length,
      modifiedAt: ago(minutes),
      ...(writer && { lastWriter: writer }),
    },
    content,
  });
  const notes = `# parallax: M4

Integration branch \`parallax/parallax\`, cut from \`develop\`. Children run in auto mode.

## Now

- [ ] **Command palette for project actions**: Mod+K palette is in; wiring jump-to-child. Waits for open dialogs (decided).
- [ ] **Memory proposals from child threads**: proposals ride the next wake-up; tests running.
- [ ] **Scheduler: spill to devbox**: waiting on approval to check plxd's version over ssh.
- [ ] **Inbox read state**: opening marks seen; asked Ryan about scroll-past.

## Next

- [x] **Retry failed update downloads**: done, +142 −37, ready to land.
- [x] **Brief editor**: done, +96 −12, ready to land.
- [ ] Land both on \`parallax/parallax\` once Ryan approves, then open the PR to \`develop\`.
- [ ] Re-run the icon picker with a hue change for yellow (see [decisions](decisions.md)).

## Risks

- The devbox runs an older plxd; if its protocol is behind, the spill needs a version gate first.
- **Project icon picker in light mode** failed: yellow can't reach 3:1 without reading as orange.
- Inbox read state and the palette both touch \`Sidebar.tsx\`; land the palette first.
`;
  const decisions = `# Decisions

| When | What | Who |
| --- | --- | --- |
| ${today} | Mod+K waits for an open dialog to close, like Mod+N | coordinator |
| ${today} | Retries back off at 2s, 8s, 30s; resume with ranges when offered | coordinator |
| ${today} | Children of this Project run in auto mode | Ryan |

Open: does scrolling past an inbox item mark it seen? Asked Ryan.
`;
  const scheduler_md = `# Scheduler spill

Spill a new child to \`devbox\` when this host's Claude five-hour window is above **90%**.

1. Read \`usage/get\`'s \`five_hour\` window for the child's account.
2. Above the threshold, start it on the devbox over \`plxd attach\`.
3. Name the host in the child's row and its inbox items.

See PR https://github.com/ryanstoffel/parallax/pull/512 for the routing groundwork.
`;
  const context: Record<string, ContextDoc[]> = {
    [ids.projectParallax]: [
      contextFile("decisions.md", decisions, 40, ids.coordinator),
      contextFile("notes.md", notes, 6, ids.coordinator),
      contextFile("scheduler.md", scheduler_md, 140, ids.scheduler),
    ],
    [ids.projectDocs]: [],
  };

  // ---- Memory -----------------------------------------------------------------------------------

  const memoryDoc = (
    path: string,
    content: string,
    minutes: number,
    header: { kind?: MemoryKind; title?: string; source?: string; writer?: string } = {},
  ): MemoryDoc => ({
    file: {
      path,
      size: new TextEncoder().encode(content).length,
      modifiedAt: ago(minutes),
      ...(header.kind && { date: new Date(now - minutes * 60_000).toISOString().slice(0, 10) }),
      ...header,
    },
    content,
  });
  const memory: Record<string, MemoryDoc[]> = {
    you: [
      memoryDoc(
        "memory/preference/plain-copy.md",
        'Write UI copy plainly: short sentences, no exclamation marks, no "simply" or "just".',
        60 * 24 * 9,
        {
          kind: "preference",
          title: "Plain UI copy, no exclamation marks",
          source: "user",
          writer: "user",
        },
      ),
      memoryDoc(
        "memory/preference/ask-before-deps.md",
        "Ask before adding a dependency to the desktop app; prefer a few lines of our own code.",
        60 * 24 * 20,
        {
          kind: "preference",
          title: "Ask before adding dependencies",
          source: "user",
          writer: "user",
        },
      ),
    ],
    [`repo:${ids.repoParallax}`]: [
      memoryDoc(
        "memory/convention/conventional-commits.md",
        "Commits use Conventional Commits and end with the Linear ID, e.g. `feat: show follow-up messages (PLX-92)`.",
        60 * 24 * 30,
        {
          kind: "convention",
          title: "Conventional Commits ending in the Linear ID",
          source: "AGENTS.md",
          writer: "user",
        },
      ),
      memoryDoc(
        "memory/convention/renderer-bridge-only.md",
        "The renderer talks to plxd only through `window.parallax`; it never imports Node or Electron.",
        60 * 24 * 14,
        {
          kind: "convention",
          title: "Renderer reaches plxd only through window.parallax",
          source: "docs/decisions/0022-desktop-app.md",
          writer: "user",
        },
      ),
      memoryDoc(
        "memory/gotcha/crates-proxy.md",
        "`cargo build` in a sandbox without crates.io access fails at the first download; build plxd on the host or use the cached target.",
        60 * 24 * 3,
        {
          kind: "gotcha",
          title: "Sandboxes can't download crates",
          source: `thread ${ids.updater}`,
          writer: "user",
        },
      ),
      memoryDoc(
        "memory/gotcha/windows-arm64-node-pty.md",
        "node-pty's prebuilt binary for Windows arm64 is missing in 1.2.0-beta.15; the release job builds it from source.",
        60 * 24 * 8,
        {
          kind: "gotcha",
          title: "node-pty has no Windows arm64 prebuild",
          source: "release.yml",
          writer: "user",
        },
      ),
      memoryDoc(
        "proposals/updater-channel.md",
        "A build's update channel comes from app-update.yml, stamped by the release workflow, never from a setting (0028).",
        18,
        {
          kind: "decision",
          title: "Update channel comes from the build, not a setting",
          source: ids.updater,
          writer: `thread ${ids.updater}`,
        },
      ),
    ],
    [`project:${ids.projectParallax}`]: [
      memoryDoc(
        "brief.md",
        `# parallax: M4

**Goal:** finish M4: the Project inbox, memory proposals, and the brief, plus the scheduler spill to the devbox.

**Scope:** the desktop app and plxd. No protocol version bump; new fields stay optional.

**Constraints:**
- Keep Ryan out of anything routine: decide questions that don't change visible behavior.
- Every child lands on \`parallax/parallax\` first; one PR to \`develop\` at the end.
- Tests stay green on macOS, Linux, and Windows.
`,
        60 * 24 * 5,
        { writer: "user" },
      ),
      memoryDoc(
        "memory/decision/children-auto-mode.md",
        "Children of this Project run in auto mode; bypass is never used here.",
        60 * 24 * 5,
        { kind: "decision", title: "Children run in auto mode", source: "user", writer: "user" },
      ),
      memoryDoc(
        "memory/convention/shortcuts-wait-for-dialogs.md",
        "App shortcuts that open something (Mod+N, Mod+K) wait for an open dialog to close.",
        40,
        {
          kind: "convention",
          title: "Shortcuts wait for an open dialog to close",
          source: palette.id,
          writer: `coordinator ${ids.coordinator}`,
        },
      ),
      memoryDoc(
        "memory/gotcha/sidebar-merge-order.md",
        "Inbox read state and the command palette both edit Sidebar.tsx; land the palette first to keep the merge small.",
        35,
        {
          kind: "gotcha",
          title: "Land the palette before inbox read state",
          source: ids.coordinator,
          writer: `coordinator ${ids.coordinator}`,
        },
      ),
      memoryDoc(
        "knowledge/release-pipeline.md",
        "# Release pipeline\n\nA nightly is a snapshot of `main`; a stable release is one nightly, promoted (0051).",
        60 * 24 * 4,
      ),
    ],
    [`project:${ids.projectDocs}`]: [],
    [`repo:${ids.repoDocs}`]: [],
  };

  // ---- Accounts, providers, and usage ------------------------------------------------------------

  const claudeInfo: ProviderInfo = {
    instance: {
      id: "claude",
      kind: "claude",
      name: "Claude",
      enabled: true,
      args: [],
      env: [],
      models: [],
    },
    installed: true,
    path: "/opt/homebrew/bin/claude",
    version: "2.1.286",
    signedIn: true,
    account: "Claude Max",
    models: [],
    permissions: ["manual", "edit", "auto", "plan", "bypass"],
    efforts: true,
    coordinator: true,
    login: ["claude", "auth", "login"],
  };
  const providers: ProviderInfo[] = [
    claudeInfo,
    {
      instance: {
        id: "codex",
        kind: "codex",
        name: "Codex",
        enabled: true,
        args: [],
        env: [],
        models: [],
      },
      installed: true,
      path: "/opt/homebrew/bin/codex",
      version: "0.159.3",
      signedIn: true,
      account: "ChatGPT Pro",
      models: [],
      permissions: ["manual", "edit", "auto", "bypass"],
      efforts: true,
      coordinator: true,
      login: ["codex", "login"],
    },
    {
      instance: {
        id: "cursor",
        kind: "cursor",
        name: "Cursor",
        enabled: true,
        args: [],
        env: [],
        models: [],
      },
      // The SDK sidecar (0053): not installed until Install (`cursor/install`), then signed out
      // until `cursor/signIn` finishes in the browser.
      installed: false,
      models: [],
      permissions: ["edit", "auto", "plan", "bypass"],
      efforts: false,
      coordinator: true,
    },
  ];
  const clis: DetectedCli[] = [
    {
      cli: "claude",
      installed: true,
      path: "/opt/homebrew/bin/claude",
      version: "2.1.286",
      signedIn: true,
      authKind: "subscription",
      plan: "Max",
    },
    {
      cli: "codex",
      installed: true,
      path: "/opt/homebrew/bin/codex",
      version: "0.159.3",
      signedIn: true,
      authKind: "subscription",
      plan: "Pro",
    },
    { cli: "cursor", installed: false },
  ];

  const period = (scale: number) => ({
    inputTokens: Math.round(412_000 * scale),
    outputTokens: Math.round(96_000 * scale),
    cacheReadTokens: Math.round(8_900_000 * scale),
    cacheWriteTokens: Math.round(640_000 * scale),
    costUsdMicros: Math.round(38_400_000 * scale),
  });
  const usage: AccountUsage[] = [
    {
      accountId: "claude",
      today: period(1),
      week: period(4.6),
      limits: [
        { window: "five_hour", usedPercent: 62, resetsAt: ahead(130), capturedAt: ago(2) },
        { window: "seven_day", usedPercent: 41, resetsAt: ahead(60 * 24 * 3), capturedAt: ago(2) },
      ],
    },
    {
      accountId: "codex",
      today: { ...period(0.3), costUsdMicros: undefined },
      week: { ...period(1.1), costUsdMicros: undefined },
      limits: [
        { window: "primary", usedPercent: 18, resetsAt: ahead(200), capturedAt: ago(5) },
        { window: "secondary", usedPercent: 27, resetsAt: ahead(60 * 24 * 5), capturedAt: ago(5) },
      ],
    },
  ];
  const limits: AccountLimits[] = [
    {
      accountId: "claude",
      limits: [
        { window: "five_hour", usedPercent: 9, resetsAt: ahead(260), capturedAt: ago(0) },
        { window: "seven_day", usedPercent: 20, resetsAt: ahead(60 * 148), capturedAt: ago(0) },
        {
          window: "seven_day_fable",
          usedPercent: 0,
          resetsAt: ahead(60 * 148),
          capturedAt: ago(0),
        },
      ],
    },
    {
      accountId: "codex",
      limits: [
        { window: "five_hour", usedPercent: 5, resetsAt: ahead(280), capturedAt: ago(0) },
        { window: "seven_day", usedPercent: 82, resetsAt: ahead(60 * 102), capturedAt: ago(0) },
      ],
    },
  ];
  const usageHours: UsageHour[] = [];
  for (let h = 0; h < 48; h++) {
    const hour = new Date(Math.floor((now - h * 3_600_000) / 3_600_000) * 3_600_000).toISOString();
    const busy = Math.abs(Math.sin(h / 3)) + 0.2;
    usageHours.unshift({
      hour,
      accountId: "claude",
      model: OPUS,
      inputTokens: Math.round(30_000 * busy),
      outputTokens: Math.round(7_000 * busy),
      cacheReadTokens: Math.round(600_000 * busy),
      cacheWriteTokens: Math.round(40_000 * busy),
      costUsdMicros: Math.round(2_600_000 * busy),
    });
  }
  const usageDays: UsageDay[] = [];
  const usageSessions: UsageSessions[] = [];
  for (let d = 0; d < 30; d++) {
    const date = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    const busy = 0.4 + Math.abs(Math.cos(d / 2.5));
    usageDays.unshift(
      {
        date,
        agent: "claude",
        model: OPUS,
        inputTokens: Math.round(380_000 * busy),
        outputTokens: Math.round(90_000 * busy),
        cacheReadTokens: Math.round(8_000_000 * busy),
        cacheWriteTokens: Math.round(600_000 * busy),
        costUsdMicros: Math.round(35_000_000 * busy),
      },
      {
        date,
        agent: "codex",
        model: GPT,
        inputTokens: Math.round(120_000 * busy),
        outputTokens: Math.round(30_000 * busy),
        cacheReadTokens: Math.round(1_500_000 * busy),
        cacheWriteTokens: 0,
      },
      // Cursor's models, a few a day, for a breakdown longer than five.
      ...[
        "grok-4.7",
        "claude-fable-5-1-thinking-high",
        "gpt-5.6-sol-high",
        "cursor-grok-4.6-xhigh",
        "composer-2.5-fast",
      ]
        .filter((_, i) => (d + i) % 3 !== 0)
        .map((model, i) => ({
          date,
          agent: "cursor" as const,
          model,
          inputTokens: Math.round(200_000 * busy),
          outputTokens: Math.round(20_000 * busy),
          cacheReadTokens: Math.round(2_000_000 * busy),
          cacheWriteTokens: 0,
          costUsdMicros: Math.round((14_000_000 / (i + 1)) * busy),
        })),
    );
    usageSessions.unshift(
      { date, agent: "claude", sessions: Math.round(9 * busy) },
      { date, agent: "codex", sessions: Math.round(3 * busy) },
    );
  }

  const commands: AgentCommand[] = [
    {
      text: "/review",
      name: "review",
      description: "Review the current diff for correctness bugs",
    },
    { text: "/simplify", name: "simplify", description: "Simplify the changed code" },
    {
      text: "/compact",
      name: "compact",
      description: "Summarize the conversation to free context",
      argumentHint: "[instructions]",
    },
    { text: "/init", name: "init", description: "Write a CLAUDE.md for this repository" },
    {
      text: "/security-review",
      name: "security-review",
      description: "Review pending changes for security issues",
    },
  ];
  const repoFiles = [
    "AGENTS.md",
    "README.md",
    "Cargo.toml",
    "apps/desktop/package.json",
    "apps/desktop/src/renderer/App.tsx",
    "apps/desktop/src/renderer/Inbox.tsx",
    "apps/desktop/src/renderer/MemoryPanel.tsx",
    "apps/desktop/src/renderer/Sidebar.tsx",
    "apps/desktop/src/renderer/Update.tsx",
    "apps/desktop/src/main/updater.ts",
    "daemon/src/routing.rs",
    "daemon/src/usage.rs",
    "docs/PLAN.md",
    "docs/decisions/0044-memory.md",
  ];

  return {
    repos,
    projects,
    threads,
    runs,
    events,
    inbox: { [ids.projectParallax]: inbox, [ids.projectDocs]: [] },
    questions: { [ids.projectParallax]: questions, [ids.projectDocs]: [] },
    context,
    memory,
    providers,
    clis,
    keys: [],
    usage,
    limits,
    usageHours,
    usageSessions,
    usageDays,
    commands,
    repoFiles,
  };
}
