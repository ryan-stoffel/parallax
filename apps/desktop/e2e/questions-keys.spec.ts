import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

// PLX-1286: how the question popup shares the keyboard with the composer and what else is open. A
// fake agent asks five times: once right after the message, and then each time the test releases
// it, once what the question should find is in place.

let launched: Launched;

test.beforeAll(async () => {
  launched = await launch("questions-keys.json");
});

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status !== expectedStatus) await printFailure(launched);
});

test.afterAll(() => close(launched));

test("the question popup takes the keys it should, and leaves alone what it shouldn't", async () => {
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

  const composer = page.getByRole("textbox", { name: "Message" });
  const tab = page.getByRole("region", { name: "Question", exact: true });
  const panel = page.getByRole("group", { name: "Question from the agent" });
  const opener = tab.locator("button[popovertarget]");
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  // A new panel ignores a pointer's clicks for 300 ms after it shows (PLX-259).
  const settle = () => page.waitForTimeout(400);

  // The first question opens by itself, in the thread the message started.
  await composer.fill("Plan the first release");
  await composer.press("Enter");
  await expect(panel).toBeFocused();
  const { result } = await page.evaluate<{ result: { threads: { id: string }[] } }>(
    `window.parallax.request("local", "thread/list", {})`,
  );
  const runId = result.threads[0]!.id;
  // As a steer, which reaches the fake agent's stdin while its turn stays open.
  const nextQuestion = () =>
    page.evaluate(
      `window.parallax.request("local", "orchestration/dispatch", ${JSON.stringify({
        type: "message.dispatch",
        threadId: runId,
        messageId: uuidv7(),
        text: "Next",
        dispatchMode: { type: "steer_active" },
      })})`,
    );

  // What a screen reader gets: the question announced, a named group, and named, checkable rows.
  await expect(
    page.locator('p[aria-live="polite"]', {
      hasText: "Question from the agent: Which database should the app use?",
    }),
  ).toBeAttached();
  await expect(panel).toMatchAriaSnapshot(`
    - group "Question from the agent":
      - group "Which database should the app use?":
        - radio /SQLite/
        - radio /Postgres/
  `);

  // A held Esc closes the popup, and its repeats don't stop the run from the composer.
  await composer.focus();
  await page.keyboard.down("Escape");
  await page.keyboard.down("Escape");
  await page.keyboard.up("Escape");
  await expect(panel).toBeHidden();
  await expect(stop).toBeVisible();
  await expect(tab).toContainText("Which database should the app use?");

  // Open but covered by an expanded side panel, the popup leaves Esc to what's on screen. The
  // browser still closes the popup it can't show, and the tab keeps the question.
  await opener.click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Show side panel" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Full screen", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await page.evaluate(`window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.escReachedThePage = true;
  })`);
  await page.keyboard.press("Escape");
  expect(await page.evaluate("window.escReachedThePage")).toBe(true);
  await page.getByRole("button", { name: "Exit full screen" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Hide side panel" }).focus();
  await page.keyboard.press("Enter");
  await expect(tab).toContainText("Which database should the app use?");
  await opener.click();
  await expect(panel).toBeVisible();

  // A held number answers the question in front of it, not the next one too.
  await panel.focus();
  await page.keyboard.down("1");
  await page.keyboard.down("1");
  await page.keyboard.up("1");
  await expect(panel.getByText("Which platforms should ship first?")).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /macOS/ })).not.toBeChecked();

  // A held Enter picks the option in focus, and its repeats don't send. The next Enter does.
  await panel.getByRole("checkbox", { name: /macOS/ }).focus();
  await page.keyboard.down("Enter");
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(panel.getByRole("checkbox", { name: /macOS/ })).toBeChecked();
  await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();

  // A question that comes while a menu is open waits on the tab, and the menu stays open.
  const answerFromTheTab = async () => {
    await opener.click();
    await settle();
    await panel.getByRole("radio", { name: "Yes" }).click();
    await panel.getByRole("button", { name: "Send" }).click();
  };
  const profile = page.getByRole("button", { name: "Profile", exact: true });
  const settings = page.getByRole("menuitem", { name: "Settings" });
  await profile.click();
  await expect(settings).toBeVisible();
  await nextQuestion();
  await expect(tab).toContainText("Asked while a menu is open?");
  await expect(panel).toBeHidden();
  await expect(settings).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("question-waits-under-menu.png") });
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await answerFromTheTab();

  // So does one that comes while a dialog is open, which it would otherwise sit inert above.
  await profile.click();
  await settings.click();
  const closeSettings = page.getByRole("button", { name: "Close settings" });
  await expect(closeSettings).toBeVisible();
  await nextQuestion();
  await expect(tab).toContainText("Asked while Settings is open?");
  await expect(page.locator(".question-popover:popover-open")).toHaveCount(0);
  await closeSettings.click();
  await answerFromTheTab();

  // A question that comes with focus in an empty composer takes it, so its keys work at once.
  await composer.focus();
  await nextQuestion();
  await expect(panel.getByText("Asked with focus in an empty composer?")).toBeVisible();
  await expect(panel).toBeFocused();
  await page.keyboard.press("1");
  await expect(panel.getByRole("radio", { name: "Yes" })).toBeChecked();
  await expect(composer).toHaveText("");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Asked with focus in an empty composer?")).toBeHidden();

  // A question that comes while the user types leaves the keys in the composer.
  await composer.click();
  await page.keyboard.type("A draft");
  await nextQuestion();
  await expect(panel.getByText("Asked while the user types?")).toBeVisible();
  await expect(composer).toBeFocused();
  await page.keyboard.type(" 1");
  await expect(composer).toHaveText("A draft 1");
  await page.screenshot({ path: test.info().outputPath("question-while-typing.png") });
  await expect(panel.getByRole("radio", { name: "Yes" })).not.toBeChecked();

  // A held Enter that answers the question doesn't send the draft once focus returns to it.
  await settle();
  await panel.getByRole("radio", { name: "Yes" }).click();
  await page.keyboard.down("Enter");
  await expect(panel).toBeHidden();
  await expect(composer).toBeFocused();
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(composer).toHaveText("A draft 1");
});
