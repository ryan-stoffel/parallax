import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("edit-message.json", undefined, {
    dir: test.info().outputPath("video"),
  });
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// The fake never answers, so the message stays editable until the pencil stops the run (PLX-586).
test("the pencil edits a message the agent hasn't started on, and sends it as edited", async () => {
  const { page } = launched;
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
  await box.fill("Add a README");
  await box.press("Enter");
  const transcript = page.getByRole("log", { name: "Transcript" });
  const sent = transcript.getByText("Add a README", { exact: true });
  const pencil = transcript.getByRole("button", { name: "Edit message", exact: true });
  await expect(pencil).toBeAttached();
  await sent.hover();
  await page.screenshot({ path: test.info().outputPath("edit-pencil.png") });
  await pencil.click();
  const editor = transcript.getByRole("textbox", { name: "Edit message", exact: true });
  await expect(editor).toHaveValue("Add a README");
  await editor.fill("Add a README that explains how to build the app");
  await page.screenshot({ path: test.info().outputPath("edit-editing.png") });
  // Sent at once, it goes when the run has stopped.
  await editor.press("Enter");
  await expect(transcript.getByRole("button", { name: "Stopping…", exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("edit-stopping.png") });
  await expect(editor).toHaveCount(0, { timeout: 20_000 });
  await expect(
    transcript.getByText("Add a README that explains how to build the app", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Queued messages" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("edit-sent.png") });
});
