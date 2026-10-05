import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, servePids, type Launched } from "./launch";

// The built app against a real plxd whose workers are the fake backend playing agent.json
// (PLX-16). See launch.ts for the plxd it needs.

test.describe.configure({ mode: "serial" });

let launched: Launched;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  launched = await launch("agent.json", fakeCodex());
  ({ app, page } = launched);
});

/**
 * A fake Codex, for the sign-in test: signed out until `codex login` has read a line. And a fake
 * Claude Code, signed out, so a host with neither installed still lists both (0040). Returns their
 * folder, which goes first on PATH, so plxd finds them before any real ones.
 */
function fakeCodex(): string {
  const bin = mkdtempSync(path.join(tmpdir(), "parallax-e2e-bin-"));
  const marker = path.join(bin, "signed-in");
  if (process.platform === "win32") {
    const script = [
      "@echo off",
      `if "%~1 %~2"=="login status" if exist "${marker}" (exit 0) else (exit 1)`,
      `if "%~1"=="login" (echo Fake Codex sign-in. Press Enter.& set /p line=& type nul > "${marker}"& exit 0)`,
      "exit 2",
    ];
    writeFileSync(path.join(bin, "codex.cmd"), script.join("\r\n"));
    writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\nexit 1\r\n");
  } else {
    const script = [
      "#!/bin/sh",
      'case "$*" in',
      `  "login status") test -f '${marker}' ;;`,
      `  login) echo "Fake Codex sign-in. Press Enter."; read -r _; touch '${marker}' ;;`,
      "  *) exit 2 ;;",
      "esac",
    ];
    writeFileSync(path.join(bin, "codex"), script.join("\n"), { mode: 0o755 });
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  return bin;
}

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status !== expectedStatus) await printFailure(launched);
});

test.afterAll(() => close(launched));

test("connects to plxd", async () => {
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
});

test("starts a thread and shows the agent's output", async () => {
  // A fresh host has no default account for threads, and the fake's is `fake`. The app only
  // offers signed-in vendor CLIs, which plxd finds by running them, so set it directly.
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  // New Thread reads the default when it opens, to offer that backend's models, so reopen it.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back to app" }).click();

  await page.getByRole("textbox", { name: "Message" }).fill("Tidy up the README");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Tidy up the README")).toBeVisible();
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
});

test("stops the thread", async () => {
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("log", { name: "Transcript" }).getByText("Stopped")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
});

test("a top bar menu closes on a click outside it (PLX-363)", async () => {
  await page.getByRole("button", { name: "Open in…" }).click();
  const menu = page.getByRole("menu", { name: "Open in" });
  await expect(menu).toBeVisible();
  // A menu that inherits the top bar's drag turns the window's clicks outside it into drags,
  // which never reach the page. Playwright's clicks skip the window, so check the style itself.
  const region = await menu.evaluate(
    `(m) => getComputedStyle(m).getPropertyValue("-webkit-app-region")`,
  );
  expect(region).not.toBe("drag");
  await page.getByRole("log", { name: "Transcript" }).click();
  await expect(menu).toBeHidden();
});

test("opens a terminal in the thread's folder, kept while hidden (PLX-295)", async () => {
  const listed = (await page.evaluate(`window.parallax.request("local", "agent/list", {})`)) as {
    result: { runs: { prompt: string; branch?: string }[] };
  };
  const branch = listed.result.runs.find((r) => r.prompt === "Tidy up the README")!.branch!;
  await page.getByRole("button", { name: "Show terminal" }).click();
  const terminal = page.getByRole("group", { name: "Terminal", exact: true });
  await terminal.click();
  // The worktree's branch, from git, which runs the same in every shell.
  await page.keyboard.type("git branch --show-current\r");
  await expect(terminal).toContainText(branch);

  // Mod+J hides it from inside the terminal, and shows it again with the same session.
  await page.keyboard.press("ControlOrMeta+j");
  await expect(terminal).toBeHidden();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(terminal).toContainText(branch);
  await terminal.click();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(terminal).toBeHidden();
});

