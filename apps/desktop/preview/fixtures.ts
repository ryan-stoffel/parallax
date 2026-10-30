// What the preview's mock plxd holds: one host, "macbook", with the parallax repository, a busy
// Orchestrator on it with an orchestrator and seven children, a quiet second orchestrator, and a
// few plain threads. Times are relative to when the page loads, so ages in the sidebar read as
// recent.
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
  Orchestrator,
  ProviderInfo,
  Question,
  RemoteControlSession,
  Repo,
  Thread,
  UsageDay,
  UsageSessions,
  UsageHour,
} from "../src/protocol/generated/protocol";

export const HOME = "/Users/ryan";
export const PARALLAX_PATH = `${HOME}/Developer/personal/parallax`;
/** The files a Project's fixture holds, as uploads the mock serves, by path: base64. */
export const uploadSeeds: Record<string, string> = {
  [`${HOME}/.parallax/uploads/0199a6f0-a001/syllabus.pdf`]:
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MzcgPj4Kc3RyZWFtCkJUCi9GMSAyMiBUZgo1NiA3MjAgVGQKKENTQ0kgNDIzMDogRGF0YSBNaW5pbmcpIFRqCi9GMSAxMSBUZgowIC0yMCBUZAooRmFsbCAyMDI2ICB8ICBUdWUvVGh1IDEwOjMwKSBUagowIC0yMCBUZAooKSBUagowIC0yMCBUZAooQ291cnNlIGdvYWxzKSBUagowIC0yMCBUZAooLSBQcmVwcm9jZXNzIGFuZCBleHBsb3JlIHJlYWwgZGF0YXNldHMpIFRqCjAgLTIwIFRkCigtIENsYXNzaWZpY2F0aW9uLCBjbHVzdGVyaW5nLCBhc3NvY2lhdGlvbiBydWxlcykgVGoKMCAtMjAgVGQKKC0gRXZhbHVhdGUgbW9kZWxzIGhvbmVzdGx5KSBUagowIC0yMCBUZAooKSBUagowIC0yMCBUZAooR3JhZGluZykgVGoKMCAtMjAgVGQKKEhvbWV3b3JrIDQwJSAgIE1pZHRlcm0gMjUlICAgUHJvamVjdCAzNSUpIFRqCjAgLTIwIFRkCigpIFRqCjAgLTIwIFRkCihTY2hlZHVsZSkgVGoKMCAtMjAgVGQKKFdlZWsgMSAgIERhdGEgYW5kIHByZXByb2Nlc3NpbmcpIFRqCjAgLTIwIFRkCihXZWVrIDQgICBEZWNpc2lvbiB0cmVlcykgVGoKMCAtMjAgVGQKKFdlZWsgNyAgIENsdXN0ZXJpbmcpIFRqCjAgLTIwIFRkCihXZWVrIDEwICBBc3NvY2lhdGlvbiBydWxlcykgVGoKMCAtMjAgVGQKKFdlZWsgMTMgIFByb2plY3QgcHJlc2VudGF0aW9ucykgVGoKRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDA5MjkgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo5OTkKJSVFT0YK",
  [`${HOME}/.parallax/uploads/0199a6f0-a002/lecture-07-clustering.pdf`]:
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2MTEgPj4Kc3RyZWFtCkJUCi9GMSAyMiBUZgo1NiA3MjAgVGQKKExlY3R1cmUgNzogQ2x1c3RlcmluZykgVGoKL0YxIDExIFRmCjAgLTIwIFRkCihrLW1lYW5zLCBoaWVyYXJjaGljYWwsIGFuZCBEQlNDQU4pIFRqCjAgLTIwIFRkCigpIFRqCjAgLTIwIFRkCihrLW1lYW5zKSBUagowIC0yMCBUZAooMS4gUGljayBrIGNlbnRyb2lkcykgVGoKMCAtMjAgVGQKKDIuIEFzc2lnbiBlYWNoIHBvaW50IHRvIGl0cyBuZWFyZXN0IGNlbnRyb2lkKSBUagowIC0yMCBUZAooMy4gTW92ZSBlYWNoIGNlbnRyb2lkIHRvIGl0cyBwb2ludHMnIG1lYW4pIFRqCjAgLTIwIFRkCig0LiBSZXBlYXQgdW50aWwgbm90aGluZyBtb3ZlcykgVGoKMCAtMjAgVGQKKCkgVGoKMCAtMjAgVGQKKENob29zaW5nIGspIFRqCjAgLTIwIFRkCigtIEVsYm93IG1ldGhvZCBvbiB3aXRoaW4tY2x1c3RlciBTU0UpIFRqCjAgLTIwIFRkCigtIFNpbGhvdWV0dGUgc2NvcmUpIFRqCjAgLTIwIFRkCigpIFRqCjAgLTIwIFRkCihIaWVyYXJjaGljYWwpIFRqCjAgLTIwIFRkCigtIEFnZ2xvbWVyYXRpdmU6IG1lcmdlIHRoZSBjbG9zZXN0IHBhaXIpIFRqCjAgLTIwIFRkCigtIExpbmthZ2U6IHNpbmdsZSwgY29tcGxldGUsIGF2ZXJhZ2UpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwOTAzIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKOTczCiUlRU9GCg==",
  [`${HOME}/.parallax/uploads/0199a6f0-a003/homework-3.md`]:
    "IyBIb21ld29yayAzOiBDbHVzdGVyaW5nCgpEdWUgKipPY3QgMzAqKiBhdCAxMTo1OXBtLgoKMS4gUnVuIGstbWVhbnMgb24gYGN1c3RvbWVycy5jc3ZgIGZvciBrID0gMi4uOC4KMi4gUGxvdCBTU0UgYWdhaW5zdCBrIGFuZCBwaWNrIGsgd2l0aCB0aGUgZWxib3cgbWV0aG9kLgozLiBDb21wYXJlIHdpdGggdGhlIHNpbGhvdWV0dGUgc2NvcmUuCjQuIENsdXN0ZXIgYWdhaW4gd2l0aCBEQlNDQU4gKGVwcyA9IDAuNSwgbWluX3NhbXBsZXMgPSA1KS4KCkV4cGxhaW4gd2hpY2ggeW91IHRydXN0IG1vcmUsIGFuZCB3aHkuCg==",
};

