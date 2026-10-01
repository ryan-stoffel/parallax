// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { JsonValue } from "../protocol/generated/protocol";
import { duration, Timeline, ToolCall } from "./Activity";
import type { Item } from "./transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
afterEach(() => act(() => unmount()));

function render(node: ReactNode) {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
    unmount = () => {};
  };
  return (next: ReactNode) => act(() => root.render(next));
}

type Tool = Extract<Item, { kind: "tool" }>;
const tool = (name: string, input: JsonValue, rest: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  key: "t",
  callId: "1",
  name,
  input,
  status: "ok",
  ...rest,
});

// Text as people read it, each element's apart from the next.
function words(el?: Element | null) {
  if (!el) return "";
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll("*").forEach((e) => e.append(" "));
  return copy.textContent!.replace(/\s+/g, " ").trim();
}

/** A tool call's card, open unless said otherwise: its header's words, and its body. */
function card(item: Tool, { open = true, live = false } = {}) {
  unmount();
  render(<ToolCall item={item} live={live} open={open} onToggle={() => {}} />);
  const header = document.querySelector("button[aria-expanded]")!;
  const body = document.getElementById(header.getAttribute("aria-controls") ?? "");
  return { header: words(header), body: body!, text: words(body) };
}

test("an opened work group is a timeline: thinking alone, a run of calls in one card, and a TodoWrite told by its checklist", () => {
  const renderItem = vi.fn((item: Item) => <p>{item.kind}</p>);
  const items: Item[] = [
    { kind: "reasoning", key: "r", text: "First the tests.\nThen the fix." },
    tool("Read", { file_path: "/src/a.ts" }, { key: "t1" }),
    tool("Grep", { pattern: "TODO" }, { key: "t2", output: "Found 2 files\na.ts\nb.ts" }),
    tool("TodoWrite", { todos: [] }, { key: "t3" }),
    { kind: "todo", key: "c", items: [{ text: "Fix it", status: "inProgress" }] },
    tool("Bash", { command: "ls" }, { key: "t4", status: undefined }),
  ];
  render(
    <Timeline
      items={items}
      live
      active
      openKeys={new Set()}
      onToggle={() => {}}
      renderItem={renderItem}
    />,
  );
  const entries = [...document.querySelectorAll('ol[aria-label="Activity"] > li')];
  expect(entries.map(words)).toEqual([
    "Thinking First the tests.",
    "Read a.ts Succeeded",
    "Searched TODO 2 files Succeeded",
    "todo",
    "Running ls Running",
  ]);
  expect(renderItem).toHaveBeenCalledWith(items[4]);
  // The two calls in a row share a card: the first rounds its top, the second its bottom.
  const card = (i: number) => entries[i]!.lastElementChild!.className;
  expect(card(1)).toMatch(/rounded-t-xl/);
  expect(card(1)).not.toMatch(/rounded-b-xl/);
  expect(card(2)).toMatch(/rounded-b-xl/);
  expect(card(2)).not.toMatch(/rounded-t-xl/);
});

test("a row says what a call did to what, with the whole path on hover, then how long it took and how it went", () => {
  const path = "/Users/ryan/wisp/src/NewThread.tsx";
  const read = tool(
    "Read",
    { file_path: path, offset: 10, limit: 5 },
    {
      at: "2026-01-01T00:00:01.000Z",
      endedAt: "2026-01-01T00:00:04.600Z",
      output: "    10→a\n    11→b\n    12→c",
    },
  );
  expect(card(read, { open: false }).header).toBe("Read NewThread.tsx lines 10–12 3.6s Succeeded");
  expect(document.querySelector(`[title="${path}"]`)!.textContent).toBe("NewThread.tsx");

  // While it runs: the present tense, and its work's loader, said as text.
  const running = { ...read, status: undefined, output: undefined, endedAt: undefined };
  expect(card(running, { open: false, live: true }).header).toBe(
    "Reading NewThread.tsx lines 10–14 Running",
  );
  expect(document.querySelector('[data-loader="bands"][data-variant="descend"]')).not.toBeNull();
  expect(card(running, { open: false }).header).toBe("Read NewThread.tsx lines 10–14 No result");
  expect(document.querySelector(".loader")).toBeNull();
  expect(card({ ...read, status: "error" }, { open: false }).header).toMatch(/3\.6s Failed$/);
  expect(card({ ...read, status: "denied" }, { open: false }).header).toMatch(/3\.6s Denied$/);
});

test("a row opens and closes its card through the transcript, as a button that says so", () => {
  const onToggle = vi.fn();
  const rerender = render(
    <ToolCall
      item={tool("Bash", { command: "ls" })}
      live={false}
      open={false}
      onToggle={onToggle}
    />,
  );
  const header = document.querySelector("button")!;
  expect(header.getAttribute("aria-expanded")).toBe("false");
  act(() => header.click());
  expect(onToggle).toHaveBeenCalledWith("t", true);
  rerender(
    <ToolCall item={tool("Bash", { command: "ls" })} live={false} open onToggle={onToggle} />,
  );
  expect(header.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(header.getAttribute("aria-controls")!)).not.toBeNull();
});

