// Mock data for the mockups. Nothing here talks to plxd.

export type ChildStatus = "needs" | "starting" | "working" | "queued" | "review" | "landed" | "failed";
export type Provider = "claude" | "codex" | "cursor";

export interface Host {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  running: number;
  slots: number;
}

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  used: number;
  cap: number;
  resets: string;
}

export type TranscriptItem =
  | { kind: "brief"; text: string }
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; verb: string; target: string; detail?: string; add?: number; del?: number }
  | { kind: "assumption"; text: string; alternative: string };

export interface Child {
  id: string;
  title: string;
  status: ChildStatus;
  summary: string;
  host: string;
  account: string;
  model: string;
  branch: string;
  add: number;
  del: number;
  age: string;
  steps: string[];
  step: number;
  queueReason?: string;
  transcript: TranscriptItem[];
}

export interface Decision {
  id: string;
  childId: string;
  question: string;
  context: string;
  options: { label: string; detail: string; recommended?: boolean }[];
  asked: string;
  answer?: string;
}

export interface AutoDecision {
  id: string;
  childId: string;
  chose: string;
  because: string;
  alternative: string;
  changed?: boolean;
}

export type MemoryKind = "preference" | "convention" | "decision" | "gotcha";
export type Scope = "project" | "repo" | "you";

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  source: string;
  date: string;
  scope: Scope;
  proposed?: boolean;
  stale?: string;
  fresh?: boolean;
}

export interface KnowledgeFile {
  id: string;
  name: string;
  kind: "doc" | "research" | "link";
  summary: string;
  updated: string;
  size: string;
}

export interface Landed {
  sha: string;
  title: string;
  childId: string;
  add: number;
  del: number;
  when: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  repo: string;
  base: string;
  brief: string;
  updated: string;
  needs: number;
  working: number;
  done: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "coordinator";
  text: string;
  time: string;
  thinking?: boolean;
}

export interface PlainThread {
  id: string;
  title: string;
  age: string;
  working?: boolean;
}

export const hosts: Host[] = [
  { id: "macbook", name: "macbook", kind: "This Mac", online: true, running: 1, slots: 3 },
  { id: "studio", name: "studio", kind: "Mac Studio over ssh", online: true, running: 2, slots: 6 },
  { id: "devbox", name: "devbox", kind: "Linux over ssh", online: true, running: 1, slots: 4 },
];

export const accounts: Account[] = [
  { id: "claude-max", provider: "claude", name: "Claude Max", used: 62, cap: 80, resets: "resets 3:40 PM" },
  { id: "chatgpt-pro", provider: "codex", name: "ChatGPT Pro", used: 28, cap: 100, resets: "resets Tue" },
  { id: "cursor-pro", provider: "cursor", name: "Cursor Pro", used: 91, cap: 90, resets: "resets Oct 12" },
];

export const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
export const accountProvider = (id: string): Provider =>
  accounts.find((a) => a.id === id)?.provider ?? "claude";

export const projects: Project[] = [
  {
    id: "parallax",
    name: "parallax",
    color: "sky",
    repo: "~/Developer/personal/parallax",
    base: "develop",
    brief:
      "Ship the Projects experience for M4: a coordinator that hands work to child threads, an inbox that keeps Ryan in control, and one branch that collects the result.",
    updated: "now",
    needs: 2,
    working: 3,
    done: 4,
  },
  {
    id: "docs-site",
    name: "docs-site",
    color: "violet",
    repo: "~/Developer/personal/parallax-docs",
    base: "main",
    brief: "Rewrite the getting started guide and add pages for hosts, subscriptions and projects.",
    updated: "2h",
    needs: 0,
    working: 1,
    done: 6,
  },
  {
    id: "bench",
    name: "plxd-bench",
    color: "green",
    repo: "~/Developer/personal/plxd-bench",
    base: "main",
    brief: "Measure dispatch latency and memory use with 20 concurrent children across three hosts.",
    updated: "Fri",
    needs: 0,
    working: 0,
    done: 3,
  },
];