/** An icon the user uploaded (0038): a warm gradient with a light disc, for landing-page. */
const LANDING_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAABVUlEQVR42rXU7SuDYRQG8OsPI4kkkkQS2cxmHpuZvZjZzGxmm72YLUkkkST/ms8+nfvc82ES5Xmee1unzuffVafrHHQ979rzpr2veuNF+5715pP2P2r/gw7c6607HbzV2zfautZWR++0dajF4Sbv1jlS40iV98ocLfF+kWMFjuc5nuNElpMZPkhzKsWHSU4nIKqrdAyiujqKQlRXmQhEdZUNQ1RXxyGI6ipnQVRXuSBEdXUSgKiu8n6Y693Pj58x1NWpDyb6b/pPjJuuCl4MrPfGWVfFdfS1mX8CHHVVXMMw+neGva7OVuHcGaMAe12VVuDcSLMAW53Ol+Hcd6MAe53KS3C9pmF0qizC9VZdAhx1qizA5BMMrFN1HuZ/pq/N9HS6mMPAX8xEp9osRHWqz0BUp8Y0RHVqTEFUp+YkRHW6nICoTq1xiOp0NQZRndqjENWpM/IFItgHWLGjZ9UAAAAASUVORK5CYII=";
const DOCS_PATH = `${HOME}/Developer/personal/docs-site`;

/** A run's logged event, before the mock numbers it. */
export interface RunEvent {
  time: string;
  event: ParallaxEvent;
}

interface MemoryDoc {
  file: MemoryFile;
  content: string;
}

interface ContextDoc {
  file: ContextFile;
  content: string;
}

interface Fixtures {
  repos: Repo[];
  /** Hand-picked lists of threads and orchestrators (PLX-789). */
  orchestrators: Orchestrator[];
  threads: Thread[];
  runs: AgentRun[];
  /** By run id, oldest first. */
  events: Record<string, RunEvent[]>;
  /** By orchestrator id. */
  inbox: Record<string, InboxItem[]>;
  questions: Record<string, Question[]>;
  context: Record<string, ContextDoc[]>;
  /** By scope key: `you`, `repo:<id>`, `orchestrator:<id>`. */
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
  /** Claude Remote Control threads' sessions, by run id (`thread/remoteControl`, PLX-1140). */
  remoteControl: Record<string, RemoteControlSession>;
}

// Fixed ids, shaped like the version 7 UUIDs plxd wants.
const uuid = (n: number) =>
  `0199a6f0-${(0x1000 + n).toString(16)}-7a4c-8e21-5b3f0c9d${(0x1000 + n).toString(16)}`;

