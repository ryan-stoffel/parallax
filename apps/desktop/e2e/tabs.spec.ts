import { expect, test, type Locator } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

// The top bar's tabs in the built app, with real drags and the window's own keys (PLX-1289).

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

test("threads open in tabs, drag to reorder and tile, and close with the keyboard", async () => {
  launched = await launch("agent.json");
  const { page } = launched;
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  await page.reload();

  const strip = page.getByRole("tablist", { name: "Open tabs" });
  const tabs = strip.getByRole("tab");
  const tile = page.getByRole("tablist", { name: "Threads" }).getByRole("tab");
  const start = async (prompt: string) => {
    await page.getByRole("textbox", { name: "Message" }).fill(prompt);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(tabs.and(page.getByTitle(prompt))).toHaveAttribute("aria-selected", "true");
  };
  // Holds the mouse's real path, so the app sees dragenter and dragover as it would from a hand.
  const drag = async (from: Locator, x: number, y: number) => {
    const box = (await from.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.move(x + 1, y + 1);
    await page.mouse.up();
  };

  await expect(tabs).toHaveText(["New thread"]);
  await start("First");
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(tabs).toHaveText(["First", "New thread"]);
  await start("Second");
  await expect(tabs).toHaveText(["First", "Second"]);

  // Dragged past the second tab's middle, the first lands after it.
  const second = (await tabs.nth(1).boundingBox())!;
  await drag(tabs.nth(0), second.x + second.width - 2, second.y + second.height / 2);
  await expect(tabs).toHaveText(["Second", "First"]);

  // Dragged into the open thread, a tab tiles beside it and leaves the strip.
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  const pane = page.getByRole("log", { name: "Transcript" }).first();
  const paneBox = (await pane.boundingBox())!;
  await drag(tabs.nth(0), paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
  await expect(tile).toHaveText(["First", "Second"].map((t) => new RegExp(`^${t}`)));
  await expect(tabs).toHaveCount(1);

  // A tile's header dragged back to the strip gets its tab again.
  const end = (await strip.boundingBox())!;
  await drag(tile.nth(0), end.x + end.width - 2, end.y + end.height / 2);
  await expect(tabs).toHaveCount(2);
  await expect(tile).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+T");
  await expect(tabs).toHaveCount(3);
  // Closes the tab, and not the window, which is what the keys mean by default.
  await page.keyboard.press("ControlOrMeta+W");
  await expect(tabs).toHaveCount(2);
  // The next tab, wrapping around.
  const selected = tabs.and(page.locator('[aria-selected="true"]'));
  const before = await selected.textContent();
  await page.keyboard.press("Control+Tab");
  await expect(selected).not.toHaveText(before!);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(selected).toHaveText(before!);
});