export const plainThreads: PlainThread[] = [
  { id: "t-updater", title: "Rework the updater", age: "12m", working: true },
  { id: "t-onboard", title: "Onboarding copy pass", age: "3h" },
  { id: "t-icons", title: "Tahoe icon variants", age: "1d" },
  { id: "t-ssh", title: "ssh agent forwarding bug", age: "2d" },
];

export const initialChildren: Child[] = [
  {
    id: "c-retry",
    title: "Retry failed update downloads",
    status: "needs",
    summary: "Asks whether partial downloads should resume or restart.",
    host: "studio",
    account: "claude-max",
    model: "Opus 5.5",
    branch: "parallax/retry-update-downloads",
    add: 148,
    del: 22,
    age: "41m",
    steps: ["Waiting on your answer"],
    step: 0,
    transcript: [
      {
        kind: "brief",
        text: "Downloads of a new nightly fail on flaky Wi-Fi and the app gives up. Retry with backoff, show progress in the update toast, and keep the existing signature check.",
      },
      { kind: "agent", text: "I'll start with how electron-updater reports failures, then add a retry wrapper around the download." },
      { kind: "tool", verb: "Read", target: "src/main/updater.ts" },
      { kind: "tool", verb: "Searched", target: "download-progress", detail: "4 results in 3 files" },
      { kind: "tool", verb: "Edited", target: "src/main/updater.ts", add: 96, del: 18 },
      { kind: "tool", verb: "Edited", target: "src/renderer/Update.tsx", add: 52, del: 4 },
      { kind: "tool", verb: "Ran", target: "pnpm test updater", detail: "14 passed" },
      {
        kind: "agent",
        text: "Retries work with 1s, 4s and 16s backoff. One open question: electron-updater can resume a partial download from its blockmap, or restart cleanly. Resuming saves bandwidth but has failed for others when the server changes mid-download. I asked you in the inbox.",
      },
    ],
  },
  {
    id: "c-palette",
    title: "Command palette for project actions",
    status: "working",
    summary: "Wiring the palette into project tabs.",
    host: "macbook",
    account: "claude-max",
    model: "Opus 5.5",
    branch: "parallax/command-palette",
    add: 212,
    del: 31,
    age: "18m",
    steps: [
      "Reading keybindings.ts",
      "Adding palette entries for project tabs",
      "Editing CommandPalette.tsx",
      "Running pnpm check",
      "Writing tests for fuzzy match",
    ],
    step: 1,
    transcript: [
      { kind: "brief", text: "Add a command palette (Mod+K) that can jump to any project tab, thread or memory entry." },
      { kind: "tool", verb: "Read", target: "src/renderer/keybindings.ts" },
      { kind: "tool", verb: "Created", target: "src/renderer/CommandPalette.tsx", add: 164, del: 0 },
      {
        kind: "assumption",
        text: "Assumed fuzzy match should rank recent items first, like VS Code.",
        alternative: "Rank alphabetically",
      },
      { kind: "tool", verb: "Edited", target: "src/renderer/App.tsx", add: 48, del: 31 },
    ],
  },
  {
    id: "c-memory",
    title: "Memory proposals from child threads",
    status: "working",
    summary: "Adding propose_memory to the child tools.",
    host: "studio",
    account: "chatgpt-pro",
    model: "GPT-5.5 Codex",
    branch: "parallax/memory-proposals",
    add: 301,
    del: 57,
    age: "33m",
    steps: [
      "Editing crates/plxd/src/mcp/child.rs",
      "Running cargo test -p plxd memory",
      "Updating protocol types",
      "Regenerating apps/desktop/src/protocol/generated",
    ],
    step: 0,
    transcript: [
      { kind: "brief", text: "Children can propose memory entries. The coordinator accepts, edits or dismisses them. No direct writes from children." },
      { kind: "tool", verb: "Read", target: "crates/plxd/src/mcp/child.rs" },
      { kind: "tool", verb: "Edited", target: "crates/plxd/src/memory.rs", add: 188, del: 40 },
    ],
  },
  {
    id: "c-sched",
    title: "Scheduler: spill to devbox when Claude is capped",
    status: "working",
    summary: "Ranking hosts by quota headroom.",
    host: "devbox",
    account: "claude-max",
    model: "Sonnet 5.5",
    branch: "parallax/scheduler-spill",
    add: 96,
    del: 12,
    age: "9m",
    steps: ["Reading scheduler.rs", "Adding headroom ranking", "Running cargo test -p plxd scheduler"],
    step: 1,
    transcript: [
      { kind: "brief", text: "When an account passes its cap, place new children on the next account with headroom, then the next host." },
      { kind: "tool", verb: "Read", target: "crates/plxd/src/scheduler.rs" },
    ],
  },
  {
    id: "c-e2e",
    title: "E2E test for the landing queue",
    status: "queued",
    summary: "Waiting for Claude quota.",
    queueReason: "Waiting for Claude quota, resets at 3:40 PM",
    host: "macbook",
    account: "claude-max",
    model: "Opus 5.5",
    branch: "parallax/e2e-landing-queue",
    add: 0,
    del: 0,
    age: "4m",
    steps: ["Queued"],
    step: 0,
    transcript: [{ kind: "brief", text: "Cover land, conflict and revert in the Playwright suite against the fake backend." }],
  },
  {
    id: "c-inbox",
    title: "Inbox read state",
    status: "review",
    summary: "Ready to land. Adds seenAt to inbox items.",
    host: "studio",
    account: "claude-max",
    model: "Opus 5.5",
    branch: "parallax/inbox-read-state",
    add: 84,
    del: 19,
    age: "1h",
    steps: ["Finished"],
    step: 0,
    transcript: [
      { kind: "brief", text: "Inbox items get read state using the seenAt model from 0033." },
      { kind: "tool", verb: "Edited", target: "crates/plxd/src/inbox.rs", add: 61, del: 12 },
      { kind: "tool", verb: "Ran", target: "scripts/ci/check-rust", detail: "passed" },
      { kind: "agent", text: "Done. Items are marked seen when they scroll into view for one second, matching threads." },
    ],
  },
  {
    id: "c-brief",
    title: "Brief editor",
    status: "landed",
    summary: "Landed as 3f2a91c.",
    host: "macbook",
    account: "claude-max",
    model: "Opus 5.5",
    branch: "parallax/brief-editor",
    add: 132,
    del: 40,
    age: "3h",
    steps: ["Landed"],
    step: 0,
    transcript: [{ kind: "brief", text: "Let Ryan edit the project brief in place." }],
  },
  {
    id: "c-dispatch",
    title: "Instant dispatch from the composer",
    status: "landed",
    summary: "Landed as a81c0de.",
    host: "studio",
    account: "chatgpt-pro",
    model: "GPT-5.5 Codex",
    branch: "parallax/instant-dispatch",
    add: 240,
    del: 88,
    age: "5h",
    steps: ["Landed"],
    step: 0,
    transcript: [{ kind: "brief", text: "Enter starts a child without waiting on the coordinator's turn." }],
  },
  {
    id: "c-icons",
    title: "Project icon picker in light mode",
    status: "failed",
    summary: "Checks failed twice: contrast test on yellow.",
    host: "devbox",
    account: "cursor-pro",
    model: "Composer 2",
    branch: "parallax/icon-picker-light",
    add: 18,
    del: 6,
    age: "2h",
    steps: ["Failed"],
    step: 0,
    transcript: [
      { kind: "brief", text: "The yellow project icon is too faint on a selected row in light mode." },
      { kind: "tool", verb: "Ran", target: "pnpm test projectIcons", detail: "1 failed: yellow on selected is 2.7:1" },
    ],
  },
];