// Runs the Edit menu's Copy or Paste as its Cmd/Ctrl+C or V does, which a synthetic keypress can't.
const edit = (command: "copy" | "paste") =>
  app.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getAllWindows()[0]!.webContents[command]();
  }, command);

test("copies the agent's reply into the composer, and right-click offers Copy and Paste (PLX-184)", async () => {
  // Context menus are recorded instead of shown, since a shown one holds the main process.
  await app.evaluate(({ Menu }) => {
    const shown: string[][] = [];
    Object.assign(globalThis, { shown });
    Menu.prototype.popup = function (this: Electron.Menu) {
      shown.push(this.items.map((item) => item.role ?? ""));
    };
  });
  // Selected with the mouse, as a person would.
  const reply = page.getByRole("log", { name: "Transcript" }).getByText("The fake agent is on it.");
  const at = (await reply.boundingBox())!;
  await page.mouse.move(at.x + 1, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width - 1, at.y + at.height / 2, { steps: 4 });
  await page.mouse.up();
  await reply.click({ button: "right" });
  await edit("copy");

  const message = page.getByRole("textbox", { name: "Message" });
  await message.click({ button: "right" });
  await edit("paste");
  await expect(message).toHaveText("The fake agent is on it.");
  const shown = await app.evaluate(() => (globalThis as { shown?: string[][] }).shown);
  expect(shown).toEqual([["copy"], ["cut", "copy", "paste", "selectall"]]);
  await message.press("ControlOrMeta+a");
  await message.press("Backspace");
});

test("the composer grows upward as it fills, up to 40% of the window (PLX-184)", async () => {
  const message = page.getByRole("textbox", { name: "Message" });
  const before = (await message.boundingBox())!;
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), lines.join("\n"));
  await message.click();
  await edit("paste");
  await expect(message).toContainText("line 40");

  const after = (await message.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height);
  expect(Math.round(after.y + after.height)).toBe(Math.round(before.y + before.height));
  expect(after.height).toBeLessThanOrEqual((await page.evaluate<number>("innerHeight")) * 0.4 + 1);
  await message.press("ControlOrMeta+a");
  await message.press("Backspace");
});

test("a follow-up's text is still there after a reload (PLX-92)", async () => {
  await page.getByRole("textbox", { name: "Message" }).fill("Check the links too");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // The resumed fake answers again, after plxd logged the follow-up's turnStarted.
  const said = page.getByRole("log", { name: "Transcript" }).getByText("The fake agent is on it.");
  await expect(said).toHaveCount(2);

  await page.reload();
  await page.getByRole("button", { name: /Tidy up the README/ }).click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Check the links too")).toBeVisible();
  await expect(transcript.getByText("Follow-up message")).toHaveCount(0);
});

test("a pasted image sits in the composer, goes with the message, and outlives a reload (PLX-193)", async () => {
  // Wider than the 2000 px an image is sent at, so the composer redraws it smaller.
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const [width, height] = [2400, 12];
    const pixels = Buffer.alloc(width * height * 4, 0x80);
    const png = nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([png]) })]);
  });
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await edit("paste");
  const thumbnail = page.getByRole("img", { name: "Image 1" });
  await expect(thumbnail).toBeVisible();
  await expect(message).toHaveText("");
  // e2e/ has no DOM types.
  const width = (img: unknown) => (img as { naturalWidth: number }).naturalWidth;
  expect(await thumbnail.evaluate(width)).toBe(2000);

  // The image alone: the thread was left running with its turn done, so the fake takes it as a
  // follow-up at once rather than queueing it for the turn's end (PLX-370).
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thumbnail).toHaveCount(0);
  const transcript = page.getByRole("log", { name: "Transcript" });
  const sent = transcript.getByRole("img", { name: "Image", exact: true });
  await expect(sent).toBeVisible();

  // Rebuilt from the log, the image comes from plxd.
  await page.reload();
  await page.getByRole("button", { name: /Tidy up the README/ }).click();
  await expect(sent).toBeVisible();
  expect(await sent.evaluate(width)).toBe(2000);
});

