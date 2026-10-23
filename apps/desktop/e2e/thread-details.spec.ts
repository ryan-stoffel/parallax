import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import type { ParallaxBridge } from "../src/preload/bridge";
import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure } from "./launch";

declare const window: {
  parallax: ParallaxBridge;
};

test("checkout counts before starting and concise errors after a worktree is removed", async () => {
  const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), "plx722-")));
  const repo = path.join(fixture, "fixture-repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-b", "main");
  // Checkout and hardened worktree Git must agree without the runner's global config.
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(repo, "README.md"), "original\n");
  git("add", ".");
  git("commit", "-m", "Initial");
  writeFileSync(path.join(repo, "README.md"), "replacement\nsecond\n");
  writeFileSync(path.join(repo, "notes.txt"), "one\ntwo");
  // Discovery cannot reach the user's provider CLIs or sign-in state.
  const bin = path.join(fixture, "bin");
  mkdirSync(bin);
  for (const cli of ["claude", "codex", "cursor", "cursor-agent", "agent", "gh"])
    writeFileSync(path.join(bin, cli), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  let launched = await launch("fork.json", bin);
  let { page } = launched;
  try {
    await expect
      .poll(() =>
        page.evaluate(() => window.parallax.connectionState("local").then((s) => s.status)),
      )
      .toBe("connected");
    const repoId = uuidv7();
    const answer = await page.evaluate(
      async ({ repoId, repo }) => {
        const added = await window.parallax.request("local", "repo/add", {
          id: repoId,
          path: repo,
        });
        await window.parallax.request("local", "accounts/defaults/set", {
          role: "worker",
          account: { kind: "subscription", backend: "fake" },
        });
        localStorage.setItem("parallax.theme", "dark");
        localStorage.setItem("parallax.openTarget", "vscode");
        return added;
      },
      { repoId, repo },
    );
    expect(answer).not.toHaveProperty("error");
    if ("error" in answer) throw new Error(answer.error.message);
    const registeredPath = answer.result.repo.path;
    await page.reload();
    await page.getByRole("button", { name: "New thread", exact: true }).click();
    await page
      .getByRole("dialog", { name: "New thread in" })
      .getByRole("option", { name: /^fixture-repo/ })
      .click();
    await page.getByRole("button", { name: "Thread details", exact: true }).click();
    let details = page.getByRole("complementary", { name: "Thread details", exact: true });
    await expect(details).toContainText("+4 −1");
    await expect(details.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
    await expect(details.locator('[aria-label="Workspace"] > div[title]')).toHaveAttribute(
      "title",
      registeredPath,
    );
    expect(await details.locator('[aria-label="Workspace"] > div[title] svg').count()).toBe(2);
    // Supply the normal Connect metadata event without enabling a real account or discovery.
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send("parallax:connect", {
        on: true,
        icon: "mini",
        channel: "nightly",
      });
    });
    const deviceIcon = details.locator('[aria-label="Workspace"] > div[title] > span svg');
    // Mini's own path, since the laptop icon shows until the event lands, and its two paths would
    // fail a plain `path` locator at once instead of waiting (PLX-919).
    await expect(deviceIcon.locator('path[d="M6 13h.01"]')).toHaveCount(1);
    await expect(deviceIcon.locator("rect")).toHaveAttribute("height", "10");
    expect(await details.innerText()).not.toContain(registeredPath);
    await details
      .locator(":scope > div")
      .screenshot({ path: path.join(fixture, "new-checkout.png") });
    git("checkout", "--", "README.md");
    rmSync(path.join(repo, "notes.txt"));
    await page.getByRole("textbox", { name: "Message" }).fill("Check the isolated checkout");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("log", { name: "Transcript" })).toContainText(
      "The fake agent answered.",
    );
    const run = await page.evaluate(async () => {
      const answer = await window.parallax.request("local", "agent/list", {});
      if ("error" in answer) throw new Error(answer.error.message);
      return answer.result.runs[0]!;
    });
    expect(run.worktreePath).toBeTruthy();
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const answer = await window.parallax.request("local", "agent/list", {});
          if ("error" in answer) throw new Error(answer.error.message);
          return answer.result.runs.find((r) => r.id === id)?.status;
        }, run.id),
      )
      .toBe("completed");
    // Answer text precedes process exit and checkpoint Git work. Release their Windows cwd handles.
    await close(launched);
    rmSync(run.worktreePath!, { recursive: true, maxRetries: 5 });
    expect(existsSync(run.worktreePath!)).toBe(false);
    launched = await launch("fork.json", bin, undefined, launched.dataDir);
    ({ page } = launched);
    await page.getByText("Check the isolated checkout", { exact: true }).first().click();
    await page.getByRole("button", { name: "Thread details", exact: true }).click();
    details = page.getByRole("complementary", { name: "Thread details", exact: true });
    await expect(details.getByRole("alert")).toHaveText("Worktree no longer exists");
    expect(await details.getByRole("alert").getAttribute("title")).toContain(run.worktreePath);
    expect(await details.innerText()).not.toContain(run.worktreePath!);
    await details
      .locator(":scope > div")
      .screenshot({ path: path.join(fixture, "missing-worktree.png") });
    console.log(`PLX-722 screenshots: ${fixture}`);
  } catch (error) {
    await printFailure(launched);
    throw error;
  } finally {
    await close(launched);
  }
});
