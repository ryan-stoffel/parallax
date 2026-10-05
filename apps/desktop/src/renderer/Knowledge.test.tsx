// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge, SubscriptionMessage } from "../preload/bridge";
import type {
  AgentRun,
  ContextFile,
  InboxItem,
  MemoryFile,
  ProviderInfo,
} from "../protocol/generated/protocol";
import type { InboxView } from "./Inbox";
import { KnowledgePanel } from "./Knowledge";
import { changeMessage } from "./MemoryPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers.
HTMLElement.prototype.hidePopover = () => {};

const now = Date.parse("2026-10-04T12:00:00Z");
const file = (path: string, modifiedAt = "2026-10-04T11:00:00Z"): ContextFile => ({
  path,
  size: 10,
  modifiedAt,
});
const board = `# Status

## Now
- [ ] **Search command**: one subagent adds it, with tests
- [x] **Fix the login bug**: landed
## Next
- [ ] Write the docs
## Risks
- [ ] **Flaky CI**: the e2e job times out on Windows

Older items: [archived](archived.md)
`;
const coordinator: AgentRun = {
  id: "c-1",
  project: "p-1",
  prompt: "Plan it",
  policy: "noWrite",
  status: "running",
  backend: "claude",
  accountId: "claude",
  model: "claude-opus-5-5",
  createdAt: "2026-10-04T10:00:00Z",
  updatedAt: "2026-10-04T10:00:00Z",
};
const learned = (id: string, text: string, createdAt: string) =>
  ({ id, kind: "learned", run: "r-1", text, createdAt }) as InboxItem;
const inbox: InboxView = {
  items: [
    learned("i-1", "Memory: tests run with pnpm test", "2026-10-04T11:30:00Z"),
    learned("i-2", "Memory: the API keeps v1 paths", "2026-10-02T09:00:00Z"),
  ],
  questions: [],
  seen: async () => {},
  answer: async () => undefined,
};

let capabilities: Record<string, object>;
let files: ContextFile[];
let contents: Record<string, string>;
let memory: MemoryFile[];
let providers: ProviderInfo[];
const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
  const ok = (result: unknown) => ({ logId: "log-1", result });
  if (method === "agent/list") return ok({ runs: [], seq: 1 });
  if (method === "context/list") return ok({ files });
  if (method === "context/read") {
    const path = params["path"] as string;
    return ok({ file: file(path), content: contents[path] ?? "" });
  }
  if (method === "memory/list")
    return ok({ files: (params["scope"] as { kind: string }).kind === "project" ? memory : [] });
  if (method === "providers/list") return ok({ providers });
  return ok({ run: coordinator });
});

// Every subscription gets every event, as plxd's per-Project ones would here.
let listeners: Set<(message: SubscriptionMessage) => void>;
/** An agent's write to a context file, as plxd reports it. */
const changed = (seq: number, f: ContextFile) =>
  act(async () =>
    listeners.forEach((l) =>
      l({
        type: "event",
        event: { subscription: "s-1", seq, time: "", event: { kind: "context.changed", file: f } },
      }),
    ),
  );

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  request.mockClear();
  capabilities = { memory: {} };
  files = [file("notes.md"), file("plan.md")];
  contents = { "notes.md": board, "plan.md": "# Plan" };
  listeners = new Set();
  memory = [
    { path: "brief.md", size: 10, modifiedAt: "2026-10-01T00:00:00Z" },
    { path: "memory/convention/vitest.md", size: 10, modifiedAt: "2026-10-04T08:00:00Z" },
  ];
  providers = [];
  window.parallax = {
    platform: "darwin",
    request,
    subscribe: (_host, _params, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities,
    }),
    onConnectionState: () => () => {},
  } as Partial<ParallaxBridge> as ParallaxBridge;
});

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.useRealTimers();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};
const click = async (element: Element | null | undefined) => {
  await act(async () => (element as HTMLElement).click());
  await settle();
};

/** Renders a Project's Knowledge view on `host`, with its agents `working` or not. */
async function render(host: string, working = false, expanded = false) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <KnowledgePanel
        hostId={host}
        project="p-1"
        repo="r-1"
        coordinator={coordinator}
        connected
        memory
        inbox={inbox}
        working={working}
        expanded={expanded}
      />,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  await settle();
}

const section = (label: string) =>
  document.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