test("the usage period picker shows its choice on each provider (PLX-284)", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();
  // Every provider's pane stays mounted, so a radio group shared across them would leave only the
  // last pane's checked.
  for (const name of ["Claude Code", "Codex"]) {
    await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("radio", { name: "Today" })).toBeChecked();
    await panel.getByText("This week", { exact: true }).click();
    await expect(panel.getByRole("radio", { name: "This week" })).toBeChecked();
    await panel.getByText("Today", { exact: true }).click();
  }
  await page.getByRole("button", { name: "Back to app" }).click();
});

test("changing a setting never scrolls the window itself (PLX-441)", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Appearance" }).click();
  // Focusing an option's hidden radio once scrolled the whole window up, for good.
  for (const option of ["More", "Standard", "Blue & orange", "Red & green"])
    await page.getByText(option, { exact: true }).click();
  const scroll = await page.evaluate(`(({ scrollTop, scrollHeight, clientHeight }) =>
    ({ scrollTop, overflow: scrollHeight - clientHeight }))(document.documentElement)`);
  expect(scroll).toEqual({ scrollTop: 0, overflow: 0 });
  await page.getByRole("button", { name: "Back to app" }).click();
});

test("signs in to a CLI in a host terminal, then shows it signed in (PLX-35)", async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();
  const codex = page.getByRole("tab", { name: /^Codex/ });
  await codex.click();
  await expect(codex).toHaveText("CodexNot authenticated");
  await page.getByRole("button", { name: "Sign in to Codex" }).click();

  const terminal = page.getByRole("group", { name: "Codex sign-in terminal" });
  await expect(terminal).toContainText("Fake Codex sign-in. Press Enter.");
  await terminal.click();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Codex sign-in ended.")).toBeVisible();
  // The sign-in's end ran accounts/refresh, which found the fake signed in.
  await expect(codex).toHaveText("CodexAuthenticated");
});