test("a shell command opens as a terminal: its description, the prompt and command, and what it printed", () => {
  const failed = card(
    tool(
      "Bash",
      { command: "cd apps/desktop && pnpm check", description: "Lint and type-check" },
      { status: "error", output: "Exit code 1\nerror: Lint issues found" },
    ),
  );
  // The title leaves out the `cd`; the terminal has it all.
  expect(failed.header).toBe("Ran pnpm check Failed");
  expect(failed.body.querySelector("pre")!.textContent).toBe("$ cd apps/desktop && pnpm check");
  expect(failed.text).toContain("Lint and type-check");
  expect(failed.text).toContain("Exit code 1");
  expect(failed.text).toContain("error: Lint issues found");

  // Codex's commands come wrapped in a shell.
  const codex = card(tool("command_execution", { command: "/bin/zsh -lc 'echo hello'" }));
  expect(codex.header).toBe("Ran echo hello Succeeded");
  expect(codex.text).toContain("Shell");
});

test("an edit opens on its diff, colored and counted, and a MultiEdit on each of its edits", () => {
  const edit = card(
    tool("Edit", {
      file_path: "/src/a.ts",
      old_string: "one\ntwo\nthree",
      new_string: "one\n2\nthree\nfour",
    }),
  );
  expect(edit.header).toBe("Edited a.ts +2 −1 Succeeded");
  // Each changed line says how, beside its sign.
  expect(edit.text).toContain("one − Removed: two + Added: 2 three + Added: four");
  expect(edit.body.querySelector(".bg-emerald-500\\/10")!.textContent).toContain("2");
  expect(edit.body.querySelector(".bg-danger\\/10")!.textContent).toContain("two");

  const multi = card(
    tool("MultiEdit", {
      file_path: "/src/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d\ne" },
      ],
    }),
  );
  expect(multi.header).toBe("Edited a.ts +3 −2 Succeeded");
  expect(multi.text).toContain("2 edits");
  expect(multi.text).toContain("− Removed: a + Added: b − Removed: c + Added: d + Added: e");

  // Codex says only which files changed, and how.
  const codex = card(
    tool("file_change", {
      changes: [
        { path: "/r/a.ts", kind: "update" },
        { path: "/r/b.ts", kind: "add" },
      ],
    }),
  );
  expect(codex.header).toBe("Edited 2 files Succeeded");
  expect(codex.text).toContain("update /r/a.ts add /r/b.ts");
});

test("a new file shows its line count and first lines, and Show all shows the rest", () => {
  const content = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
  const write = card(tool("Write", { file_path: "/src/new.ts", content }));
  expect(write.header).toBe("Wrote new.ts 40 lines Succeeded");
  expect(write.text).toContain("12 line 12");
  expect(write.text).not.toContain("line 13");
  const all = [...write.body.querySelectorAll("button")].find(
    (b) => b.textContent === "Show all 40 lines",
  )!;
  expect(all.getAttribute("aria-expanded")).toBe("false");
  act(() => all.click());
  expect(words(write.body)).toContain("40 line 40");
  expect(all.textContent).toBe("Show less");
});

test("a read shows the file, the lines it covered, and those lines, without Claude Code's reminders", () => {
  const read = card(
    tool(
      "Read",
      { file_path: "/src/a.ts" },
      {
        output:
          "     1→const a = 1;\n     2→const b = 2;\n\n<system-reminder>\nIs it malware?\n</system-reminder>",
      },
    ),
  );
  expect(read.text).toContain("/src/a.ts lines 1–2");
  expect(read.text).toContain("1 const a = 1; 2 const b = 2;");
  expect(read.text).not.toContain("malware");
});

test("a search shows its pattern, how much it found, and what, by paths from where it looked", () => {
  const grep = card(
    tool(
      "Grep",
      { pattern: "TODO", path: "/repo/src" },
      { output: "Found 2 files\n/repo/src/a.ts\n/repo/src/b/c.ts" },
    ),
  );
  expect(grep.header).toBe("Searched TODO 2 files Succeeded");
  expect(grep.text).toBe("TODO in src 2 files a.ts b/c.ts");

  expect(
    card(tool("Glob", { pattern: "**/*.ts" }, { output: "/x/a.ts\n/x/b.ts\n/x/c.ts" })).header,
  ).toBe("Searched **/*.ts 3 files Succeeded");
  expect(card(tool("Grep", { pattern: "nope" }, { output: "No files found" })).header).toBe(
    "Searched nope no matches Succeeded",
  );
});

