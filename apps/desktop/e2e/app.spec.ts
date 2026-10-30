import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, openThread, printFailure, servePids, type Launched } from "./launch";

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
  const cli = path.join(bin, "codex.cjs");
  writeFileSync(
    cli,
    `const { existsSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const marker = ${JSON.stringify(marker)};
const [command, action] = process.argv.slice(2);
if (command === "login" && action === "status") process.exit(existsSync(marker) ? 0 : 1);
if (command === "login") {
  console.log("Fake Codex sign-in. Press Enter.");
  createInterface({ input: process.stdin }).once("line", () => {
    writeFileSync(marker, "");
    process.exit(0);
  });
} else if (command === "app-server") {
  createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: {} }));
    if (request.method === "account/read") {
      const account = existsSync(marker)
        ? { type: "chatgpt", email: "e2e@example.test", planType: "plus" }
        : null;
      console.log(JSON.stringify({ id: request.id, result: { account } }));
    }
  });
} else process.exit(2);
`,
  );
  if (process.platform === "win32") {
    writeFileSync(
      path.join(bin, "codex.cmd"),
      `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`,
    );
    writeFileSync(path.join(bin, "claude.cmd"), "@echo off\r\nexit 1\r\n");
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      path.join(bin, "codex"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  return bin;
}

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status !== expectedStatus) await printFailure(launched);
});

test.afterAll(() => close(launched));

test("starts a thread and shows the agent's output", async () => {
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  // A fresh host has no default account for threads, and the fake's is `fake`. The app only
  // offers signed-in vendor CLIs, which plxd finds by running them, so set it directly.
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  // New Thread reads the default again as Settings closes, and keeps what was typed behind it.
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Tidy up the README");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(message).toHaveText("Tidy up the README");
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

// Runs the Edit menu's Paste as its Cmd/Ctrl+V does, which a synthetic keypress can't.
const paste = () =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.paste();
  });

test("a pasted image sits in the composer, goes with the message, and outlives a reload (PLX-193)", async () => {
  // Wider than the 2000 px an image is sent at, so the composer redraws it smaller.
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const [width, height] = [2400, 12];
    const pixels = Buffer.alloc(width * height * 4, 0x80);
    const png = nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)]) })]);
  });
  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await paste();
  const thumbnail = page.getByRole("img", { name: "Image 1" });
  await expect(thumbnail).toBeVisible();
  // It also takes its place in the text, where it was pasted, with its size.
  await expect(message).toHaveText(/^Image 1\d+(?: bytes| KB)\s*$/);
  // e2e/ has no DOM types.
  const width = (img: unknown) => (img as { naturalWidth: number }).naturalWidth;
  expect(await thumbnail.evaluate(width)).toBe(2000);

  // The image alone, sent with the thread stopped, so it starts a turn at once rather than
  // waiting for a turn's end (PLX-370).
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thumbnail).toHaveCount(0);
  const transcript = page.getByRole("log", { name: "Transcript" });
  const sent = transcript.getByRole("img", { name: "Image", exact: true });
  await expect(sent).toBeVisible();

  // Rebuilt from the log, the image comes from plxd.
  await page.reload();
  await openThread(page, /Tidy up the README/);
  await expect(sent).toBeVisible();
  expect(await sent.evaluate(width)).toBe(2000);
});

test("signs in to a CLI in a host terminal, then shows it signed in (PLX-35)", async () => {
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();
  const codex = page.getByRole("tab", { name: /^(Codex|Email hidden)/ });
  await codex.click();
  await expect(codex).toHaveText("CodexNot authenticated");
  await page.getByRole("button", { name: "Sign in to Codex" }).click();

  const terminal = page.getByRole("group", { name: "Codex sign-in terminal" });
  await expect(terminal).toContainText("Fake Codex sign-in. Press Enter.");
  await terminal.click();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Codex sign-in ended.")).toBeVisible();
  // The sign-in's end ran accounts/refresh, which found the fake signed in. Its email is blurred.
  await expect(codex).toHaveText(/Email hidden, hover or focus to showAuthenticated$/);
  await expect(codex).not.toContainText("e2e@example.test");
});

