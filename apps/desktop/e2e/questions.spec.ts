import { expect, test } from "@playwright/test";

import { close, launch, openThread, printFailure, type Launched } from "./launch";

// PLX-245: a thread whose fake agent asks the user questions, in Claude Code's shape and then in
// Codex's. The fake prints each answer it reads as the agent's text, so the transcript shows what
// reached it.

let launched: Launched;

test.beforeAll(async () => {
  launched = await launch("questions.json");
});

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (status !== expectedStatus) await printFailure(launched);
});

test.afterAll(() => close(launched));

test("answers an agent's questions from the composer's top bar, and keeps them as lines", async () => {
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

  await page.getByRole("textbox", { name: "Message" }).fill("Plan the first release");
  await page.getByRole("button", { name: "Send" }).click();

  const tab = page.getByRole("region", { name: "Question", exact: true });
  const panel = page.getByRole("group", { name: "Question from the agent" });
  const transcript = page.getByRole("log", { name: "Transcript" });
  const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  // A new panel ignores a pointer's clicks for 300 ms after it shows (PLX-259).
  const settle = () => page.waitForTimeout(400);

  // It opens by itself, with the first question, and the bar says where it stands.
  await expect(panel.getByText("Which database should the app use?")).toBeVisible();
  await expect(tab).toContainText("1 of 2");
  await expect(panel.getByText("Recommended", { exact: true })).toBeVisible();
  await settle();
  await shot("question-open");

  // The tab hides it and shows it again.
  await tab.locator("button[popovertarget]").click();
  await expect(panel).toBeHidden();
  await shot("question-closed");
  await tab.locator("button[popovertarget]").click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await tab.locator("button[popovertarget]").click();
  await expect(panel).toBeVisible();

  // Picking an option moves on to the next question.
  await panel.getByRole("radio", { name: /SQLite/ }).click();
  await expect(panel.getByText("Which platforms should ship first?")).toBeVisible();
  await expect(tab).toContainText("2 of 2");
  await panel.getByRole("checkbox", { name: /macOS/ }).click();
  await panel.getByRole("checkbox", { name: /Linux/ }).click();
  await panel.getByRole("textbox", { name: "Your own answer" }).fill("FreeBSD");
  await shot("question-multiple");
  await panel.getByRole("button", { name: "Send" }).click();

  // Claude Code's shape: by question text, with several joined by commas, and the option's whole
  // label, "(Recommended)" included.
  const echoed = (...fields: string[]) =>
    fields.reduce((p, field) => p.filter({ hasText: field }), transcript.locator("p"));
  await expect(
    echoed(
      '"Which database should the app use?":"SQLite (Recommended)"',
      '"Which platforms should ship first?":"macOS, Linux, FreeBSD"',
    ),
  ).toBeVisible();
  await expect(transcript.getByText("Answered", { exact: true })).toBeVisible();

  // Codex's shape: a question with no options takes a typed answer, by id. Enter sends it.
  const name = panel.getByRole("textbox", { name: "What should the release be called?" });
  await expect(name).toBeVisible();
  await settle();
  await expect(panel.getByRole("button", { name: "Send" })).toBeDisabled();
  await name.fill("First light");
  await shot("question-typed");
  await name.press("Enter");
  await expect(echoed('"name":{"answers":["First light"]}')).toBeVisible();
  await expect(transcript.getByText("The fake agent is done asking.")).toBeVisible();
  await expect(tab).toHaveCount(0);
  await shot("question-answered");

  // Rebuilt from the log, they're lines, with what was answered.
  await page.reload();
  await openThread(page, /Plan the first release/);
  await expect(
    transcript.getByText("What should the release be called? · First light"),
  ).toBeVisible();
  await expect(transcript.getByText("2 questions")).toBeVisible();
  await expect(tab).toHaveCount(0);
});
