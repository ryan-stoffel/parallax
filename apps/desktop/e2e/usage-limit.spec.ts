import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched;
test.beforeAll(async () => {
  launched = await launch("usage-limit.json");
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// The fake reports a refused limit with no reset, so plxd backs off 15 minutes (0049) and the run
// waits. Every launch plays the script again, so Resume now ends waiting again.
test("a limited thread waits with Resume now and Cancel, and both switches change it (PLX-377)", async () => {
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
  await box.fill("Add a README that explains how to build the app");
  await box.press("Enter");

  // A resume time on the next day, in a run started in the last 15 minutes before midnight, comes
  // with its date: "Oct 5, 12:09 AM".
  const card = page.getByRole("region", { name: "Usage limit" });
  await expect(card).toContainText(
    /Usage limit reached\. Resumes at (\w+ \d{1,2}, )?\d{1,2}:\d{2}/,
  );
  const row = page.locator('li[data-kind="thread"]');
  await expect(row.locator("[data-status]")).toContainText(/Resumes (\w+ \d{1,2}, )?\d{1,2}:\d{2}/);
  await expect(row).not.toContainText("Failed");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("usage-limit-thread.png") });
  await card.screenshot({ path: test.info().outputPath("usage-limit-card.png") });
  await row.screenshot({ path: test.info().outputPath("usage-limit-row.png") });

  const transcript = page.getByRole("log", { name: "Transcript" });
  await card.getByRole("button", { name: "Resume now" }).click();
  await expect(
    transcript.getByText("Your usage limit has reset. Continue where you left off.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(transcript.getByText("I started on the README.", { exact: true })).toHaveCount(2);
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toHaveCount(0);
  await expect(row.locator("[data-status]")).not.toContainText("Resumes");

  // The thread's own switch, in its menu: on by the host's setting, then off for this run.
  await row.hover();
  await row.getByRole("button", { name: "Thread actions" }).click();
  const toggle = page.getByRole("menuitemcheckbox", { name: "Resume after usage limits" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: test.info().outputPath("usage-limit-menu.png") });
  await toggle.click();
  await row.hover();
  await row.getByRole("button", { name: "Thread actions" }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  // The host's switch, in Settings > General.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  const hostSwitch = page.getByRole("switch", { name: "Resume after a usage limit" });
  await expect(hostSwitch).toHaveAttribute("aria-checked", "true");
  await hostSwitch.click();
  await expect(hostSwitch).toHaveAttribute("aria-checked", "false");
  await expect
    .poll(() =>
      page.evaluate(
        `window.parallax.request("local", "host/settings/get", {}).then((a) => a.result.autoResume)`,
      ),
    )
    .toBe(false);
  await page.getByRole("region", { name: "Usage limits" }).screenshot({
    path: test.info().outputPath("usage-limit-settings.png"),
  });
});
