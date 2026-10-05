import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("queue.json");
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// The fake keeps its first turn open until steering reaches stdin. Queued messages must remain waiting.
test("queues, edits, reorders and steers while the current turn keeps running (PLX-376)", async () => {
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
  await box.fill("Build the queue controls");
  await box.press("Enter");
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(
    transcript.getByText("I am working on the current turn.", { exact: true }),
  ).toBeVisible();
  for (const text of ["Add focused tests", "Update the README", "Run the checks"]) {
    await box.fill(text);
    await box.press("Enter");
  }
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue.locator("li")).toHaveCount(3);
  await expect(transcript.getByText("Add focused tests", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("queue-three.png") });
  await queue.getByRole("button", { name: "Edit queued message 2", exact: true }).click();
  await queue
    .getByRole("textbox", { name: "Edit queued message", exact: true })
    .fill("Document how queueing and steering work");
  await page.screenshot({ path: test.info().outputPath("queue-editing.png") });
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    queue.getByText("Document how queueing and steering work", { exact: true }),
  ).toBeVisible();
  await queue.getByRole("button", { name: "Move queued message 3 up", exact: true }).click();
  await expect(queue.locator("li").nth(1)).toContainText("Run the checks");
  await queue.getByRole("button", { name: "Steer queued message 1 now", exact: true }).click();
  await expect(queue.locator("li")).toHaveCount(2);
  await expect(
    transcript.getByText("Steering received during the current turn.", { exact: true }),
  ).toBeVisible();
  await expect(transcript.getByText("Add focused tests", { exact: true })).toHaveCount(2);
  await expect(transcript.getByText("Run the checks", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("queue-steering.png") });
  await queue.getByRole("button", { name: "Cancel queued message 1", exact: true }).click();
  await expect(queue.locator("li")).toHaveCount(1);
  await expect(queue.locator("li")).toContainText("Document how queueing and steering work");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});
