import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("model-switch.json");
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// The fake reports a session on another model before it takes the follow-up, as a thread moved
// to Codex would, so the divider goes in above that message.
test("marks where a thread switched models (PLX-495)", async () => {
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
  await box.fill("Plan the parser");
  await box.press("Enter");
  const transcript = page.getByRole("log", { name: "Transcript" });
  const divider = transcript.getByText("Switched model", { exact: true });
  await expect(divider).toBeVisible();
  await box.fill("Write the parser");
  await box.press("Enter");
  const queue = page.getByRole("region", { name: "Queued messages" });
  await queue.getByRole("button", { name: "Steer queued message 1 now", exact: true }).click();
  await expect(transcript.getByText("GPT-6.1 Sol wrote the code.", { exact: true })).toBeVisible();
  await expect(divider).toHaveCount(1);
  const row = divider.locator("..");
  await expect(row).toContainText("Claude Opus 5.5");
  await expect(row).toContainText("GPT-6.1 Sol");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("model-switch.png") });
});
