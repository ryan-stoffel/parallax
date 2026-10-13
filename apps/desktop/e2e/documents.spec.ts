import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

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
test("presented files show as cards, open in the side panel, and save an edit back to the agent", async () => {
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

  // The document opens in the side panel; an edit there saves the file and tells the agent.
  const runs = (await page.evaluate(`window.parallax.request("local", "agent/list", {})`)) as {
    result: { runs: { worktreePath?: string }[] };
  };
  const worktree = runs.result.runs.find((r) => r.worktreePath)!.worktreePath!;
  await card("Executive_Summary.docx").click();
  const panel = page.getByRole("complementary", { name: "Side panel" });
  const editor = panel.getByRole("textbox", { name: "Document" });
  const run = editor.getByText("Prepared for the Q4 planning review.");
  await expect(run).toBeVisible();
  // The run's right edge, before its trailing space: End doesn't move the caret on macOS.
  const edge = (await run.boundingBox())!;
  await run.click({ position: { x: edge.width - 1, y: edge.height / 2 } });
  await page.keyboard.type(" Revised by Ryan.");
  await page.screenshot({ path: test.info().outputPath("docx-editing.png") });
  // Formatting from the toolbar (PLX-758): the typed words larger, red, and bold, in a list.
  for (let i = 0; i < "Revised by Ryan.".length; i++) await page.keyboard.press("Shift+ArrowLeft");
  const toolbar = panel.getByRole("toolbar", { name: "Formatting" });
  await toolbar.getByRole("combobox", { name: "Font size" }).selectOption("28");
  await toolbar.getByLabel("Text color").fill("#c00000");
  await toolbar.getByRole("button", { name: "Bold" }).click();
  await toolbar.getByRole("button", { name: "Bulleted list" }).click();
  await expect(toolbar.getByRole("button", { name: "Bulleted list" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({ path: test.info().outputPath("docx-formatting.png") });
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(transcript.getByText(/I edited `Executive_Summary.docx` in Parallax/)).toBeVisible();
  await expect(transcript.getByText(/Got it. I see your edit/)).toBeVisible();
  const saved = unzipSync(readFileSync(path.join(worktree, "Executive_Summary.docx")));
  const xml = strFromU8(saved["word/document.xml"]!);
  expect(xml).toContain("Prepared for the Q4 planning review. ");
  expect(xml).toMatch(
    /<w:rPr><w:b\/><w:bCs\/><w:color w:val="C00000"\/><w:sz w:val="28"\/><w:szCs w:val="28"\/><\/w:rPr><w:t xml:space="preserve">Revised by Ryan.<\/w:t>/,
  );
  expect(xml).toMatch(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/);
  await page.screenshot({ path: test.info().outputPath("docx-saved.png") });

  // A sheet's cell, edited in place.
  await card("Budget.xlsx").click();
  const grid = panel.getByRole("grid", { name: "Budget" });
  await expect(grid.getByText("Contractors")).toBeVisible();
  await grid.getByText("Contractors").click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("5500");
  await page.keyboard.press("Enter");
  await page.screenshot({ path: test.info().outputPath("xlsx-editing.png") });
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  // The deck and the PDF are read-only.
  await card("Ember_Deck.pptx").click();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("pptx.png") });
  await card("Executive_Summary.pdf").click();
  await expect(panel.locator("canvas").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pdf.png") });
});