/** Each item of a board section: its lead and its detail line. */
const items = (label: string) =>
  [...section(label).querySelectorAll("li")].map((li) =>
    [...li.querySelectorAll(":scope > span:last-child > span:not(.sr-only)")].map(
      (s) => s.textContent,
    ),
  );

test("Where it stands is the status board as checklists: a lead and a detail per item, Now working, Risks warned", async () => {
  await render("h-board", true);
  expect(section("Where it stands").textContent).toContain("updated 1h");
  expect(section("Now").querySelector("h4")!.textContent).toBe("Now1 of 2 done");
  expect(items("Now")).toEqual([
    ["Search command", "one subagent adds it, with tests"],
    ["Fix the login bug", "landed"],
  ]);
  expect(items("Next")).toEqual([["Write the docs"]]);
  // An open Now item moves while agents work, a done one is checked, and a risk is warned.
  const marks = (label: string) =>
    [...section(label).querySelectorAll("li > span:first-child > *")].map(
      (m) => m.getAttribute("class")?.split(" ")[0],
    );
  expect(marks("Now")).toEqual(["loader", "text-added"]);
  expect(marks("Next")).toEqual(["lucide"]);
  expect(section("Risks").querySelector("svg")!.classList).toContain("lucide-triangle-alert");
  // Lines that aren't items aren't shown.
  expect(section("Where it stands").textContent).not.toContain("Older items");
});

test("idle agents leave Now as open circles", async () => {
  await render("h-idle");
  expect(section("Now").querySelector("li svg")!.classList).toContain("lucide-circle");
});

test("the book opens Project files, the board first, and a file opens in place", async () => {
  await render("h-files");
  await click(document.querySelector('button[aria-label="Project files"]'));
  const files = [...document.querySelectorAll("li button .font-mono")].map((f) => f.textContent);
  expect(files).toEqual(["notes.md", "plan.md"]);
  await click(
    [...document.querySelectorAll("li button")].find((b) => b.textContent?.startsWith("plan.md")),
  );
  expect(request.mock.calls.filter(([, m]) => m === "context/read").at(-1)?.[2]).toEqual({
    project: "p-1",
    path: "plan.md",
  });
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "plan.md"));
  await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Knowledge"));
  expect(section("Where it stands")).not.toBeNull();
});

const plan = `# Plan

- [ ] Unify launcher modes ([#17](https://github.com/o/r/issues/17))
- [x] Welcome window ([#12](https://github.com/o/r/pull/12))

Older items: [archived](archived.md), [gone](gone.md)`;
const doc = (path: string) => document.querySelector(`article[aria-label="${path}"]`);

