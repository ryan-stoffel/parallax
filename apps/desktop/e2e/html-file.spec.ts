import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

// PLX-1484: a presented HTML file opens in the side panel rendered, its inline script running
// under the frame's own policy, and shows its source, highlighted, a click away.

let launched: Launched;

test.beforeAll(async () => {
  launched = await launch("html-file.json");
});

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status !== expectedStatus) await printFailure(launched);
});

test.afterAll(() => close(launched));

test("opens a presented HTML file rendered, and as its source", async () => {
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("textbox", { name: "Message" }).fill("Make the weekly report as HTML");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("Here's the weekly report.")).toBeVisible();
  await transcript.getByRole("button", { name: "Open report.html" }).click();

  const panel = page.locator("#side-panel");
  const frame = panel.frameLocator("iframe[title='report.html']");
  await expect(frame.getByText("Drawn by the page's own script.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Download as HTML" })).toBeEnabled();
  await shot("html-preview");

  await panel.getByRole("button", { name: "Source" }).click();
  await expect(panel.locator("iframe")).toHaveCount(0);
  // Highlighted as HTML, in the transcript's code block.
  const source = panel.locator("pre code.language-html");
  await expect(source).toContainText('<div class="bars" id="bars"></div>');
  await expect(source.locator(".hljs-tag").first()).toBeVisible();
  await shot("html-source");

  await panel.getByRole("button", { name: "Preview" }).click();
  await expect(frame.getByText("Drawn by the page's own script.")).toBeVisible();
});