test("Escape closes a dialog opened in Settings, and leaves Settings open (PLX-1050)", async () => {
  // The sign-in test left Settings open on Providers.
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Add provider" }).click();
  const add = page.getByRole("dialog", { name: "Add provider" });
  await expect(add).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(add).toBeHidden();
  await expect(settings).toBeVisible();
});

test("choosing a window background leaves Settings in view (PLX-1078)", async () => {
  // Settings is still open. The radio sits below the dialog's fold, positioned against the dialog.
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Appearance" }).click();
  await settings.getByRole("radio", { name: "Opaque" }).focus();
  expect(await settings.evaluate((dialog) => dialog.scrollTop)).toBe(0);
});

test("creates a project on a repository it adds, and opens it (PLX-166)", async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "ember");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  // A coordinator runs on a copy of the latest commit, so the repository needs one (0024).
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "--allow-empty", "-m", "Start"]);
  // The sign-in test left Settings open.
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "New project or repository" }).click();
  const dialog = page.getByRole("dialog", { name: "New project or Space" });
  await dialog.getByRole("option", { name: /^New Project/ }).click();
  await dialog.getByRole("button", { name: /^Workspace/ }).click();
  await page.getByRole("menuitem", { name: "Choose folder…" }).click();
  // The palette's folder step, opened on the repository itself, adds it.
  await dialog.getByRole("combobox", { name: "Folder" }).fill(repo + path.sep);
  await dialog.getByRole("button", { name: /^Add/ }).click();
  await expect(dialog.getByRole("button", { name: /^Workspace: ember on / })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("ember");
  await dialog.getByRole("button", { name: "Create Project" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("ember");
  // One card for the Project, on the Projects page, which the classic sidebar opens from the
  // button beside its search (0091). Opening the card goes back to the Project.
  await page.locator("#sidebar").getByRole("button", { name: "Projects", exact: true }).click();
  const cards = page.locator("li[data-project]");
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("ember");
  await cards.getByRole("button").first().click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("ember");
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
  // The project chat reads the default again as Settings closes, to offer its backend's models.
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  // The last test left the ember project open. Every message goes to its coordinator.
  const message = page.getByRole("textbox", { name: "Message" });
  const toCoordinator = async (text: string) => {
    await message.fill(text);
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
  // Back to the Project from the Projects page.
  await page.locator("#sidebar").getByRole("button", { name: "Projects", exact: true }).click();
  await page.locator("li[data-project]").first().getByRole("button").first().click();
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

test("shows the project's tasks over its composer and on its Project tab, opens their chats, and marks the coordinator's wake-up (PLX-47)", async () => {
  // The last test left ember's coordinator open, interrupted by the restart, with its side panel
  // on the Project tab.
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(panel.getByRole("button", { name: /^Project/ })).toHaveAttribute(
    "aria-current",
    "true",
  );

  const listed = (await page.evaluate(`window.parallax.request("local", "project/list", {})`)) as {
    result: { projects: { id: string; coordinator: string }[] };
  };
  const ember = listed.result.projects[0]!;
  // A task the Project starts, on the worker default the thread test set (0042).
  const task = await page.evaluate(
    `window.parallax.request("local", "thread/start", ${JSON.stringify({
      runId: uuidv7(),
      project: ember.id,
      prompt: "Write the changelog",
    })})`,
  );
  expect(task).not.toHaveProperty("error");
  const bar = page.getByRole("region", { name: "Agents" });
  await expect(bar).toContainText("Write the changelog");
  await expect(bar).toContainText("1 working");
  const working = panel.getByRole("region", { name: "Running" });
  await expect(working.getByRole("button", { name: /^Write the changelog/ })).toBeVisible();

  // One the coordinator started, as `plxd mcp`'s spawn_agent does (0019): it arrives by event.
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
  // Two wake-ups: one for the task's start (0043), and one for the stop.
  await expect(transcript.getByText("From Parallax: subagents finished").first()).toBeVisible();
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

  // New thread opens the repository picker; pick quill.
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New thread in" })
    .getByRole("option", { name: /^quill/ })
    .click();
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
