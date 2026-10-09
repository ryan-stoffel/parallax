import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

let launched: Launched | undefined;
test.afterEach(async () => {
  if (launched && test.info().status !== test.info().expectedStatus) await printFailure(launched);
});
test.afterAll(() => close(launched));

// plxd runs the shell (PLX-637), so quitting the app leaves it running, and the next launch shows
// what it printed and types into the same shell.
test("a thread's terminal keeps running, with its output, after the app quits and reopens", async () => {
  launched = await launch("agent.json");
  let { page } = launched;
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const defaults = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);
  expect(defaults).not.toHaveProperty("error");
  // New Thread reads the default when it opens.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Tidy up the README");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("log", { name: "Transcript" }).getByText("Stopped")).toBeVisible();

  // A variable lives only in this shell.
  const windows = process.platform === "win32";
  await page.getByRole("button", { name: "Show terminal" }).click();
  let terminal = page.getByRole("group", { name: "Terminal", exact: true });
  await terminal.click();
  await page.keyboard.type(windows ? '$kept = "still here"\r' : 'kept="still here"\r');
  await page.keyboard.type('echo "before quit: $kept"\r');
  await expect(terminal).toContainText("before quit: still here");
  await shot("1-before-quit");

  // A reload stops the shell's stream to the app (PLX-664). It keeps running, replays on the next
  // open, and streams again.
  await page.reload();
  await page.getByText("Tidy up the README").first().click();
  await page.getByRole("button", { name: "Show terminal" }).click();
  terminal = page.getByRole("group", { name: "Terminal", exact: true });
  await expect(terminal).toContainText("before quit: still here");
  await terminal.click();
  await page.keyboard.type('echo "$kept-reloaded"\r');
  await expect(terminal).toContainText("still here-reloaded");

  await launched.app.close();
  launched = await launch("agent.json", undefined, undefined, launched.dataDir);
  ({ page } = launched);
  await page.getByText("Tidy up the README").first().click();
  await page.getByRole("button", { name: "Show terminal" }).click();
  terminal = page.getByRole("group", { name: "Terminal", exact: true });
  await expect(terminal).toContainText("before quit: still here");
  await shot("2-reopened");
  await terminal.click();
  await page.keyboard.type('echo "$kept-ok"\r');
  await expect(terminal).toContainText("still here-ok");
  await shot("3-same-shell");
});
