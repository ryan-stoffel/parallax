// Made-up tracker issues for the preview, shaped as plxd reports them (0107): `issue/connections`,
// `issue/connect`, `issue/disconnect`, `issue/list`, `issue/get`, `issue/containers`,
// `issue/create`, `issue/setState`, and `issue/comment`. GitHub, Linear, and a Jira site answer;
// a second Jira site's token has expired, so its issues are missing.
import type {
  Issue,
  IssueComment,
  IssueConnectParams,
  IssueConnection,
  IssueContainer,
  IssueProvider,
  IssueState,
} from "../src/protocol/generated/protocol";

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const LINEAR = "01a0f702-5e6f-7a81-9c83-9d0e1f2a3b06";
const JIRA = "01a0f702-5e6f-7a81-9c83-9d0e1f2a3b07";
const JIRA_OLD = "01a0f702-5e6f-7a81-9c83-9d0e1f2a3b08";

// `#issues=none` starts with no tracker connected, gh signed out included. Connecting Linear or
// Jira there saves the first account below, so its issues show.
const none = new URLSearchParams(location.hash.slice(1)).get("issues") === "none";
let connections: IssueConnection[] = none
  ? []
  : [
      { id: "github", provider: "github", account: "ryanstoffel" },
      { id: LINEAR, provider: "linear", account: "Ryan Stoffel", site: "Parallax" },
      {
        id: JIRA,
        provider: "jira",
        account: "ryan@parallax.codes",
        site: "parallax.atlassian.net",
      },
      { id: JIRA_OLD, provider: "jira", account: "ryan@acme.example", site: "acme.atlassian.net" },
    ];

/** The states each tracker's issues move between, as `issue/get` lists them. */
const states: Record<IssueProvider, IssueState[]> = {
  github: [
    { id: "open", name: "Open", category: "todo" },
    { id: "completed", name: "Closed as completed", category: "done" },
    { id: "notPlanned", name: "Closed as not planned", category: "canceled" },
  ],
  linear: [
    { id: "lin-backlog", name: "Backlog", category: "backlog", color: "#bec2c8" },
    { id: "lin-todo", name: "Todo", category: "todo", color: "#e2e2e2" },
    { id: "lin-progress", name: "In Progress", category: "inProgress", color: "#f2c94c" },
    { id: "lin-review", name: "In Review", category: "inProgress", color: "#0f783c" },
    { id: "lin-done", name: "Done", category: "done", color: "#5e6ad2" },
    { id: "lin-canceled", name: "Canceled", category: "canceled", color: "#95a2b3" },
  ],
  jira: [
    { id: "11", name: "To Do", category: "todo" },
    { id: "21", name: "In Progress", category: "inProgress" },
    { id: "31", name: "Done", category: "done" },
  ],
};

const containers: Record<string, IssueContainer[]> = {
  github: [
    { id: "ryan-stoffel/parallax", name: "ryan-stoffel/parallax" },
    { id: "ryan-stoffel/docs-site", name: "ryan-stoffel/docs-site" },
  ],
  [LINEAR]: [
    { id: "team-plx", name: "Parallax" },
    { id: "team-web", name: "Website" },
  ],
  [JIRA]: [
    { id: "OPS", name: "Operations" },
    { id: "REL", name: "Release" },
  ],
};

const state = (provider: IssueProvider, id: string) => states[provider].find((s) => s.id === id)!;

