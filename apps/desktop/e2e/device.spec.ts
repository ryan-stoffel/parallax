import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched | undefined;
test.afterEach(async () => {
  if (launched && test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// An agent's device_open opens the thread's Device view (PLX-886), which lists the host's
// devices, or says why it has none.
test("an agent opening a device shows the Device view", async () => {
  test.setTimeout(120_000);
  launched = await launch("device.json");
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Check the login screen on iOS");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("The simulator is open.")).toBeVisible();

  const panel = page.getByRole("complementary", { name: "Side panel" });
  await expect(panel.getByRole("button", { name: "Device", exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  // The fake device isn't on this host, so the view lists what is, or, with one simulator
  // running, opens it. A cold Mac runner's first simctl listing can take a while.
  // Or, on a host that can run none, what it's missing: a runner whose simctl fails gets Get Xcode
  // (PLX-919).
  const missing = panel.getByText(/needs a Mac|Get Xcode|Get Android Studio/).first();
  const shown = panel
    .getByRole("list", { name: "Devices" })
    .or(panel.getByRole("toolbar", { name: "Device controls" }))
    .or(missing)
    .first();
  await expect(shown).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: test.info().outputPath("device-view.png") });
});