export const ids = {
  repoParallax: uuid(1),
  repoDocs: uuid(2),
  repoScratch: uuid(3),
  orchestratorParallax: uuid(10),
  orchestratorDocs: uuid(11),
  orchestratorMobile: uuid(12),
  orchestratorInfra: uuid(13),
  orchestratorLanding: uuid(14),
  orchestratorRun: uuid(20),
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
  glyphCheck: uuid(46),
  scratchThread: uuid(43),
  docsSearch: uuid(44),
  docsLinks: uuid(45),
  questionInbox: uuid(60),
  questionPalette: uuid(61),
  approvalScheduler: uuid(70),
  repoAcmeWeb: uuid(80),
  repoAcmeApi: uuid(81),
  checkout: uuid(82),
  webhooks: uuid(83),
  cart: uuid(84),
  approvalWebhooks: uuid(85),
  groceries: uuid(86),
  approvalNotes: uuid(87),
  approvalReminders: uuid(88),
  rateLimit: uuid(120),
  homework: uuid(121),
  pricing: uuid(122),
  physics: uuid(123),
  essay: uuid(124),
  names: uuid(125),
  projectCoursework: uuid(130),
  projectEssays: uuid(131),
  projectApartment: uuid(132),
  repoLearnRust: uuid(140),
  rcLifetimes: uuid(141),
  rcClap: uuid(142),
  rcJson: uuid(143),
  rcBench: uuid(144),
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
      id: ids.repoAcmeWeb,
      name: "acme-web",
      path: `${HOME}/Developer/clients/acme-web`,
      createdAt: ago(60 * 24 * 9),
    },
    {
      id: ids.repoAcmeApi,
      name: "acme-api",
      path: `${HOME}/Developer/clients/acme-api`,
      createdAt: ago(60 * 24 * 9),
    },
    {
      id: ids.repoLearnRust,
      name: "learn-rust",
      path: `${HOME}/Developer/learn-rust`,
      createdAt: ago(60 * 24 * 3),
    },
    {
      id: ids.repoScratch,
      name: "No Repo",
      path: `${HOME}/.parallax/scratch`,
      scratch: true,
      createdAt: ago(60 * 24 * 40),
    },
    // Chat orchestrators (0090).
    {
      id: ids.projectCoursework,
      name: "CSCI4230 · Data Mining",
      path: `${HOME}/.parallax/spaces/${ids.projectCoursework}`,
      project: true,
      icon: { name: "graduation-cap", color: "sky" },
      createdAt: ago(60 * 24 * 30),
      instructions:
        "I'm a senior CS student. Explain with the math first, then a small worked example in Python. Keep answers under 300 words unless I ask for more.",
      files: Object.keys(uploadSeeds),
    },
    {
      id: ids.projectEssays,
      name: "Essays",
      path: `${HOME}/.parallax/spaces/${ids.projectEssays}`,
      project: true,
      icon: { name: "feather", color: "orange" },
      createdAt: ago(60 * 24 * 20),
    },
    {
      id: ids.projectApartment,
      name: "Moving into my own apartment",
      path: `${HOME}/.parallax/spaces/${ids.projectApartment}`,
      project: true,
      createdAt: ago(60 * 24 * 14),
    },
  ];

  const orchestrators: Orchestrator[] = [
    {
      id: ids.orchestratorParallax,
      name: "parallax",
      icon: { name: "orbit", color: "violet" },
      repoPath: PARALLAX_PATH,
      branch: "develop",
      run: ids.orchestratorRun,
      permission: "auto",
      autonomy: "routine",
      baseBranch: "develop",
      integrationBranch: "parallax/parallax",
      createdAt: ago(60 * 24 * 6),
      updatedAt: ago(3),
    },
    {
      id: ids.orchestratorDocs,
      name: "docs-site",
      icon: { name: "book-open", color: "green" },
      repoPath: DOCS_PATH,
      branch: "main",
      permission: "auto",
      autonomy: "ask",
      createdAt: ago(60 * 26),
      updatedAt: ago(60 * 26),
    },
    // More orchestrators, for how the sidebar holds a handful.
    ...(
      [
        [ids.orchestratorMobile, "mobile-app", "smartphone", "sky"],
        [ids.orchestratorInfra, "infra", "server", "orange"],
        [ids.orchestratorLanding, "landing-page", "rocket", "pink"],
      ] as const
    ).map(([id, name, icon, color], n): Orchestrator => ({
      id,
      name,
      icon:
        id === ids.orchestratorLanding
          ? { name: icon, image: { mediaType: "image/png", data: LANDING_ICON } }
          : { name: icon, color },
      repoPath: DOCS_PATH,
      branch: "main",
      permission: "auto",
      autonomy: "ask",
      createdAt: ago(60 * 24 * (n + 2)),
      updatedAt: ago(60 * 24 * (n + 2)),
    })),
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

  // ---- The orchestrator -------------------------------------------------------------------

  const orchestratorPrompt =
    "Pick up the M4 inbox work and the scheduler spill. Keep me out of anything routine.";
  const orchestratorRun: AgentRun = {
    id: ids.orchestratorRun,
    project: ids.orchestratorParallax,
    prompt: orchestratorPrompt,
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
  runs.push(orchestratorRun);

  /** An orchestrator child the orchestrator launched: its run and its thread. */
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
      project: ids.orchestratorParallax,
      prompt: c.prompt,
      policy: "workspaceWrite",
      status: c.status,
      backend,
      accountId: backend,
      branch: `parallax/${c.slug}`,
      worktreePath: `${HOME}/.parallax/worktrees/parallax/${c.slug}`,
      sessionId: `sess_${c.slug.slice(0, 6)}_${c.started}`,
      orchestratorThread: ids.orchestratorRun,
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
      repo: ids.orchestratorParallax,
      parent: ids.orchestratorRun,
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
    title: "Command palette for orchestrator actions",
    slug: "orchestrator-command-palette",
    prompt:
      "Add a command palette (Mod+K) for orchestrator actions: open an orchestrator, start a task, open its Context, Memory, or Agents view, and jump to any child by title. Reuse ui.tsx's menu styles and keybindings.ts, and keep it keyboard-first.",
    status: "running",
    started: 168,
    updated: 2,
  });
  const proposals = child({
    id: ids.proposals,
    title: "Memory proposals from child threads",
    slug: "memory-proposals",
    prompt:
      "Show memory proposals from an orchestrator's children in the orchestrator's wake-up, and let the orchestrator save or discard each with memory_write. A plain thread's proposal waits for the user in the Memory panel (0044).",
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
      "Scheduler: when the Claude subscription on this host reports its five-hour window above 90%, start new orchestrator children on the devbox host instead, over plxd attach. Read the limit from usage/get, keep the choice per Orchestrator, and say where each child went in its row.",
    status: "running",
    started: 150,
    updated: 4,
  });
  const inboxRead = child({
    id: ids.inboxRead,
    title: "Inbox read state",
    slug: "inbox-read-state",
    prompt:
      "Inbox read state: mark an orchestrator's inbox items seen when the user opens them or scrolls past them, with inbox/seen, and keep the unread count on the orchestrator's sidebar row in step.",
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
      "Brief editor: let the user edit an orchestrator's brief.md in the Memory panel with the same Markdown editor as the composer, saving with memory_write. Show the last writer and when.",
    status: "completed",
    started: 110,
    updated: 23,
    diff: { files: 3, insertions: 96, deletions: 12 },
  });
  const iconPicker = child({
    id: ids.iconPicker,
    title: "Orchestrator icon picker in light mode",
    slug: "icon-picker-light-mode",
    prompt:
      "Orchestrator icon picker in light mode: the swatches for yellow and gray drop below 3:1 against the light popover. Adjust the --project-* light tokens so every swatch passes, and update IconPicker.test.tsx's contrast check.",
    status: "failed",
    started: 95,
    updated: 52,
    error: "pnpm test failed: IconPicker.test.tsx contrast check still fails for yellow (2.7:1).",
  });

  // The orchestrator's transcript: the user's ask, its plan, five launches, a status board, and
  // a wake-up after two children finished.
  const launch = (run: AgentRun, title: string) =>
    tool(
      "mcp__plxd__thread_launch",
      { orchestrator: ids.orchestratorParallax, title, prompt: run.prompt },
      JSON.stringify({
        runId: run.id,
        status: "starting",
        title,
        prompt: run.prompt.split("\n")[0],
        branch: run.branch,
      }),
    );
  log(orchestratorRun)
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
        { orchestrator: ids.orchestratorParallax },
        JSON.stringify({ runs: [] }),
      ),
      ...tool(
        "Bash",
        {
          command: "gh issue list --milestone M4 --state open --limit 20",
          description: "List open M4 issues",
        },
        "PLX-488  Inbox read state                       feature  app\nPLX-489  Memory proposals from child threads    feature  daemon\nPLX-490  Brief editor                           feature  app\nPLX-491  Retry failed update downloads          bug      app\nPLX-492  Command palette for orchestrator actions    feature  app\nPLX-493  Icon picker swatches fail in light     bug      app\nPLX-497  Scheduler: spill to devbox when capped feature  daemon",
      ),
    )
    .out(ago(184), {
      kind: "text",
      text: "Seven open M4 issues, and none of them overlap much. I'll run them as separate children, all in auto mode on the integration branch `parallax/parallax`:\n\n- **Inbox read state**, **Memory proposals**, and **Brief editor** for the inbox work\n- **Scheduler: spill to devbox** for the scheduler\n- **Retry failed update downloads**, **Command palette**, and the **icon picker** contrast fix, since they're small and independent\n\nI'll answer routine questions myself and only bring you the ones that change behavior you'd notice.",
    })
    .out(ago(183), ...launch(retry, "Retry failed update downloads"))
    .out(ago(182), ...launch(palette, "Command palette for orchestrator actions"))
    .out(ago(181), ...launch(proposals, "Memory proposals from child threads"))
    .out(ago(180), ...launch(scheduler, "Scheduler: spill to devbox when Claude is capped"))
    .out(ago(179), ...launch(inboxRead, "Inbox read state"))
    .out(ago(178), ...launch(brief, "Brief editor"))
    .out(ago(177), ...launch(iconPicker, "Orchestrator icon picker in light mode"))
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
        text: 'Finished: Retry failed update downloads (completed, 4 files +142 -37). Command palette for orchestrator actions asked: "Should Mod+K open over an open dialog, or wait for it to close?", assuming "Wait for it to close".',
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
          scope: "orchestrator",
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
          { text: "Orchestrator actions as commands", status: "inProgress" },
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
        text: "The palette opens with Mod+K and lists the open orchestrator's actions first. Wiring the child list next.",
      },
    )
    .out(
      ago(40),
      {
        kind: "turnStarted",
        turnId: uuid(91),
        from: ids.orchestratorRun,
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
        text: "A child's proposal already lands in `proposals/` in the orchestrator's folder. I'm adding it to the orchestrator's next wake-up text, then removing it once delivered.",
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
      lastUserPromptAt: ago(t.started),
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
      // A subagent started in the background, still working after the turn ends (PLX-929).
      {
        kind: "toolCall",
        callId: "toolu_updater_review",
        name: "Agent",
        input: {
          description: "Review the updater channel change",
          prompt: "Review the updater's channel change against 0028 and report any bugs.",
          subagent_type: "general-purpose",
          run_in_background: true,
        },
      },
      {
        kind: "toolResult",
        callId: "toolu_updater_review",
        status: "ok",
        output: "Async agent launched successfully.",
      },
      {
        kind: "subagent",
        callId: "toolu_updater_review",
        agentType: "general-purpose",
        model: OPUS,
        item: {
          kind: "toolCall",
          callId: callId(),
          name: "Read",
          input: { file_path: "apps/desktop/src/main/updater.ts" },
        },
      },
      {
        kind: "text",
        text: "Not without a setting, and 0028 keeps the channel out of settings on purpose: switching a stable install to nightlies would mean a downgrade path back. The supported way is to install a nightly build, which then follows nightlies on its own. I'd leave it as is; if you want an opt-in, it should be its own decision record.",
      },
      usageItem(184_300, 2_100),
      {
        kind: "requestUsage",
        backend: "claude",
        accountId: "claude",
        usage: {
          model: OPUS,
          contextTokens: 184_300,
          contextWindow: 1_000_000,
          inputTokens: 184_300,
          cachedInputTokens: 171_900,
          outputTokens: 1_310,
          outputMs: 15_900,
        },
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

  const glyphTask =
    "Render the tinted icon at 32 px on light and dark Dock backgrounds, and say whether the glyph's inner ring survives.";
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
    // Three of Claude Code's own subagents started together (PLX-843): two done, one working.
    ...(() => {
      const agent = (description: string, prompt: string, done?: string): AgentOutputItem[] => {
        const id = callId();
        return [
          {
            kind: "toolCall",
            callId: id,
            name: "Agent",
            input: { description, prompt, subagent_type: "Explore", run_in_background: true },
          },
          { kind: "toolResult", callId: id, status: "ok", output: "Started in the background." },
          {
            kind: "subagent",
            callId: id,
            agentType: "Explore",
            model: "claude-haiku-5-5",
            item: { kind: "text", text: `Looking into ${description.toLowerCase()}.` },
          },
          ...(done
            ? [
                {
                  kind: "subagentFinished",
                  callId: id,
                  status: "completed",
                  summary: done,
                } as const,
              ]
            : []),
        ];
      };
      return [
        ...agent(
          "Find the icon sources",
          "List every SVG and icns under design/icon.",
          "Found glyph.svg, background.svg, and parallax.icns.",
        ),
        ...agent(
          "Check electron-builder icon config",
          "Read electron-builder.yml and report how the macOS icon is set.",
          "mac.icon points at design/icon/parallax.icns.",
        ),
        ...agent("Survey Tahoe icon guidance", "Summarize Apple's Tahoe app icon guidance."),
      ];
    })(),
    ...tool(
      "mcp__plxd__orchestrator_capabilities",
      {},
      JSON.stringify({ providers: ["claude", "codex"] }),
    ),
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
    // A task delegated to another provider, in this thread's worktree (0063, PLX-648).
    ...tool(
      "mcp__plxd__delegate_task",
      {
        task: glyphTask,
        target: { providerInstanceId: "codex", model: GPT },
        title: "Check the 32 px glyph",
      },
      JSON.stringify(
        {
          taskId: ids.glyphCheck,
          childThreadId: ids.glyphCheck,
          status: "running",
          workState: "working",
          providerInstanceId: "codex",
          model: GPT,
          mode: "edit",
          branch: null,
          summary: null,
          error: null,
          waitTimedOut: false,
        },
        null,
        2,
      ),
    ),
    // Two of Claude Code's own subagents at work (PLX-382), which ride over the composer.
    ...(["Find the Dock's icon sizes", "Read Apple's icon guidelines"] as const).map(
      (description, i) => ({
        kind: "toolCall" as const,
        callId: `toolu_tahoe_${i}`,
        name: "Agent",
        input: { description, prompt: `${description}.`, subagent_type: "Explore" },
      }),
    ),
    {
      kind: "subagent",
      callId: "toolu_tahoe_0",
      agentType: "Explore",
      model: "claude-haiku-4-5-20251001",
      item: { kind: "toolCall", callId: callId(), name: "Grep", input: { pattern: "32x32" } },
    },
    {
      kind: "toolCall",
      callId: callId(),
      name: "Bash",
      input: { command: "pnpm exec icon-preview --sizes 32,128 build/icon/Assets.car" },
    },
    // A secret the agent waits on (request_secret, 0063): the card pinned over the composer.
    {
      kind: "secretRequested",
      requestId: uuid(47),
      label: "Figma access token",
      reason:
        "To export the tinted variant's layers from the design file. Make one in Figma under Settings > Security > Personal access tokens, with read access to files.",
      placeholder: "figd_…",
    },
  );

  // Tahoe's delegated task: its child, on Codex, working in Tahoe's worktree (0063).
  const glyphCheck: AgentRun = {
    id: ids.glyphCheck,
    project: ids.repoParallax,
    prompt: glyphTask,
    policy: "workspaceWrite",
    status: "running",
    backend: "codex",
    accountId: "codex",
    model: GPT,
    permission: "edit",
    approvals: true,
    checkout: true,
    createdAt: ago(3),
    updatedAt: ago(1),
  };
  runs.push(glyphCheck);
  threads.push({
    id: ids.glyphCheck,
    repo: ids.repoParallax,
    parent: ids.tahoe,
    title: "Check the 32 px glyph",
    createdAt: ago(3),
    lastPromptAt: ago(3),
  });
  log(glyphCheck).out(
    ago(3),
    session(GPT),
    { kind: "turnStarted" },
    ...tool(
      "Bash",
      { command: "xcrun actool build/icon --render 32 --appearance tinted" },
      "build/icon/render-32-tinted.png",
    ),
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
    .finish(ago(29), { status: "failed", failure: "setupFailed", message: linksError });
  docsLinks.error = linksError;

  // ---- A client's two repositories ---------------------------------------------------------

  const checkout = thread({
    id: ids.checkout,
    repo: ids.repoAcmeWeb,
    title: "Checkout page redesign",
    slug: "checkout-redesign",
    prompt: "Redesign the checkout page from the Figma frames: one column, totals pinned.",
    status: "running",
    // Prompted an hour and a half ago, and woken 4 minutes ago by its pull request's watch.
    started: 95,
    updated: 0,
  });
  log(checkout).out(ago(4), session(), { kind: "turnStarted" });
  const webhooks = thread({
    id: ids.webhooks,
    repo: ids.repoAcmeApi,
    title: "Stripe webhook retries",
    slug: "webhook-retries",
    prompt: "Retry failed Stripe webhooks with exponential backoff, capped at five tries.",
    status: "running",
    started: 14,
    updated: 2,
  });
  log(webhooks)
    .out(
      ago(14),
      session(),
      { kind: "turnStarted" },
      { kind: "text", text: "Retry with exponential backoff, capped at five tries." },
    )
    .out(ago(2), {
      kind: "approvalRequested",
      approvalId: ids.approvalWebhooks,
      toolName: "Bash",
      input: { command: "stripe trigger payment_intent.payment_failed" },
      callId: callId(),
      reason: "Sends a test event to the Stripe account.",
      expiresAt: ahead(28),
    });
  const cart = thread({
    id: ids.cart,
    repo: ids.repoAcmeWeb,
    title: "Cart totals rounding",
    slug: "cart-rounding",
    prompt:
      "Cart totals are off by a cent with three or more discounted items. Round once, at the end.",
    status: "completed",
    started: 60 * 30,
    updated: 60 * 29,
    seen: 60 * 28,
    pullRequests: ["https://github.com/acme/acme-web/pull/41"],
  });
  log(cart)
    .out(
      ago(60 * 30),
      session(),
      { kind: "turnStarted" },
      {
        kind: "text",
        text: "Rounding per line drifted. Totals now round once, in cents, at the end.",
      },
      { kind: "turnFinished" },
    )
    .update(ago(60 * 29), { status: "completed" })
    .finish(ago(60 * 29), { status: "completed" });

  // ---- Claude Remote Control (PLX-1140): sessions `claude remote-control` serves elsewhere ----

  const remoteControl: Record<string, RemoteControlSession> = {};
  /** A thread that follows Claude Remote Control session `sessionId`, in learn-rust's checkout. */
  const remote = (
    t: Omit<Parameters<typeof thread>[0], "repo">,
    sessionId: string,
    state: RemoteControlSession["state"],
  ) => {
    const run = thread({ ...t, repo: ids.repoLearnRust });
    Object.assign(run, {
      sessionId,
      checkout: true,
      branch: undefined,
      worktreePath: undefined,
      model: undefined,
      effort: undefined,
      contextWindow: undefined,
    });
    remoteControl[run.id] = {
      sessionId,
      url: `https://claude.ai/code/${sessionId}`,
      repository: "ryan-stoffel/learn-rust",
      branch: "main",
      state,
    };
    const imported: AgentOutputItem = {
      kind: "notice",
      detail: "Imported from Claude Remote Control.",
    };
    const started: AgentOutputItem = { kind: "sessionStarted", sessionId };
    return { run, imported, started };
  };
  const lifetimes = remote(
    {
      id: ids.rcLifetimes,
      title: "Explain the lifetime errors in parser.rs",
      slug: "rc-lifetimes",
      prompt: "cargo check fails in parser.rs with lifetime errors. Explain them, then fix them.",
      status: "completed",
      started: 60 * 3,
      updated: 6,
      seen: 5,
    },
    "session_018aqLm2Vb7XyLifetimes",
    "idle",
  );
  log(lifetimes.run)
    .out(ago(60 * 3), lifetimes.imported, { kind: "turnStarted" })
    .out(
      ago(60 * 3 - 1),
      {
        kind: "text",
        text: "`Token<'a>` borrows from the input, but `Parser::next` returns it after the buffer it points into is dropped. Owning the text in `Token` fixes both errors.",
      },
      { kind: "turnFinished" },
    )
    .out(
      ago(8),
      lifetimes.started,
      {
        kind: "turnStarted",
        turnId: uuid(150),
        text: "Make the fix, and run the tests.",
      },
      ...tool("Edit", { file_path: "src/parser.rs" }, "The file src/parser.rs has been updated."),
      ...tool("Bash", { command: "cargo test" }, "test result: ok. 24 passed; 0 failed; 0 ignored"),
      {
        kind: "text",
        text: "`Token` now owns its text as a `String`, so nothing outlives the buffer. `cargo test` passes: 24 tests.",
      },
      { kind: "turnFinished" },
    )
    .update(ago(6), { status: "completed" })
    .finish(ago(6), { status: "completed" });
  const clap = remote(
    {
      id: ids.rcClap,
      title: "Migrate the CLI to clap 5",
      slug: "rc-clap",
      prompt: "Move the CLI from clap 4's builder API to clap 5's derive API.",
      status: "running",
      started: 40,
      updated: 1,
    },
    "session_01Cb9QpWaitingForAnswer",
    "waiting",
  );
  log(clap.run).out(
    ago(3),
    clap.imported,
    clap.started,
    { kind: "turnStarted", turnId: uuid(151), text: "Bump clap to 5 and fix what breaks." },
    ...tool("Read", { file_path: "Cargo.toml" }, '[dependencies]\nclap = "4.5"'),
    {
      kind: "toolCall",
      callId: callId(),
      name: "Bash",
      input: { command: "cargo update -p clap" },
    },
    { kind: "notice", detail: "Claude is waiting for your answer in Claude." },
  );
  const json = remote(
    {
      id: ids.rcJson,
      title: "Add a --json flag to the stats command",
      slug: "rc-json",
      prompt: "Add a --json flag to `stats` that prints the same numbers as JSON.",
      status: "running",
      started: 90,
      updated: 2,
    },
    "session_01DqOfflineComputer",
    "offline",
  );
  log(json.run).out(
    ago(2),
    json.imported,
    json.started,
    { kind: "turnStarted", turnId: uuid(152), text: "Use serde_json, and add a test." },
    {
      kind: "notice",
      detail:
        "The computer serving this session is offline. Your message is queued until it's back.",
    },
  );
  const bench = remote(
    {
      id: ids.rcBench,
      title: "Benchmark the tokenizer",
      slug: "rc-bench",
      prompt: "Add a criterion benchmark for the tokenizer.",
      status: "completed",
      started: 60 * 26,
      updated: 60 * 25,
      seen: 60 * 25,
    },
    "session_01EnArchivedSession",
    "archived",
  );
  log(bench.run)
    .out(
      ago(60 * 26),
      bench.imported,
      { kind: "turnStarted" },
      { kind: "text", text: "Added `benches/tokenizer.rs`: 1.8 µs per line on the sample file." },
      { kind: "turnFinished" },
    )
    .update(ago(60 * 25), { status: "completed" })
    .finish(ago(60 * 25), { status: "completed" });

  // ---- Computer use (PLX-897): Notes always allowed, Reminders waiting for an answer ----------

  const groceries = thread({
    id: ids.groceries,
    repo: ids.repoScratch,
    title: "Weekend grocery list",
    slug: "grocery-list",
    prompt: "Put this week's groceries in a Notes list, then remind me Saturday at 9 to shop.",
    status: "running",
    started: 3,
    updated: 0,
  });
  const notesTree = [
    "App: Notes (com.apple.Notes), pid 812",
    'Window: "Notes", 1180×760 points. The screenshot is 1568×1010 pixels; x and y count in it.',
    "",
    '0 standard window "Notes"',
    "  1 toolbar",
    "    2 button, New Note",
    '    3 search text field, placeholder: "Search"',
    "  4 table, Notes",
    '    5 row "Groceries" (selected)',
    '  6 text entry area, value: "Groceries"',
  ].join("\n");
  log(groceries).out(
    ago(3),
    session(),
    { kind: "turnStarted" },
    ...tool(
      "mcp__plxd__computer_list_apps",
      {},
      '{"apps": [{"name": "Notes"}, {"name": "Reminders"}]}',
    ),
    {
      kind: "approvalRequested",
      approvalId: ids.approvalNotes,
      toolName: "computer_use",
      input: { app: "Notes" },
      alwaysAllow: ["Notes"],
      expiresAt: ahead(60),
    },
    {
      kind: "approvalResolved",
      approvalId: ids.approvalNotes,
      decision: "allowed",
      by: "user",
      always: true,
    },
    ...tool("mcp__plxd__computer_get_app_state", { app: "Notes" }, notesTree),
    ...tool("mcp__plxd__computer_click", { app: "Notes", element_index: 6 }, notesTree),
    ...tool(
      "mcp__plxd__computer_type_text",
      { app: "Notes", text: "Oat milk\nEggs\nSpinach\nCoffee beans" },
      notesTree,
    ),
    {
      kind: "text",
      text: "The list is in Notes under Groceries. Next, the Saturday reminder.",
    },
    {
      kind: "approvalRequested",
      approvalId: ids.approvalReminders,
      toolName: "computer_use",
      input: { app: "Reminders" },
      alwaysAllow: ["Reminders"],
      expiresAt: ahead(60),
    },
  );
  threads.find((t) => t.id === ids.updater)!.pinned = true;
  threads.find((t) => t.id === ids.cart)!.pinned = true;

  // ---- A task that just finished, and chats that go on for days (sidebar pins) ---------------

  /** A no-repo chat: one question and answer, prompted again later. */
  const chat = (c: {
    id: string;
    title: string;
    slug: string;
    prompt: string;
    reply: string;
    started: number;
    updated: number;
    seen?: number;
    /** A chat orchestrator's id, for a chat in one. */
    repo?: string;
  }) => {
    const run = thread({ ...c, repo: c.repo ?? ids.repoScratch, status: "completed" });
    log(run)
      .out(
        ago(c.started),
        session(),
        { kind: "turnStarted" },
        { kind: "text", text: c.reply },
        {
          kind: "turnFinished",
        },
      )
      .update(ago(c.updated), { status: "completed" })
      .finish(ago(c.updated), { status: "completed" });
    threads.find((t) => t.id === c.id)!.pinned = true;
  };
  const rateLimit = thread({
    id: ids.rateLimit,
    repo: ids.repoParallax,
    title: "Rate limit the attach endpoint",
    slug: "attach-rate-limit",
    prompt:
      "Rate limit plxd attach per client key: a token bucket, 20 a minute, 429 with Retry-After.",
    status: "completed",
    started: 40,
    updated: 12,
    diff: { files: 3, insertions: 88, deletions: 9 },
    pullRequests: ["https://github.com/ryan-stoffel/parallax/pull/612"],
  });
  log(rateLimit)
    .out(
      ago(40),
      session(),
      { kind: "turnStarted" },
      { kind: "text", text: "Added a token bucket per client key in `attach.rs`, with tests." },
      { kind: "turnFinished" },
    )
    .update(ago(12), { status: "completed" })
    .finish(ago(12), { status: "completed" });
  chat({
    id: ids.homework,
    repo: ids.projectCoursework,
    title: "Linear algebra: eigenvalues walkthrough",
    slug: "eigenvalues",
    prompt:
      "Walk me through finding the eigenvalues of a 3×3 matrix, step by step. I'll ask follow-ups.",
    reply: "Start with the characteristic polynomial: det(A − λI) = 0. Expand along the first row.",
    started: 60 * 24 * 3,
    updated: 9,
  });
  chat({
    id: ids.physics,
    repo: ids.projectCoursework,
    title: "Physics: torque and angular momentum",
    slug: "torque",
    prompt: "Explain torque and angular momentum like I'm studying for Thursday's exam.",
    reply: "Torque is the rotational version of force: τ = r × F. Angular momentum is L = Iω.",
    started: 60 * 24 * 5,
    updated: 60 * 20,
    seen: 60 * 19,
  });
  chat({
    id: ids.essay,
    repo: ids.projectEssays,
    title: "Essay outline: AI tutors and academic honesty",
    slug: "essay-outline",
    prompt: "Help me outline a 1,500 word essay on AI tutors and academic honesty.",
    reply: "Here's a five-part outline, with a thesis that takes a side.",
    started: 60 * 24 * 8,
    updated: 60 * 24 * 2,
    seen: 60 * 24 * 2,
  });
  chat({
    id: ids.pricing,
    title: "Brainstorm: Parallax pricing tiers",
    slug: "pricing-tiers",
    prompt:
      "Let's brainstorm pricing tiers for Parallax. Solo, team, and what a free tier includes.",
    reply: "Three tiers is the usual shape. Where the free tier ends matters most.",
    started: 60 * 24 * 6,
    updated: 60 * 26,
    seen: 60 * 25,
  });
  chat({
    id: ids.names,
    title: "Names for the habit tracker",
    slug: "habit-tracker-names",
    prompt: "Give me names for a tiny habit tracker app. Short, friendly, and not taken.",
    reply: "Streakly, Tally, and Daybook. Tally is the easiest to say.",
    started: 60 * 24 * 3,
    updated: 45,
  });

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
      text: `Command palette for orchestrator actions: asked ${JSON.stringify(paletteQuestion)}, went with ${JSON.stringify("Wait for it to close, as Mod+N does.")}`,
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
      run: ids.orchestratorRun,
      text: "Memory: Shortcuts wait for an open dialog to close (orchestrator scope)",
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
      text: `Orchestrator icon picker in light mode: failed: ${iconPicker.error}`,
      createdAt: ago(52),
    },
    {
      id: uuid(106),
      kind: "learned",
      run: ids.orchestratorRun,
      text: "Memory: plxd on the devbox is one protocol version behind; spill needs a version gate",
      createdAt: ago(12),
    },
    {
      id: uuid(107),
      kind: "learned",
      run: ids.orchestratorRun,
      text: "Memory: yellow orchestrator icons need a darker hue in light mode to reach 3:1",
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

- [ ] **Command palette for orchestrator actions**: Mod+K palette is in; wiring jump-to-child. Waits for open dialogs (decided).
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
- **Orchestrator icon picker in light mode** failed: yellow can't reach 3:1 without reading as orange.
- Inbox read state and the palette both touch \`Sidebar.tsx\`; land the palette first.
`;
  const decisions = `# Decisions

| When | What | Who |
| --- | --- | --- |
| ${today} | Mod+K waits for an open dialog to close, like Mod+N | orchestratorRun |
| ${today} | Retries back off at 2s, 8s, 30s; resume with ranges when offered | orchestratorRun |
| ${today} | Children of this orchestrator run in auto mode | Ryan |

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
    [ids.orchestratorParallax]: [
      contextFile("decisions.md", decisions, 40, ids.orchestratorRun),
      contextFile("notes.md", notes, 6, ids.orchestratorRun),
      contextFile("scheduler.md", scheduler_md, 140, ids.scheduler),
    ],
    [ids.orchestratorDocs]: [],
    [ids.orchestratorMobile]: [],
    [ids.orchestratorInfra]: [],
    [ids.orchestratorLanding]: [],
  };

  // ---- Memory -----------------------------------------------------------------------------------

  const memoryDoc = (
    path: string,
    content: string,
    minutes: number,
    header: {
      kind?: MemoryKind;
      title?: string;
      source?: string;
      writer?: string;
      lastUsed?: string;
      unused?: boolean;
      stale?: boolean;
    } = {},
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
  // The day an agent last read an entry, `days` ago, as its header gives it (PLX-943).
  const usedAgo = (days: number) => new Date(now - days * 864e5).toISOString().slice(0, 10);
  const memory: Record<string, MemoryDoc[]> = {
    you: [
      memoryDoc(
        "memory/preference/plain-copy.md",
        'Write UI copy plainly: short sentences, no exclamation marks, no "simply" or "just".',
        60 * 24 * 9,
        {
          kind: "preference",
          title: "Plain UI copy, no exclamation marks",
          lastUsed: usedAgo(2),
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
          lastUsed: usedAgo(0),
          source: "user",
          writer: "user",
        },
      ),
    ],
    [`repo:${ids.repoParallax}`]: [
      memoryDoc(
        "memory/convention/conventional-commits.md",
        "Commits use Conventional Commits and end with the Linear ID, e.g. `feat: show follow-up messages (PLX-92)`.",
        60 * 24 * 90,
        {
          kind: "convention",
          title: "Conventional Commits ending in the Linear ID",
          source: "AGENTS.md",
          writer: "user",
          unused: true,
        },
      ),
      memoryDoc(
        "memory/convention/renderer-bridge-only.md",
        "The renderer talks to plxd only through `window.parallax`; it never imports Node or Electron.",
        60 * 24 * 14,
        {
          kind: "convention",
          title: "Renderer reaches plxd only through window.parallax",
          lastUsed: usedAgo(3),
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
          lastUsed: usedAgo(6),
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
          lastUsed: new Date(now - 60 * 24 * 2 * 60_000).toISOString().slice(0, 10),
          stale: true,
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
    [`orchestrator:${ids.orchestratorParallax}`]: [
      memoryDoc(
        "brief.md",
        `# parallax: M4

**Goal:** finish M4: the orchestrator inbox, memory proposals, and the brief, plus the scheduler
*spill to the devbox.

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
        "Children of this orchestrator run in auto mode; bypass is never used here.",
        60 * 24 * 5,
        {
          kind: "decision",
          title: "Children run in auto mode",
          source: "user",
          writer: "user",
          lastUsed: new Date(now - 60 * 24 * 60_000).toISOString().slice(0, 10),
        },
      ),
      memoryDoc(
        "memory/convention/shortcuts-wait-for-dialogs.md",
        "App shortcuts that open something (Mod+N, Mod+K) wait for an open dialog to close.",
        40,
        {
          kind: "convention",
          title: "Shortcuts wait for an open dialog to close",
          source: palette.id,
          writer: `orchestrator ${ids.orchestratorRun}`,
        },
      ),
      memoryDoc(
        "memory/gotcha/sidebar-merge-order.md",
        "Inbox read state and the command palette both edit Sidebar.tsx; land the palette first to keep the merge small.",
        35,
        {
          kind: "gotcha",
          title: "Land the palette before inbox read state",
          lastUsed: usedAgo(0),
          source: ids.orchestratorRun,
          writer: `orchestrator ${ids.orchestratorRun}`,
        },
      ),
      memoryDoc(
        "knowledge/release-pipeline.md",
        "# Release pipeline\n\nA nightly is a snapshot of `main`; a stable release is one nightly, promoted (0051).",
        60 * 24 * 4,
      ),
    ],
    [`orchestrator:${ids.orchestratorDocs}`]: [],
    [`orchestrator:${ids.orchestratorMobile}`]: [],
    [`orchestrator:${ids.orchestratorInfra}`]: [],
    [`orchestrator:${ids.orchestratorLanding}`]: [],
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
    orchestrator: true,
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
      account: "personal@example.test",
      models: [],
      permissions: ["manual", "edit", "auto", "bypass"],
      efforts: true,
      orchestrator: true,
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
      orchestrator: true,
    },
  ];

  providers.push({
    ...providers[1]!,
    instance: {
      ...providers[1]!.instance,
      id: "codex-work",
      name: "Work",
      home: "/Users/ryan/.codex-work",
    },
    account: "work@example.test",
  });
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
    {
      text: "/design:ux-copy",
      name: "design:ux-copy",
      description:
        "Write or review UX copy: microcopy, error messages, empty states, and CTAs. Use when naming a button, wording a confirmation dialog, or filling an empty state.",
    },
    {
      text: "/frontend-design:frontend-design",
      name: "frontend-design:frontend-design",
      description:
        "Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one, from typography to motion.",
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
    orchestrators,
    threads,
    runs,
    events,
    inbox: {
      [ids.orchestratorParallax]: inbox,
      [ids.orchestratorDocs]: [],
      [ids.orchestratorMobile]: [],
      [ids.orchestratorInfra]: [],
      [ids.orchestratorLanding]: [],
    },
    questions: {
      [ids.orchestratorParallax]: questions,
      [ids.orchestratorDocs]: [],
      [ids.orchestratorMobile]: [],
      [ids.orchestratorInfra]: [],
      [ids.orchestratorLanding]: [],
    },
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
    remoteControl,
    repoFiles,
  };
}