export const initialDecisions: Decision[] = [
  {
    id: "d-resume",
    childId: "c-retry",
    question: "Should a failed update download resume, or start over?",
    context:
      "Resuming uses the blockmap and saves bandwidth on large updates. Starting over is simpler and avoids a known electron-updater bug when the release changes mid-download.",
    options: [
      { label: "Start over", detail: "Simpler, always consistent. About 140 MB per retry.", recommended: true },
      { label: "Resume", detail: "Saves bandwidth. Needs a guard for changed releases." },
      { label: "Resume, then start over on mismatch", detail: "Both, with more code to test." },
    ],
    asked: "38m ago",
  },
  {
    id: "d-pr",
    childId: "c-inbox",
    question: "Land Inbox read state on the project branch?",
    context: "Checks passed on studio. It touches crates/plxd/src/inbox.rs and the inbox protocol type. No conflicts with the queue.",
    options: [
      { label: "Land it", detail: "Merges as one commit onto parallax/projects-m4.", recommended: true },
      { label: "Review the diff first", detail: "Opens the diff. Nothing lands yet." },
    ],
    asked: "1h ago",
  },
];

export const initialAutoDecisions: AutoDecision[] = [
  {
    id: "a1",
    childId: "c-palette",
    chose: "Ranked recent items first in the palette",
    because: "Matches VS Code and your note to follow T3 Code.",
    alternative: "Rank alphabetically",
  },
  {
    id: "a2",
    childId: "c-memory",
    chose: "Stored proposals in SQLite, not in memory files",
    because: "Memory files stay human edited; the store already keeps runs there.",
    alternative: "Write proposals as files under context/",
  },
  {
    id: "a3",
    childId: "c-sched",
    chose: "Kept a 20% reserve on Claude Max",
    because: "Your memory says to keep a reserve for interactive work.",
    alternative: "Use the full limit",
  },
];

