import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("documents.json");
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// The fake agent presents the four files in e2e/documents, which the repository holds, so the
// thread's worktree has them (PLX-755).
test("presented files show as cards and open view-only in the side panel, with download and full screen", async () => {
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "ember");
  mkdirSync(repo);
  cpSync(path.join(import.meta.dirname, "documents"), repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
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
  await page.getByRole("menuitemradio", { name: "ember" }).click();
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("Write an executive summary as a docx and a PDF, with a budget and a deck");
  await box.press("Enter");
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText(/Here are the summary/)).toBeVisible();

  // A card per file, with its title, type, and a thumbnail of its first page.
  const card = (name: string) => transcript.getByRole("button", { name: `Open ${name}` });
  for (const name of [
    "Executive_Summary.docx",
    "Executive_Summary.pdf",
    "Budget.xlsx",
    "Ember_Deck.pptx",
  ])
    await expect(card(name)).toBeVisible();
  await expect(transcript.getByText("Document · DOCX")).toBeVisible();
  await expect(transcript.getByText("Spreadsheet · XLSX")).toBeVisible();
  await expect(transcript.getByText("Presentation · PPTX")).toBeVisible();
  await card("Executive_Summary.docx").hover();
  await page.screenshot({ path: test.info().outputPath("cards.png") });

  // Each opens view-only in the side panel, as Claude shows files: pages on a gray backdrop
  // with the page in view counted, and Download as its type. The panel's button goes full screen.
  await card("Executive_Summary.docx").click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(panel.getByText("Executive Summary", { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Download as DOCX" })).toBeVisible();
  await expect(panel.getByText(/^Page 1 \/ [2-9]$/)).toBeVisible();
  await expect(panel.getByText("Prepared for the Q4 planning review.").first()).toBeVisible();
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("docx.png") });
  await panel.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(page.getByRole("main")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("docx-full-screen.png") });
  await panel.getByRole("button", { name: "Exit full screen" }).click();
  await expect(page.getByRole("main")).toBeVisible();

  await card("Budget.xlsx").click();
  const grid = panel.getByRole("grid", { name: "Budget" });
  await expect(grid.getByText("Contractors")).toBeVisible();
  await expect(grid.getByText("$5,000")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("xlsx.png") });

  await card("Ember_Deck.pptx").click();
  await expect(panel.getByRole("button", { name: "Download as PPTX" })).toBeVisible();
  await expect(panel.getByText("Page 1 / 3")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pptx.png") });
  await card("Executive_Summary.pdf").click();
  await expect(panel.locator("canvas").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pdf.png") });
});
