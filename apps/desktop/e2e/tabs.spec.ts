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

  const strips = page.getByRole("tablist", { name: "Open tabs" });
  const tabs = strips.getByRole("tab");
  const panes = page.locator("[data-pane]");
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

  // New thread alone has no tab. A pane's only tab on the window's left starts at its card's left
  // edge, and among others a tab starts further in.
  await expect(tabs).toHaveCount(0);
  await start("First");
  const flush = async () => {
    const card = (await page.locator(".pane-card").first().boundingBox())!;
    const tab = (await page.locator("[data-tab]").first().boundingBox())!;
    return Math.abs(card.x - tab.x) < 1;
  };
  await expect.poll(flush).toBe(true);
  await page.getByRole("button", { name: "New tab" }).click();
  await expect(tabs).toHaveText(["First", "New thread"]);
  await expect.poll(flush).toBe(false);
  await start("Second");
  await expect(tabs).toHaveText(["First", "Second"]);

  // Dragged past the second tab's middle, the first lands after it.
  const second = (await tabs.nth(1).boundingBox())!;
  await drag(tabs.nth(0), second.x + second.width - 2, second.y + second.height / 2);
  await expect(tabs).toHaveText(["Second", "First"]);

  // Dragged to the window's left side, a tab opens in a pane of its own there.
  const pane = page.getByRole("log", { name: "Transcript" }).first();
  const paneBox = (await pane.boundingBox())!;
  await drag(tabs.nth(0), paneBox.x + 20, paneBox.y + paneBox.height / 2);
  await expect(panes).toHaveCount(2);
  await expect(strips).toHaveCount(2);
  await expect(strips.nth(0).getByRole("tab")).toHaveText(["Second"]);
  await expect(strips.nth(1).getByRole("tab")).toHaveText(["First"]);
  await expect.poll(flush).toBe(true);

  // Dragged to the other pane's tabs, it joins them, and the pane it left closes.
  // Over its plus, which is past its tabs however little room they have.
  const target = (await page.getByRole("button", { name: "New tab" }).nth(1).boundingBox())!;
  await drag(tabs.nth(0), target.x + target.width / 2, target.y + target.height / 2);
  await expect(panes).toHaveCount(0);
  await expect(strips).toHaveCount(1);
  await expect(tabs).toHaveText(["First", "Second"]);

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