let issues: Issue[] = [
  {
    connectionId: LINEAR,
    provider: "linear",
    id: "lin-1595",
    key: "PLX-1595",
    title: "Issues page, New issue, and Settings › Issue trackers with provider logos",
    url: "https://linear.app/parallax/issue/PLX-1595",
    state: state("linear", "lin-progress"),
    container: containers[LINEAR]![0]!,
    assignee: "Ryan Stoffel",
    updatedAt: at(4),
  },
  {
    connectionId: "github",
    provider: "github",
    id: "ryan-stoffel/parallax#1262",
    key: "#1262",
    title: "A nightly on Windows arm64 fails to verify its update signature",
    url: "https://github.com/ryan-stoffel/parallax/issues/1262",
    state: state("github", "open"),
    container: containers["github"]![0]!,
    assignee: "ryanstoffel",
    updatedAt: at(38),
  },
  {
    connectionId: JIRA,
    provider: "jira",
    id: "OPS-412",
    key: "OPS-412",
    title: "Rotate the relay's staging certificates before they expire",
    url: "https://parallax.atlassian.net/browse/OPS-412",
    state: state("jira", "21"),
    container: containers[JIRA]![0]!,
    assignee: "Ryan Stoffel",
    updatedAt: at(95),
  },
  {
    connectionId: LINEAR,
    provider: "linear",
    id: "lin-1588",
    key: "PLX-1588",
    title: "Thread search misses matches inside code blocks",
    url: "https://linear.app/parallax/issue/PLX-1588",
    state: state("linear", "lin-review"),
    container: containers[LINEAR]![0]!,
    assignee: "Ryan Stoffel",
    updatedAt: at(60 * 5),
  },
  {
    connectionId: "github",
    provider: "github",
    id: "ryan-stoffel/docs-site#87",
    key: "#87",
    title: "The install page still links the old AppImage name",
    url: "https://github.com/ryan-stoffel/docs-site/issues/87",
    state: state("github", "open"),
    container: containers["github"]![1]!,
    assignee: "ryanstoffel",
    updatedAt: at(60 * 9),
  },
  {
    connectionId: LINEAR,
    provider: "linear",
    id: "lin-1570",
    key: "PLX-1570",
    title: "Let a schedule skip a run while the computer is on battery",
    url: "https://linear.app/parallax/issue/PLX-1570",
    state: state("linear", "lin-todo"),
    container: containers[LINEAR]![0]!,
    assignee: "Ryan Stoffel",
    updatedAt: at(60 * 26),
  },
  {
    connectionId: JIRA,
    provider: "jira",
    id: "REL-58",
    key: "REL-58",
    title: "Write the release checklist for promoting a nightly",
    url: "https://parallax.atlassian.net/browse/REL-58",
    state: state("jira", "11"),
    container: containers[JIRA]![1]!,
    assignee: "Ryan Stoffel",
    updatedAt: at(60 * 50),
  },
  {
    connectionId: LINEAR,
    provider: "linear",
    id: "lin-102",
    key: "WEB-102",
    title: "Pricing page: explain what Parallax Connect includes",
    url: "https://linear.app/parallax/issue/WEB-102",
    state: state("linear", "lin-backlog"),
    container: containers[LINEAR]![1]!,
    assignee: "Ryan Stoffel",
    updatedAt: at(60 * 24 * 6),
  },
];

const bodies: Record<string, string> = {
  "ryan-stoffel/parallax#1262": `A nightly installed on a Windows arm64 laptop downloads the next nightly, then stops with **Couldn't verify the update**.

## Steps

1. Install \`v2611.11612.10000-nightly\` on Windows arm64.
2. Wait for the next nightly, or run **Check for updates**.
3. The download finishes and the error shows.

## What I found

- [x] x64 verifies the same release
- [x] \`latest.yml\` lists both installers
- [ ] The arm64 entry's \`sha512\` matches the uploaded file

\`\`\`text
Error: sha512 checksum mismatch, expected 9f2c…, got 41ab…
    at verifyDownload (updater.ts:212)
\`\`\`

The \`finish\` job joins the Windows metadata, so it may be writing the x64 hash for both.`,
  "lin-1595": `Once plxd reads and writes tracker issues, the app needs somewhere to show them, change them, and connect accounts.

- An Issues page with search, a tracker filter, and sort
- An issue view with a state picker and comments
- New issue
- Settings › Issue trackers`,
};

