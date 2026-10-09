import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

// A dropped connection to a plxd that keeps running (0059): the app's subscriptions stay open,
// and once `plxd attach` is back, main resumes each after its last event. plxd replays the short
// gap, so the open transcript gets the text streamed meanwhile as events, with no fresh snapshot.
// It finds `plxd attach` among the app's child processes with `pgrep`, which Windows lacks.
test.skip(process.platform === "win32", "finds plxd attach with pgrep");

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

/**
 * A fake backend script that streams numbered text deltas, 200 ms apart, then waits: a few a
 * second, so the gap a reconnect replays stays far under plxd's 128 events, even on a slow runner.
 */
function streamingScript(): string {
  const steps: unknown[] = [{ init: { sessionId: "reconnect", model: "fake-model" } }];
  for (let i = 1; i <= 400; i++) {
    steps.push({ emit: { kind: "textDelta", text: `Delta ${i}. ` } });
    steps.push({ sleepMs: 200 });
  }
  steps.push({ endTurn: {} }, "hang");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "parallax-reconnect-")), "stream.json");
  writeFileSync(file, JSON.stringify(steps));
  return file;
}

test("a dropped connection resumes after the last event, with no fresh snapshot", async () => {
  launched = await launch(streamingScript());
  const { app, page } = launched;
  const state = () =>
    page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`);
  await expect.poll(state).toBe("connected");
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  const prompt = "Stream for a while";
  const started = await page.evaluate(
    `window.parallax.request("local", "thread/start", ${JSON.stringify({ runId: uuidv7(), prompt })})`,
  );
  expect(started).not.toHaveProperty("error");
  await page.getByRole("button", { name: new RegExp(prompt) }).click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript).toContainText("Delta 5.");

  // What main sends the window's subscriptions from here on: each message's type.
  await app.evaluate(({ webContents }) => {
    const sent: string[] = [];
    (globalThis as { sent?: string[] }).sent = sent;
    for (const contents of webContents.getAllWebContents()) {
      const send = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "parallax:subscription") sent.push((args[1] as { type: string }).type);
        send(channel, ...args);
      };
    }
  });
  const sent = () => app.evaluate(() => [...(globalThis as { sent?: string[] }).sent!]);

  // Drop the connection: `plxd attach`, the app's child, dies, and plxd serve keeps going.
  const main = app.process().pid!;
  const [attach] = execFileSync("pgrep", ["-P", String(main), "-f", "attach"], {
    encoding: "utf8",
  })
    .split("\n")
    .map(Number)
    .filter((pid) => pid > 1);
  expect(attach).toBeDefined();
  process.kill(attach!, "SIGKILL");
  await expect.poll(state).not.toBe("connected");
  await expect.poll(state).toBe("connected");

  // The deltas streamed while it was down arrive as events, with every one before them kept.
  await expect.poll(async () => (await sent()).includes("event")).toBe(true);
  // Delta 31 is in, so each delta through 30 has the space that follows it.
  await expect(transcript).toContainText("Delta 31.", { timeout: 20_000 });
  const text = (await transcript.textContent()) ?? "";
  for (let i = 1; i <= 30; i++) expect(text).toContain(`Delta ${i}. `);
  expect(await sent()).not.toContain("snapshot");
});