test("creates a project on a repository it adds, and opens it (PLX-166)", async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "ember");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  // A coordinator runs on a copy of the latest commit, so the repository needs one (0024).
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "--allow-empty", "-m", "Start"]);
  // The native folder picker can't be driven, so it answers with the repository.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, repo);

  // The sign-in test left Settings open.
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByRole("button", { name: "New project or repository" }).click();
  await page.getByRole("menuitem", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog", { name: "Create Project" });
  await dialog.getByRole("button", { name: /^Workspace/ }).click();
  await page.getByRole("menuitem", { name: "Choose folder…" }).click();
  await expect(dialog.getByRole("button", { name: /^Workspace: ember on / })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("ember");
  await dialog.getByRole("button", { name: "Create Project" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("ember");
  // One row for the Project, in the sidebar's one list (0033).
  await expect(page.locator('#sidebar li[data-kind="project"] [data-title]')).toHaveText(["ember"]);
});

test("chats with the project's coordinator, whose transcript outlives a reload and a plxd restart (PLX-46)", async () => {
  // Reconnecting after the restart waits out the app's backoff.
  test.slow();
  // As for threads: the fake runs coordinators once it's their default.
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "coordinator",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  // The project chat reads the default when it opens, to offer its backend's models, so reopen it.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back to app" }).click();

  // The last test left the ember project open. A message that isn't a question starts a task, so
  // the route chip sends this one to the coordinator instead (0042).
  const message = page.getByRole("textbox", { name: "Message" });
  const toCoordinator = async (text: string) => {
    await message.fill(text);
    await page.getByRole("button", { name: "Sends to: New thread. Switch" }).click();
    await expect(page.getByRole("button", { name: "Sends to: Chat. Switch" })).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };
  await toCoordinator("Plan the ember release");
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Plan the ember release")).toBeVisible();
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(transcript.getByText("Stopped")).toBeVisible();
  await toCoordinator("Start with the changelog");
  await expect(transcript.getByText("The fake agent is on it.")).toHaveCount(2);

  await page.reload();
  await page.locator('#sidebar li[data-kind="project"] > button').first().click();
  await expect(transcript.getByText("Start with the changelog")).toBeVisible();

  // Stop plxd with the coordinator running. The app reconnects through a new `serve`, which
  // marks the run interrupted, and the transcript loads again.
  const [pid] = servePids(launched.dataDir);
  expect(pid).toBeGreaterThan(1);
  process.kill(pid!, "SIGTERM");
  await expect(transcript.getByText(/^Interrupted when plxd stopped/)).toBeVisible({
    timeout: 45_000,
  });
  expect(servePids(launched.dataDir).length).toBeGreaterThan(1);
  await expect(transcript.getByText("Plan the ember release")).toBeVisible();
  await expect(transcript.getByText("Start with the changelog")).toBeVisible();
});

test("starts the project's tasks from its composer, shows them over it and on its Project tab, opens their chats, and marks the coordinator's wake-up (PLX-47)", async () => {
  // The last test left ember's coordinator open, interrupted by the restart, with its side panel
  // on the Project tab.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(panel.getByRole("button", { name: /^Project/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(panel).toContainText("Nothing is waiting on you.");

  // A task starts a child, on the worker default the thread test set.
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Write the changelog");
  await expect(page.getByRole("button", { name: "Sends to: New thread. Switch" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const bar = page.getByRole("region", { name: "Agents" });
  await expect(bar).toContainText("Write the changelog");
  await expect(bar).toContainText("1 working");
  const working = panel.getByRole("region", { name: "Working" });
  await expect(working.getByRole("button", { name: /^Write the changelog/ })).toBeVisible();

  // One the coordinator started, as `plxd mcp`'s spawn_agent does (0019): it arrives by event.
  const listed = (await page.evaluate(`window.parallax.request("local", "project/list", {})`)) as {
    result: { projects: { id: string; coordinator: string }[] };
  };
  const ember = listed.result.projects[0]!;
  const params = {
    runId: uuidv7(),
    project: ember.id,
    prompt: "Tag the release",
    policy: "workspaceWrite",
    coordinatorThread: ember.coordinator,
  };
  const started = await page.evaluate(
    `window.parallax.request("local", "agent/start", ${JSON.stringify(params)})`,
  );
  expect(started).not.toHaveProperty("error");
  const tag = working.getByRole("button", { name: /^Tag the release/ });
  await expect(tag).toBeVisible();
  await expect(bar).toContainText("2 working");

  // Its chat, with the project still open. Stopping it wakes the coordinator (0025).
  await tag.click();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs).toContainText("Tag the release");
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(transcript.getByText("Stopped")).toBeVisible();
  await expect(tag).toBeHidden();

  // The child's strip goes back to the coordinator.
  await page
    .getByRole("region", { name: "Child thread" })
    .getByRole("button", { name: /^Open parent/ })
    .click();
  await expect(crumbs).not.toContainText("Tag the release");
  await expect(bar).toContainText("1 working");
  await expect(transcript.getByText("Plan the ember release")).toBeVisible();
  // Two wake-ups: one for the task started from the composer (0043), and one for the stop.
  await expect(transcript.getByText("From Parallax: subagents finished").first()).toBeVisible();
});

test("renames the project and picks its icon from its row, and both outlive a reload (PLX-230)", async () => {
  // The last test left ember open. Its row's actions show on hover.
  const projects = page.locator('#sidebar li[data-kind="project"]');
  await projects.hover();
  await projects.getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const name = projects.getByRole("textbox", { name: "Project name" });
  await expect(name).toBeFocused();
  await name.fill("ember app");
  await name.press("Enter");
  const row = projects.locator(":scope > button").first();
  await expect(row.locator("[data-title]")).toHaveText("ember app");
  await expect(row).toBeFocused();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("ember app");

  // Right-clicking the row opens the same menu. A color, then an icon by keyboard.
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Change icon" }).click();
  const picker = page.getByRole("dialog", { name: "Project icon" });
  const search = picker.getByRole("searchbox", { name: "Search icons" });
  await expect(search).toBeFocused();
  await picker.getByTitle("Green").click();
  await expect(picker.getByRole("radio", { name: "Green" })).toBeChecked();
  await search.fill("rocket");
  await search.press("ArrowDown");
  const rocket = picker.getByRole("option", { name: "Rocket" });
  await expect(rocket).toBeFocused();
  await rocket.press("Enter");
  await expect(rocket).toHaveAttribute("aria-selected", "true");
  await rocket.press("Escape");
  await expect(picker).toBeHidden();
  const icon = row.locator("[data-project-icon] svg");
  await expect(icon).toHaveAttribute("class", /lucide-rocket .*text-project-green/);

  // The name and icon are the host's (0032).
  await page.reload();
  await expect(icon).toHaveAttribute("class", /lucide-rocket .*text-project-green/);
  const listed = (await page.evaluate(`window.parallax.request("local", "project/list", {})`)) as {
    result: { projects: { name: string; icon?: { name: string; color?: string } }[] };
  };
  expect(listed.result.projects).toMatchObject([
    { name: "ember app", icon: { name: "rocket", color: "green" } },
  ]);
});

test("starts a thread in the repository's current checkout, on its branch, with no worktree", async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "quill");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--initial-branch=my-feature", repo]);
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "--allow-empty", "-m", "Start"]);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const params = { id: uuidv7(), path: repo };
  const added = (await page.evaluate(
    `window.parallax.request("local", "repo/add", ${JSON.stringify(params)})`,
  )) as { result: { repo: { id: string } } };
  expect(added).not.toHaveProperty("error");

  // New thread, then quill from the heading's repository menu.
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await page.getByRole("heading", { level: 1 }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: "quill" }).click();
  // The heading's accessible name spaces out the repository button inside it, so match its text.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "What should we build in quill?",
  );
  await page.getByRole("button", { name: /^Runs on: .*, New worktree$/ }).click();
  await page.getByRole("menuitemradio", { name: /^Local checkout/ }).click();
  await expect(page.getByRole("button", { name: /^Runs on: .*, Local checkout$/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("current-checkout-picked.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("textbox", { name: "Message" }).fill("Tidy up the docs");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();
  await expect(page.getByText(/·Local checkout/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("current-checkout-thread.png") });

  const listed = (await page.evaluate(
    `window.parallax.request("local", "agent/list", { project: "${added.result.repo.id}" })`,
  )) as { result: { runs: { checkout?: boolean; branch?: string; worktreePath?: string }[] } };
  expect(listed.result.runs).toHaveLength(1);
  expect(listed.result.runs[0]).toMatchObject({ checkout: true });
  expect(listed.result.runs[0]).not.toHaveProperty("worktreePath");
  expect(listed.result.runs[0]).not.toHaveProperty("branch");
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  expect(git("branch", "--show-current")).toBe("my-feature");

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(transcript.getByText("Stopped")).toBeVisible();
});

test("saves a repository action and runs it in the drawer, opening its preview (PLX-299)", async () => {
  const server = createServer((_req, res) => res.end("<h1>Preview works</h1>"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const preview = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // Actions belong to a repository: the open thread is quill's, from the test above.
  await page.getByRole("button", { name: "Add action" }).click();
  const dialog = page.getByRole("dialog", { name: "Add action" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Git version");
  const keys = dialog.getByRole("textbox", { name: "Keybinding" });
  await keys.press("ControlOrMeta+s");
  await expect(dialog.getByRole("alert")).toContainText("one of Parallax's shortcuts");
  await keys.press("ControlOrMeta+Shift+k");
  await dialog.getByRole("textbox", { name: "Command" }).fill("git --version");
  await dialog.getByRole("textbox", { name: "Preview URL (optional)" }).fill(preview);
  await dialog.getByRole("checkbox", { name: "Open preview when this action runs" }).check();
  await page.screenshot({ path: test.info().outputPath("action-dialog.png") });
  await dialog.getByRole("button", { name: "Save action" }).click();
  await page.screenshot({ path: test.info().outputPath("action-top-bar.png") });

  // The drawer opens and runs it, and the side panel's Browser shows the preview.
  await page.getByRole("button", { name: "Git version" }).click();
  const terminal = page.getByRole("group", { name: "Terminal", exact: true });
  await expect(terminal).toContainText("git version ");
  await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue(preview);
  await page.screenshot({ path: test.info().outputPath("action-running.png") });

  // Its keybinding runs it again.
  await page.getByRole("log", { name: "Transcript" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+k");
  await expect(terminal).toContainText(/git version [\s\S]*git version /);
  server.close();
});

test("attaches another thread with @, sends it with the message, and opens it from the sent chip (PLX-378)", async () => {
  // The open thread is quill's, from the checkout test. "Tidy up the README" is the first thread.
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await page.keyboard.type("Do what @README");
  const readme = page
    .getByRole("listbox", { name: "Threads and files" })
    .getByRole("option", { name: /Tidy up the README/ });
  await expect(readme).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("thread-picker.png") });
  await readme.click();

  const chip = page.locator("form [data-thread-chip]");
  await expect(chip).toHaveText(/Tidy up the README/);
  await page.keyboard.type("that thread did here");
  await page.screenshot({ path: test.info().outputPath("thread-chip.png") });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(chip).toHaveCount(0);

  // The sent message keeps its chip once plxd's turnStarted lists the thread, after a reload too.
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Do what that thread did here")).toBeVisible();
  await expect(transcript.getByText("The fake agent is on it.")).toHaveCount(2);
  await page.reload();
  // At its left edge: a short row's hover actions cover its middle.
  await page.getByRole("button", { name: /Tidy up the docs/ }).click({ position: { x: 8, y: 8 } });
  const sent = transcript.getByRole("button", { name: /Tidy up the README/ });
  await expect(sent).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("thread-sent.png") });
  await sent.click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
    "Tidy up the README",
  );
});

test("switches between a thread and the one it launched, by chip, crumb, and shortcut (PLX-374)", async () => {
  // A parent and the child it launched, as an agent would with thread_launch (0041).
  const start = async (title: string, parent?: string) => {
    const params = { runId: uuidv7(), prompt: title, title, ...(parent && { parent }) };
    const answer = await page.evaluate(
      `window.parallax.request("local", "thread/start", ${JSON.stringify(params)})`,
    );
    expect(answer).not.toHaveProperty("error");
    return params.runId;
  };
  // The chips get the top bar's room with the side panel closed; the end checks it open.
  const hidePanel = page.getByRole("button", { name: "Hide side panel" });
  if (await hidePanel.isVisible()) await hidePanel.click();
  const parent = await start("Plan the release");
  await start("Write the changelog", parent);

  // The child nests under its parent, collapsed.
  await page
    .locator("#sidebar li[data-kind='thread'] > button")
    .filter({ hasText: "Plan the release" })
    .click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  const group = sidebar.getByRole("button", { name: /^1 thread/ });
  await expect(group).toHaveAttribute("aria-expanded", "false");
  const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
  const current = breadcrumb.locator('ol > li > [aria-current="page"]');
  await expect(current).toHaveText("Plan the release");

  // Its chip opens the child, whose parent crumb goes back.
  const chips = breadcrumb.getByRole("group", { name: "Child threads" });
  await chips.getByRole("button", { name: "Write the changelog" }).click();
  const siblings = breadcrumb.getByRole("group", { name: "Sibling threads" });
  await expect(siblings.getByRole("button", { name: "Write the changelog" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await breadcrumb.getByRole("button", { name: "Plan the release" }).click();
  await expect(current).toHaveText("Plan the release");

  // Mod+Alt+Right opens the first child, and Mod+Alt+Up its parent.
  await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
  await expect(siblings).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(current).toHaveText("Plan the release");

  // At the default window size with the side panel open, the trail shrinks to +N, which still
  // takes a click (Playwright fails it when the top bar's buttons cover it) and opens the tree.
  // A screen smaller than the window, as on some CI runners, leaves no room to check.
  await page.getByRole("button", { name: "Show side panel" }).click();
  const width = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(1200, 800);
    return window.getSize()[0];
  });
  if (width === 1200) {
    await chips.getByRole("button", { name: "1 more threads" }).click();
    const tree = page.getByRole("dialog", { name: "Thread tree" });
    await tree.getByRole("button", { name: /Write the changelog/ }).click();
    await expect(siblings).toBeVisible();
  }
});