test("a context file shows tasks as circles, GitHub links with their icons, opens other context files in place, and follows agents' writes", async () => {
  files = [file("notes.md"), file("plan.md"), file("archived.md")];
  contents = { "notes.md": board, "plan.md": plan, "archived.md": "- [x] Old work" };
  await render("h-links");
  await click(document.querySelector('button[aria-label="Project files"]'));
  await click(
    [...document.querySelectorAll("li button")].find((b) => b.textContent?.startsWith("plan.md")),
  );
  const shown = doc("plan.md")!;
  expect(shown.querySelector("input")).toBeNull();
  expect(
    [...shown.querySelectorAll("li")].map((li) => [
      li.querySelector("svg")?.getAttribute("aria-label"),
      li.textContent,
    ]),
  ).toEqual([
    ["Open", " Unify launcher modes (#17)"],
    ["Done", " Welcome window (#12)"],
  ]);
  expect(shown.querySelector('a[href$="/pull/12"] svg.lucide-git-merge')).not.toBeNull();
  const issue = shown.querySelector('a[href$="/issues/17"]')!;
  expect(issue.querySelector("svg:not(.lucide)")).not.toBeNull();
  expect(issue.getAttribute("target")).toBe("_blank");

  // A missing file's link is off; an existing one opens in place, with a way back.
  const link = (name: string) =>
    [...shown.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;
  expect(link("gone").disabled).toBe(true);
  await click(link("archived"));
  expect(doc("archived.md")!.textContent).toContain("Old work");

  // It follows an agent's rewrite, and a new file joins Project files.
  contents["archived.md"] = "- [x] Older work";
  await changed(8, file("archived.md", "2026-10-04T12:00:00Z"));
  expect(doc("archived.md")!.textContent).toContain("Older work");
  await changed(9, file("research.md", "2026-10-04T12:00:00Z"));
  await click(
    [...document.querySelectorAll("button")].find((b) => b.textContent === "archived.md"),
  );
  expect(doc("archived.md")).toBeNull();
  expect([...document.querySelectorAll("li button .font-mono")].map((f) => f.textContent)).toEqual([
    "notes.md",
    "archived.md",
    "plan.md",
    "research.md",
  ]);
});

test("What it knows counts what's known and new today, lists the latest learned, and the brief starts folded", async () => {
  await render("h-known");
  // Two memory files, two context files, and two learned, four of them from the last day.
  expect(section("What it knows").textContent).toContain("6 things, 4 new today");
  expect(
    [...document.querySelectorAll('[aria-label="Learned lately"] li')].map((li) => li.textContent),
  ).toEqual(["tests run with pnpm test30m", "the API keeps v1 paths2d"]);
  expect(
    request.mock.calls.some(([, m, p]) => m === "memory/read" && p["path"] === "brief.md"),
  ).toBe(false);
});

/** A provider plxd lists, which runs a Project's coordinator. */
const provider = (id: "claude" | "codex", name: string): ProviderInfo =>
  ({
    instance: { id, kind: id, name, enabled: true, args: [], env: [], models: [] },
    installed: true,
    models: [],
    permissions: ["auto", "bypass"],
    efforts: true,
    coordinator: true,
  }) as ProviderInfo;
const sends = () => request.mock.calls.filter(([, m]) => m === "agent/send").map(([, , p]) => p);
async function typeChange(text: string) {
  const box = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Change knowledge"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

test("the mini prompt sends a change to the coordinator, and a model on another provider moves it there", async () => {
  capabilities = { memory: {}, providers: {}, sendModel: {}, sendAccount: {} };
  providers = [provider("claude", "Claude"), provider("codex", "Codex")];
  await render("h-prompt");
  await typeChange("We moved off Jest, use Vitest");
  expect(sends()).toEqual([
    {
      runId: "c-1",
      turnId: expect.any(String),
      text: changeMessage("We moved off Jest, use Vitest"),
    },
  ]);
  expect(document.querySelector('[role="status"]')!.textContent).toBe(
    "Sent. The coordinator's rewrite shows up as a proposal.",
  );

  // The picker shows the coordinator's providers as a row of logos.
  expect(document.querySelector('button[aria-label^="Model: "]')!.getAttribute("aria-label")).toBe(
    "Model: Claude Opus 5.5",
  );
  const tabs = [...document.querySelectorAll('[role="tablist"][aria-label="Provider"] button')];
  expect(tabs.map((t) => t.textContent)).toEqual(["Claude", "Codex"]);
  await click(tabs[1]);
  const codex = document.querySelector<HTMLElement>('[role="listbox"] [role="option"]')!;
  const model = codex.textContent!.replace(/New$/, "");
  await click(codex);
  await typeChange("Forget the old API notes");
  expect(sends()[1]).toMatchObject({
    runId: "c-1",
    model: expect.any(String),
    account: { kind: "subscription", backend: "codex" },
  });
  expect(document.querySelector('button[aria-label^="Model: "]')!.getAttribute("aria-label")).toBe(
    `Model: ${model}`,
  );
});

test("without sendAccount, the mini prompt offers only the coordinator's own provider", async () => {
  capabilities = { memory: {}, providers: {}, sendModel: {} };
  providers = [provider("claude", "Claude"), provider("codex", "Codex")];
  await render("h-own");
  expect(document.querySelector('[role="tablist"][aria-label="Provider"]')).toBeNull();
  expect(
    [...document.querySelectorAll('[role="listbox"] [role="option"]')].every((o) =>
      o.textContent?.startsWith("Claude"),
    ),
  ).toBe(true);
});

test("full screen centers Knowledge with the larger prompt", async () => {
  await render("h-full", false, true);
  const box = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Change knowledge"]',
  )!;
  expect(box.placeholder).toBe(
    "Tell the Project what changed, what to remember, or what to forget",
  );
  expect(box.getAttribute("rows")).toBe("2");
  expect(document.body.firstElementChild!.firstElementChild!.classList).toContain("max-w-3xl");
});
