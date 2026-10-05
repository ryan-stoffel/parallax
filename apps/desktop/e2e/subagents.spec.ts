import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("subagents.json");
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// The agent starts two of its own subagents, as Claude Code's Agent tool does: one finishes, one
// keeps working while the run hangs.
test("an agent's own subagents show their status and open read-only, without a composer (PLX-382)", async () => {
  const { app, page } = launched;
  // Wide enough for both chips in the screenshots, where the screen allows it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 860));
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("Check the build docs and find the flaky test");
  await box.press("Enter");

  // The chips fit only on a wide enough screen, so this opens the subagent from its row;
  // Lineage.test.tsx covers the chips.
  const transcript = page.getByRole("log", { name: "Transcript" });
  await transcript.getByRole("button", { name: /^Running agent/ }).click();
  const docs = transcript.getByRole("button", { name: "Open subagent: Read the build docs, Done" });
  await expect(docs).toBeVisible();
  await expect(
    transcript.getByRole("button", { name: "Open subagent: Find the flaky test, Working" }),
  ).toBeVisible();
  await expect(transcript.getByText("README.md")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("subagents-thread.png") });

  await docs.click();
  await expect(page.getByRole("status", { name: "Subagent" })).toHaveText(
    "Explore · Claude Haiku 4.5 · DoneRead-only: Claude Code's own subagent",
  );
  await expect(transcript.getByText("The README says to build with")).toBeVisible();
  await expect(box).toHaveCount(0);
  // Its history: what it did, folded as a finished turn's work is.
  await transcript.getByRole("button", { name: /^Worked/ }).click();
  await expect(transcript.getByText("README.md", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("subagents-opened.png") });
});
