import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

// macOS hides the traffic lights in full screen, so the top row stops leaving room for them
// (PLX-1288).

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

test("macOS full screen moves the top row to the window's left edge", async () => {
  test.skip(process.platform !== "darwin", "only macOS has traffic lights");
  launched = await launch("agent.json");
  const { app, page } = launched;
  const left = (name: string) => async () =>
    (await page.getByRole("button", { name, exact: true }).boundingBox())?.x;

  await expect.poll(left("Hide sidebar")).toBe(80);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(true));
  await expect.poll(left("Hide sidebar")).toBe(12);

  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect.poll(left("Show sidebar")).toBe(12);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(false));
  await expect.poll(left("Show sidebar")).toBe(80);
});
