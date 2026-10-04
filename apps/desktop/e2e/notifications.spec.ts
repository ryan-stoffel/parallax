import { expect, test, type Page } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

/** Connects to the fake, makes it the default account, and starts a thread in the background. */
async function startInBackground(page: Page, prompt: string) {
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  // Cmd+Enter starts it and leaves New Thread open.
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill(prompt);
  await box.press("ControlOrMeta+Enter");
}

for (const [script, name] of [
  ["notifications.json", "finishes"],
  ["approvals.json", "needs you"],
] as const)
  test.describe(name, () => {
    let launched: Launched;
    test.beforeAll(async () => {
      launched = await launch(script);
    });
    test.afterEach(async () => {
      if (test.info().status !== test.info().expectedStatus) await printFailure(launched);
    });
    test.afterAll(() => close(launched));

    test(`a thread in the background notifies when it ${name}, with Open thread (PLX-507)`, async () => {
      const { page } = launched;
      await startInBackground(page, "Fix the login redirect loop");
      const notices = page.getByRole("region", { name: "Notifications" });
      const notice = notices.getByRole("status").first();
      await expect(notice).toContainText(
        name === "finishes" ? "Thread finished" : "Thread needs your input",
      );
      await expect(notice).toContainText("Fix the login redirect loop");
      await page.mouse.move(0, 0);
      await page.screenshot({ path: test.info().outputPath(`${script.replace(".json", "")}.png`) });

      await notice.getByRole("button", { name: "Open thread", exact: true }).click();
      await expect(notices).toHaveCount(0);
      await expect(
        page
          .getByRole("navigation", { name: "Breadcrumb" })
          .getByText("Fix the login redirect loop"),
      ).toBeVisible();
      if (name === "finishes")
        await expect(
          page.getByRole("log", { name: "Transcript" }).getByText("Fixed the redirect loop."),
        ).toBeVisible();
      else await expect(page.getByRole("region", { name: "Approval requests" })).toBeVisible();
    });
  });