const comments: Record<string, IssueComment[]> = {
  "ryan-stoffel/parallax#1262": [
    {
      id: "IC_1",
      author: "mkowalski",
      body: "Same on a Surface Pro 11. Reinstalling from the release page works, so only the updater's check fails.",
      createdAt: at(60 * 3),
    },
    {
      id: "IC_2",
      author: "ryanstoffel",
      body: "Confirmed: `latest.yml` has the x64 `sha512` under the arm64 file. The join in `finish` reads the wrong artifact.",
      createdAt: at(38),
    },
  ],
};

const find = (id: string) => issues.find((i) => i.id === id)!;

export const issueHandlers = {
  "issue/connections": () => ({ connections }),
  "issue/connect": (p: IssueConnectParams) => {
    // A Linear key that isn't shaped like one is refused, as Linear would refuse it.
    if (p.provider === "linear" && !p.apiKey.startsWith("lin_api_"))
      return { code: -32603, message: "Linear refused the API key. Check it and try again." };
    const connection: IssueConnection =
      p.provider === "linear"
        ? connections.some((c) => c.id === LINEAR)
          ? { id: crypto.randomUUID(), provider: "linear", account: "Ryan Stoffel", site: "Acme" }
          : { id: LINEAR, provider: "linear", account: "Ryan Stoffel", site: "Parallax" }
        : {
            id: connections.some((c) => c.id === JIRA) ? crypto.randomUUID() : JIRA,
            provider: "jira",
            account: p.email,
            site: p.site.replace(/^https?:\/\//, ""),
          };
    connections = [...connections, connection];
    return { connection };
  },
  "issue/disconnect": (p: { id: string }) => {
    if (p.id !== "github") connections = connections.filter((c) => c.id !== p.id);
    return {};
  },
  "issue/list": () => ({
    issues: issues
      .filter((i) => connections.some((c) => c.id === i.connectionId))
      .filter((i) => i.state.category !== "done" && i.state.category !== "canceled")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    errors: connections.some((c) => c.id === JIRA_OLD)
      ? [{ connectionId: JIRA_OLD, message: "Jira refused the API token. It may have expired." }]
      : [],
  }),
  "issue/get": (p: { id: string }) => {
    const issue = find(p.id);
    return {
      issue,
      body: bodies[p.id] ?? "",
      comments: comments[p.id] ?? [],
      states: states[issue.provider],
    };
  },
  "issue/containers": (p: { connectionId: string }) => ({
    containers: containers[p.connectionId] ?? [],
  }),
  "issue/create": (p: {
    connectionId: string;
    containerId: string;
    title: string;
    body: string;
  }) => {
    const { provider } = connections.find((c) => c.id === p.connectionId)!;
    const container = containers[p.connectionId]!.find((c) => c.id === p.containerId)!;
    const n = 2000 + issues.length;
    const key =
      provider === "github" ? `#${n}` : `${provider === "jira" ? container.id : "PLX"}-${n}`;
    const issue: Issue = {
      connectionId: p.connectionId,
      provider,
      id: provider === "github" ? `${container.id}#${n}` : key,
      key,
      title: p.title,
      url: `https://example.com/${provider}/${n}`,
      state: states[provider].find((s) => s.category === "todo")!,
      container,
      assignee: "Ryan Stoffel",
      updatedAt: at(0),
    };
    issues = [issue, ...issues];
    bodies[issue.id] = p.body;
    return issue;
  },
  "issue/setState": (p: { id: string; stateId: string }) => {
    const issue = find(p.id);
    const next = { ...issue, state: state(issue.provider, p.stateId), updatedAt: at(0) };
    issues = issues.map((i) => (i.id === p.id ? next : i));
    return next;
  },
  "issue/comment": (p: { id: string; body: string }) => {
    const comment: IssueComment = {
      id: crypto.randomUUID(),
      author: "ryanstoffel",
      body: p.body,
      createdAt: at(0),
    };
    comments[p.id] = [...(comments[p.id] ?? []), comment];
    return comment;
  },
};