export const initialMemory: MemoryEntry[] = [
  {
    id: "m-p1",
    kind: "preference",
    text: "Match T3 Code for UI layout and density.",
    source: "You",
    date: "Sep 12",
    scope: "you",
  },
  {
    id: "m-p2",
    kind: "preference",
    text: "No emojis in UI or commits. Plain declarative copy.",
    source: "You",
    date: "Sep 12",
    scope: "you",
  },
  {
    id: "m-p3",
    kind: "preference",
    text: "Keep a 20% reserve on each subscription for interactive use.",
    source: "Coordinator",
    date: "Oct 3",
    scope: "you",
  },
  {
    id: "m-c1",
    kind: "convention",
    text: "Branches are feature|bug|chore|docs/PLX-n-slug, from develop.",
    source: "AGENTS.md",
    date: "Oct 3",
    scope: "repo",
  },
  {
    id: "m-c2",
    kind: "convention",
    text: "Run scripts/ci/check-rust before pushing Rust changes.",
    source: "Instant dispatch",
    date: "Oct 2",
    scope: "repo",
  },
  {
    id: "m-c3",
    kind: "convention",
    text: "Use Jest for renderer unit tests.",
    source: "Brief editor",
    date: "Sep 20",
    scope: "repo",
    stale: "No Jest config or dependency found in apps/desktop.",
  },
  {
    id: "m-d1",
    kind: "decision",
    text: "Children never write memory directly. They propose, the coordinator curates.",
    source: "You, in chat",
    date: "Oct 3",
    scope: "project",
  },
  {
    id: "m-d2",
    kind: "decision",
    text: "One PR from the project branch by default, not a stack.",
    source: "You, in chat",
    date: "Oct 3",
    scope: "project",
  },
  {
    id: "m-g1",
    kind: "gotcha",
    text: "Generated protocol types must be regenerated after any change in crates/protocol.",
    source: "Memory proposals",
    date: "Today",
    scope: "repo",
    fresh: true,
  },
  {
    id: "m-g2",
    kind: "gotcha",
    text: "electron-updater on macOS needs the zip, not the dmg, to apply updates.",
    source: "Retry failed update downloads",
    date: "Today",
    scope: "repo",
    proposed: true,
  },
  {
    id: "m-g3",
    kind: "decision",
    text: "Inbox items count as seen after one second in view, like threads.",
    source: "Inbox read state",
    date: "Today",
    scope: "project",
    proposed: true,
  },
];