test("a web fetch shows its URL, what it asked, and the answer; a search shows the links it found", () => {
  const fetch = card(
    tool(
      "WebFetch",
      { url: "https://example.com/docs/page?x=1", prompt: "What does it say?" },
      { output: "It says hi." },
    ),
  );
  expect(fetch.header).toBe("Fetched example.com/docs/page Succeeded");
  const link = fetch.body.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("https://example.com/docs/page?x=1");
  expect(link.target).toBe("_blank");
  expect(fetch.text).toContain("What does it say? It says hi.");
  // Only a web address is a link.
  expect(card(tool("WebFetch", { url: "javascript:alert(1)" })).body.querySelector("a")).toBeNull();

  const search = card(
    tool(
      "WebSearch",
      { query: "lcs diff" },
      {
        output:
          'Web search results for query: "lcs diff"\n\nLinks: [{"title":"Longest common subsequence","url":"https://en.wikipedia.org/wiki/LCS"}]\n\nA table is enough.',
      },
    ),
  );
  expect(search.header).toBe("Searched the web lcs diff Succeeded");
  expect(search.body.querySelector("a")!.textContent).toBe("Longest common subsequence");
  expect(search.text).toContain("Longest common subsequence en.wikipedia.org A table is enough.");
});

test("an MCP call shows its server as a badge, its arguments as a list, and its result", () => {
  const mcp = card(
    tool(
      "mcp__linear__save_issue",
      { id: "RYA-1", labels: ["app"] },
      { output: '{"id":"RYA-1","state":"Done"}' },
    ),
  );
  expect(mcp.header).toBe("Save issue RYA-1 Linear Succeeded");
  expect([...mcp.body.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["id", "labels"]);
  expect([...mcp.body.querySelectorAll("dd")].map((d) => d.textContent)).toEqual([
    "RYA-1",
    '["app"]',
  ]);
  expect(mcp.body.querySelector("pre")!.textContent).toBe(
    '{\n  "id": "RYA-1",\n  "state": "Done"\n}',
  );
  // A skill's title names it, so its card shows only what it said.
  const skill = card(tool("Skill", { skill: "code-review" }, { output: "Launching skill" }));
  expect(skill.header).toBe("Used skill code-review Succeeded");
  expect(skill.body.querySelector("dl")).toBeNull();
  expect(skill.text).toContain("Launching skill");
});

test("a subagent shows its task, its prompt, and its answer", () => {
  const agent = card(
    tool(
      "Task",
      {
        description: "Review the cards",
        prompt: "Check each card.",
        subagent_type: "general-purpose",
      },
      { output: "All good." },
    ),
  );
  expect(agent.header).toBe("Ran agent Review the cards Succeeded");
  expect(agent.text).toBe("Prompt general-purpose Check each card. Answer All good.");
});

test("a denial and a failure say why, in their own words", () => {
  const denied = card(
    tool(
      "Bash",
      { command: "git push" },
      {
        status: "denied",
        output: "Claude requested permissions to use Bash, but you haven't granted it yet.",
      },
    ),
  );
  expect(denied.header).toBe("Ran git push Denied");
  expect(denied.text).toBe(
    "Shell $ git push Claude requested permissions to use Bash, but you haven't granted it yet.",
  );

  const failed = card(
    tool(
      "Edit",
      { file_path: "/a.ts", old_string: "x", new_string: "y" },
      {
        status: "error",
        output: "<tool_use_error>String to replace not found in file.</tool_use_error>",
      },
    ),
  );
  expect(failed.text).toMatch(/String to replace not found in file\.$/);
  expect(failed.text).not.toContain("tool_use_error");
});

test("long output shows its first lines with Show all, kept by the transcript, and says quietly what wispd cut", () => {
  const output = `${Array.from({ length: 100 }, (_, i) => `out ${i + 1}`).join("\n")}\n... (2048 bytes cut)`;
  const item = tool("Bash", { command: "yes" }, { output });
  const onToggle = vi.fn();
  const timeline = (open: string[]) => (
    <Timeline
      items={[item]}
      live={false}
      active={false}
      openKeys={new Set(open)}
      onToggle={onToggle}
      renderItem={() => null}
    />
  );
  const rerender = render(timeline(["t"]));
  const log = () => words(document.querySelector("li"));
  expect(log()).toContain("out 12");
  expect(log()).not.toContain("out 13");
  expect(log()).toContain("Cut short: 2.0 KB more wasn't sent");
  expect(log()).not.toContain("bytes cut");
  const all = () =>
    [...document.querySelectorAll<HTMLButtonElement>("li button")].find((b) =>
      b.textContent!.startsWith("Show"),
    )!;
  act(() => all().click());
  expect(onToggle).toHaveBeenCalledWith("t:output", true);

  rerender(timeline(["t", "t:output"]));
  expect(log()).toContain("out 100");
  expect(all().textContent).toBe("Show less");
  expect(all().getAttribute("aria-expanded")).toBe("true");
});

test("a duration is short, and absent without both times", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
  expect(duration(at(0), at(40))).toBe("<0.1s");
  expect(duration(at(0), at(400))).toBe("0.4s");
  expect(duration(at(0), at(3600))).toBe("3.6s");
  expect(duration(at(0), at(12_400))).toBe("12s");
  expect(duration(at(0), at(65_000))).toBe("1m 5s");
  expect(duration(at(0), at(3_720_000))).toBe("1h 2m");
  expect(duration(at(0), at(0))).toBeUndefined();
  expect(duration(undefined, at(0))).toBeUndefined();
});
