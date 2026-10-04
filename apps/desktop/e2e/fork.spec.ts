import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("fork.json");
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// Each turn of the fake answers and exits, so every turn has ended and can fork (0050).
test("forks a thread from a message and from its menu, and the fork links back (PLX-381)", async () => {
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  // In a repository, so each fork gets a worktree. ponytail: a fork of a No Repo thread fails on
  // Windows (PLX-471), so this covers the app's side where every OS can fork.
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "quill");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "--allow-empty", "-m", "Start"]);
  const added = await page.evaluate(
    `window.parallax.request("local", "repo/add", ${JSON.stringify({ id: uuidv7(), path: repo })})`,
  );
  expect(added).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByRole("heading", { level: 1 }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: "quill" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "What should we build in quill?",
  );
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  const transcript = page.getByRole("log", { name: "Transcript" });
  const answers = transcript.getByText("The fake agent answered.", { exact: true });
  await box.fill("Plan the README");
  await box.press("Enter");
  await expect(answers).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await box.fill("Write the README");
  await box.press("Enter");
  await expect(answers).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  // Fork from the first message, keeping the model.
  const first = transcript.locator(".group\\/prompt", { hasText: "Plan the README" });
  await first.hover();
  await expect(first.getByRole("button", { name: "Copy message" })).toBeVisible();
  const fork = first.getByRole("button", { name: "Fork from here" });
  await expect(fork).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("fork-hover-row.png") });
  await fork.click();
  const menu = page.getByRole("menu", { name: "Fork" });
  await expect(menu).toBeVisible();
  const keep = menu.getByRole("menuitem").first();
  await expect(keep).toHaveText(/^Keep /);
  await page.screenshot({ path: test.info().outputPath("fork-menu.png") });
  await keep.click();

  // The fork opens with the first turn copied and muted, and its crumb names the original.
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  const original = crumbs.getByRole("button", { name: "Forked from Plan the README" });
  await expect(original).toBeVisible();
  await expect(transcript.getByText("Write the README", { exact: true })).toHaveCount(0);
  const copied = transcript.locator("[data-copied]");
  await expect(copied.first()).toContainText("Plan the README");
  await expect(copied).toHaveCount(2);
  await expect(transcript.getByRole("button", { name: "Fork from here" })).toHaveCount(0);

  // Its own turn isn't muted.
  await box.fill("Write a shorter README");
  await box.press("Enter");
  await expect(answers).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(copied).toHaveCount(2);
  await expect(transcript.getByRole("button", { name: "Fork from here" })).toHaveCount(1);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("fork-thread.png") });

  // The crumb opens the original, which has both its turns.
  await original.click();
  await expect(transcript.getByText("Write the README", { exact: true })).toBeVisible();
  await expect(transcript.locator("[data-copied]")).toHaveCount(0);

  // Fork in the thread's menu forks at the latest turn.
  const rows = page.locator('li[data-kind="thread"]');
  await expect(rows).toHaveCount(2);
  const row = rows.filter({ has: page.locator('[aria-current="page"]') });
  await row.hover();
  await row.getByRole("button", { name: "Thread actions" }).click();
  await page.getByRole("menuitem", { name: "Fork…" }).click();
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem").first().click();
  await expect(rows).toHaveCount(3);
  await expect(original).toBeVisible();
  await expect(transcript.getByText("Write the README", { exact: true })).toBeVisible();
  await expect(transcript.locator("[data-copied]")).toHaveCount(4);
});