export const knowledgeFiles: KnowledgeFile[] = [
  {
    id: "f1",
    name: "Projects plan",
    kind: "doc",
    summary: "Phases, concepts and open questions for M4 to M6.",
    updated: "Oct 3",
    size: "17 KB",
  },
  {
    id: "f2",
    name: "Orchestration brainstorm",
    kind: "research",
    summary: "T3 Code's orchestrator transaction model compared with plxd.",
    updated: "Oct 3",
    size: "11 KB",
  },
  {
    id: "f3",
    name: "Landing queue test instructions",
    kind: "doc",
    summary: "How to reproduce conflicts and reverts with the fake backend.",
    updated: "Today",
    size: "3 KB",
  },
  {
    id: "f4",
    name: "Cursor Projects reference",
    kind: "link",
    summary: "cursor.com/docs/projects",
    updated: "Sep 28",
    size: "Link",
  },
];

export const boardNotes = [
  { heading: "Now", items: ["Retry failed update downloads waits on a resume or restart answer.", "Palette, memory proposals and scheduler are running on three hosts."] },
  { heading: "Next", items: ["E2E test for the landing queue, once Claude quota resets.", "Fix icon picker contrast and retry."] },
  { heading: "Risks", items: ["Cursor Pro is past its 90% cap until Oct 12. New Cursor work goes to Claude."] },
];

export const history = [
  { title: "Instant dispatch from the composer", outcome: "Landed", learned: "plxd starts the child before telling the coordinator.", when: "5h" },
  { title: "Brief editor", outcome: "Landed", learned: "Brief edits message running children.", when: "3h" },
  { title: "Project icon picker in light mode", outcome: "Failed", learned: "Yellow needs #a16207 on selected rows.", when: "2h" },
];

export const initialLanded: Landed[] = [
  { sha: "a81c0de", title: "Start a child as soon as Enter is pressed", childId: "c-dispatch", add: 240, del: 88, when: "5h" },
  { sha: "3f2a91c", title: "Edit the project brief in place", childId: "c-brief", add: 132, del: 40, when: "3h" },
];

export const combinedFiles = [
  { path: "apps/desktop/src/renderer/Composer.tsx", add: 141, del: 63 },
  { path: "crates/plxd/src/dispatch.rs", add: 99, del: 25 },
  { path: "apps/desktop/src/renderer/BriefEditor.tsx", add: 88, del: 0 },
  { path: "crates/plxd/src/memory.rs", add: 44, del: 40 },
];

export const initialChat: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    text: "Pick up the M4 inbox work and the scheduler spill. Keep me out of anything routine.",
    time: "8:12 AM",
  },
  {
    id: "m2",
    role: "coordinator",
    text: "Started five threads across macbook, studio and devbox. Autonomy is set to Routine, so I'll answer questions that memory or the code settle, and bring you anything that changes behavior or can't be undone.",
    time: "8:12 AM",
  },
];

export const models = [
  { id: "opus", name: "Opus 5.5", provider: "claude" as Provider, note: "Most capable" },
  { id: "sonnet", name: "Sonnet 5.5", provider: "claude" as Provider, note: "Fast, strong at code" },
  { id: "haiku", name: "Haiku 4.5", provider: "claude" as Provider, note: "Quickest" },
  { id: "codex", name: "GPT-5.5 Codex", provider: "codex" as Provider, note: "ChatGPT Pro" },
  { id: "composer", name: "Composer 2", provider: "cursor" as Provider, note: "Cursor Pro" },
];

export const efforts = ["Low", "Medium", "High", "Max"] as const;

export const permissionModes = [
  { id: "ask", name: "Ask", note: "Approve each command and edit." },
  { id: "auto", name: "Auto", note: "Edits and safe commands run. Risky ones ask." },
  { id: "bypass", name: "Bypass", note: "Everything runs. Use in a sandbox." },
];
