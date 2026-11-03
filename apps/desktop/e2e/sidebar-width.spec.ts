import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

// A thread's row, grouped by day, at the sidebar's narrowest width (PLX-1269).

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

test("a narrow sidebar keeps a row's branch and icons in view", async () => {
  launched = await launch("agent.json");
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  // Group by day, as only a grouped row outgrew the sidebar.
  await page.evaluate(`localStorage.setItem("parallax:todayGroup", '"day"')`);
  await page.reload();

  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "quill");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "--allow-empty", "-m", "Start"]);
  const params = { id: uuidv7(), path: repo };
  await page.evaluate(`window.parallax.request("local", "repo/add", ${JSON.stringify(params)})`);

  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await page
    .getByRole("dialog", { name: "New thread in" })
    .getByRole("option", { name: /^quill/ })
    .click();
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Explain why a long thread title must not push the icons out of the sidebar");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  const sidebar = page.locator("#sidebar");
  const row = sidebar.locator("li[data-kind='thread']");
  await expect(row).toHaveCount(1);
  await expect(sidebar.getByRole("button", { name: /^Today/ })).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await handle.focus();
  for (let i = 0; i < 16; i++) await page.keyboard.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "240");
  await page.mouse.move(800, 400);
  await page.screenshot({ path: test.info().outputPath("narrow-sidebar.png") });

  const right = async (locator: typeof row) => {
    const box = await locator.boundingBox();
    return box ? box.x + box.width : Infinity;
  };
  const edge = await right(sidebar);
  expect(await right(row)).toBeLessThanOrEqual(edge);
  expect(await right(row.getByRole("img").last())).toBeLessThanOrEqual(edge);
  expect(await right(row.locator("[title^='parallax/']"))).toBeLessThanOrEqual(edge);
});
