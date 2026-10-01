import { expect, test } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

// RYA-196: a thread whose fake agent asks before writing a long file and before a command, then
// hands over its plan, as Claude Code does through wispd (0031). The fake prints each answer it
// reads as the agent's text, so the transcript shows what reached it. Its own app and wispd, since
// the fake plays one script.

test.describe.configure({ mode: "serial" });

let launched: Launched;

test.beforeAll(async () => {
  launched = await launch("approvals.json");
});

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status !== expectedStatus) await printFailure(launched);
});

test.afterAll(() => close(launched));

test("answers a thread's permission requests from the card over the composer, and keeps them as lines", async () => {
  const { page } = launched;
  await expect(page.getByRole("status").filter({ hasText: "Connected · wispd" })).toBeVisible();
  // As in app.spec.ts: the fake's account runs threads once it's the default.
  const set = await page.evaluate(`window.wisp.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Back to app" }).click();

  await page.getByRole("textbox", { name: "Message" }).fill("Run the tests, then plan the release");
  await page.getByRole("button", { name: "Send" }).click();

  // The command, pinned over the composer, outside the transcript.
  const pinned = page.getByRole("region", { name: "Approval requests" });
  const transcript = page.getByRole("log", { name: "Transcript" });
  // The answer as the fake read it, a JSON line with keys in any order.
  const echoed = (...fields: string[]) =>
    fields.reduce((p, field) => p.filter({ hasText: field }), transcript.locator("p"));

  // First a long file, its preview opened in full, under a composer grown to its cap (RYA-259):
  // the preview gives way, so the card's Approve and the composer's controls stay in view.
  const approve = pinned.getByRole("button", { name: "Approve", exact: true });
  await pinned.getByRole("button", { name: "Show all 40 lines" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
  await launched.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), lines);
  await message.click();
  // As the Edit menu's Paste does, which a synthetic keypress can't (app.spec.ts).
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.paste();
  });
  await expect(message).toContainText("line 40");
  for (const control of [
    page.getByRole("button", { name: "Send" }),
    page.getByRole("button", { name: "Attach files" }),
    approve,
  ])
    await expect(control).toBeInViewport({ ratio: 1 });
  await message.press("ControlOrMeta+a");
  await message.press("Backspace");
  await approve.click();
  await expect(transcript.getByText("Approved", { exact: true })).toBeVisible();

  await expect(pinned.getByText("pnpm test", { exact: true })).toBeVisible();
  await expect(pinned).toContainText("Always allow adds Bash(pnpm test:*)");
  await expect(transcript.getByText("Waiting for approval", { exact: true })).toBeVisible();
  await pinned.getByRole("button", { name: "Always allow" }).click();
  await expect(transcript.getByText("Always allowed", { exact: true })).toBeVisible();
  await expect(echoed('"decision":"allow"', '"always":true')).toBeVisible();

  // Then the plan, sent back with a note.
  await expect(pinned.getByText("Proposed plan")).toBeVisible();
  await expect(pinned.getByText("Tag the release.")).toBeVisible();
  await pinned.getByRole("button", { name: "Keep planning" }).click();
  const note = pinned.getByRole("textbox", { name: "What should change" });
  await expect(note).toBeFocused();
  await note.fill("Cover the changelog too.");
  await note.press("Enter");
  await expect(transcript.getByText("Kept planning", { exact: true })).toBeVisible();
  await expect(echoed('"decision":"deny"', '"message":"Cover the changelog too."')).toBeVisible();
  await expect(transcript.getByText("The fake agent is done asking.")).toBeVisible();
  await expect(pinned).toHaveCount(0);

  // Rebuilt from the log, they're lines, never cards again.
  await page.reload();
  await page.getByRole("button", { name: /Run the tests, then plan the release/ }).click();
  await expect(transcript.getByText("Always allowed", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Kept planning", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Proposed plan")).toBeVisible();
  await expect(pinned).toHaveCount(0);
});
