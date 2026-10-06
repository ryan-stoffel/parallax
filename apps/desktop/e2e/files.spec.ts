import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("the Files view creates, renames, and deletes a thread's files and folders (PLX-590)", async () => {
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "quill");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "README.md"), "# quill\n");
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "-m", "Start"]);
  const added = await page.evaluate(
    `window.parallax.request("local", "repo/add", ${JSON.stringify({ id: uuidv7(), path: repo })})`,
  );
  expect(added).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByRole("heading", { level: 1 }).getByRole("button").click();
  await page.getByRole("menuitemradio", { name: "quill" }).click();
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("Plan the README");
  await box.press("Enter");
  await expect(page.getByText("The fake agent answered.", { exact: true })).toHaveCount(1);
  const runs = (await page.evaluate(`window.parallax.request("local", "agent/list", {})`)) as {
    result: { runs: { worktreePath?: string }[] };
  };
  const worktree = runs.result.runs.find((r) => r.worktreePath)!.worktreePath!;

  const show = page.getByRole("button", { name: "Show side panel" });
  if (await show.isVisible()) await show.click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await panel.getByRole("button", { name: /^Files/ }).click();
  const tree = panel.getByRole("tree", { name: "Files" });
  // An entry's row, the button named by its name.
  const item = (name: string) => tree.getByRole("button", { name, exact: true });
  await expect(item("README.md")).toBeVisible();

  // A folder from the toolbar, then a file in it from the folder's menu.
  await panel.getByRole("button", { name: "New folder" }).click();
  await panel.getByRole("textbox", { name: "Folder name" }).fill("docs");
  await panel.getByRole("textbox", { name: "Folder name" }).press("Enter");
  await expect(item("docs")).toBeVisible();
  expect(existsSync(path.join(worktree, "docs"))).toBe(true);

  await item("docs").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for docs" });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("files-menu.png") });
  await menu.getByRole("menuitem", { name: "New file" }).click();
  const name = panel.getByRole("textbox", { name: "File name" });
  await name.fill("guide.md");
  await page.screenshot({ path: test.info().outputPath("files-naming.png") });
  await name.press("Enter");
  await expect(item("guide.md")).toBeVisible();
  expect(existsSync(path.join(worktree, "docs/guide.md"))).toBe(true);

  // A name that's taken keeps the field open with the reason.
  await panel.getByRole("button", { name: "New file" }).click();
  await panel.getByRole("textbox", { name: "File name" }).fill("README.md");
  await panel.getByRole("textbox", { name: "File name" }).press("Enter");
  await expect(panel.getByRole("alert")).toHaveText('"README.md" already exists');
  await page.screenshot({ path: test.info().outputPath("files-taken.png") });
  await panel.getByRole("textbox", { name: "File name" }).press("Escape");

  // F2 renames in place.
  await item("guide.md").focus();
  await page.keyboard.press("F2");
  const rename = panel.getByRole("textbox", { name: "Rename guide.md" });
  await rename.fill("intro.md");
  await rename.press("Enter");
  await expect(item("intro.md")).toBeVisible();
  expect(existsSync(path.join(worktree, "docs/intro.md"))).toBe(true);
  expect(existsSync(path.join(worktree, "docs/guide.md"))).toBe(false);
  await page.screenshot({ path: test.info().outputPath("files-renamed.png") });

  // Delete asks, then removes the folder with what's in it.
  await item("docs").click({ button: "right" });
  await page.getByRole("menu", { name: "Actions for docs" }).getByRole("menuitem").last().click();
  const dialog = page.getByRole("dialog", { name: "Delete “docs”?" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("files-delete.png") });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(item("docs")).toHaveCount(0);
  expect(existsSync(path.join(worktree, "docs"))).toBe(false);
});
