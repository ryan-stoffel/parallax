import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { RECONNECT_GRACE_MS } from "../src/renderer/reconnectGrace";
import { uuidv7 } from "../src/renderer/uuidv7";
import { alive, close, launch, openThread, printFailure, servePids, type Launched } from "./launch";

// A dropped connection to a plxd that keeps running (0059): the app's subscriptions stay open,
// and once `plxd attach` is back, main resumes each after its last event. plxd replays the short
// gap, so the open transcript gets the text streamed meanwhile as events, with no fresh snapshot.
// It finds `plxd attach` among the app's child processes with `pgrep`, which Windows lacks.
// And a killed dev or test app takes its plxd serve and agents with it (PLX-990).
test.skip(process.platform === "win32", "finds processes with pgrep");

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

/** Launches the app, and opens a thread streaming `streamingScript` once its fifth delta is in. */
async function startStreaming(): Promise<Launched> {
  launched = await launch(streamingScript());
  const { page } = launched;
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
  await openThread(page, new RegExp(prompt));
  await expect(page.getByRole("log", { name: "Transcript" })).toContainText("Delta 5.");
  return launched;
}

/** The local connection's status. */
const state = () =>
  launched!.page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`);

/** Whether the open transcript takes in more text, as it does once a stream resumes. */
async function transcriptGrows(page: Page): Promise<boolean> {
  const transcript = page.getByRole("log", { name: "Transcript" });
  const before = (await transcript.textContent())?.length ?? 0;
  await expect
    .poll(async () => (await transcript.textContent())?.length ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(before);
  return true;
}

test("a dropped connection resumes after the last event, with no fresh snapshot", async () => {
  const { app, page } = await startStreaming();
  const transcript = page.getByRole("log", { name: "Transcript" });

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

  // The connection log says why it dropped and for how long.
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  const log = () => readFileSync(path.join(userData, "logs", "connection.log"), "utf8");
  expect(log()).toMatch(
    /client_disconnect host=local route=local reason=transport_closed lived_ms=\d+ signal=SIGKILL/,
  );
  await expect
    .poll(log)
    .toMatch(/client_connect host=local route=local .*down_ms=\d+ .*plxd_restarted=false/);

  // The deltas streamed while it was down arrive as events, with every one before them kept.
  await expect.poll(async () => (await sent()).includes("event")).toBe(true);
  // Delta 31 is in, so each delta through 30 has the space that follows it.
  await expect(transcript).toContainText("Delta 31.", { timeout: 20_000 });
  const text = (await transcript.textContent()) ?? "";
  for (let i = 1; i <= 30; i++) expect(text).toContain(`Delta ${i}. `);
  expect(await sent()).not.toContain("snapshot");
});

test("a short drop changes nothing on screen, and one that stays down shows after its grace", async () => {
  const { app, page } = await startStreaming();
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(box).toBeEditable();

  // Every frame, whatever on screen would admit the host isn't connected.
  await page.evaluate(`(() => {
    const seen = new Set();
    globalThis.seen = seen;
    const words = ["Reconnecting", "Connecting", "Disconnected", "Lost connection", "not connected"];
    const look = () => {
      const text = document.body.innerText;
      for (const word of words) if (text.includes(word)) seen.add(word);
      if (document.querySelector('button[aria-label="Voice input"]:disabled'))
        seen.add("composer off");
      requestAnimationFrame(look);
    };
    look();
  })()`);
  const seen = () => page.evaluate(() => [...(globalThis as { seen?: Set<string> }).seen!]);
  const attachPid = () => {
    const [attach] = execFileSync("pgrep", ["-P", String(app.process().pid!), "-f", "attach"], {
      encoding: "utf8",
    })
      .split("\n")
      .map(Number)
      .filter((pid) => pid > 1);
    expect(attach).toBeDefined();
    return attach!;
  };

  // The normal reconnect: `plxd attach` dies and backoff brings it back within the grace.
  process.kill(attachPid(), "SIGKILL");
  await expect.poll(state, { intervals: [20] }).not.toBe("connected");
  await expect.poll(state, { intervals: [20] }).toBe("connected");
  await expect(transcriptGrows(page)).resolves.toBe(true);
  expect(await seen()).toEqual([]);

  // Now it stays down: `attach` fails each try until the real path is back.
  const real = await app.evaluate(() => {
    const path = process.env["PLXD_PATH"]!;
    process.env["PLXD_PATH"] = "/usr/bin/false";
    return path;
  });
  process.kill(attachPid(), "SIGKILL");
  await expect.poll(state, { intervals: [20] }).not.toBe("connected");

  // Within the grace it looks connected, but a message that can't go says so and stays in the box.
  expect(await seen()).toEqual([]);
  await box.fill("Sent while it's down");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log", { name: "Transcript" })).not.toContainText(
    "Sent while it's down",
  );
  await expect(page.getByText("not connected")).toBeVisible();
  await expect(box).toContainText("Sent while it's down");

  // After it, the real state.
  await expect(page.getByRole("status").filter({ hasText: /Reconnecting|Connecting/ })).toBeVisible(
    { timeout: RECONNECT_GRACE_MS + 2_000 },
  );
  await expect(page.getByText("Lost connection to")).toBeVisible();

  await app.evaluate((_, path) => void (process.env["PLXD_PATH"] = path), real);
  await expect(page.getByText("Reconnected to")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status").filter({ hasText: /Reconnecting|Connecting/ })).toHaveCount(
    0,
  );
});

test("a view opened during a hidden drop loads once the connection is back (PLX-1375)", async () => {
  const { app, page } = await startStreaming();
  const real = await app.evaluate(() => {
    const path = process.env["PLXD_PATH"]!;
    process.env["PLXD_PATH"] = "/usr/bin/false";
    return path;
  });
  const [attach] = execFileSync("pgrep", ["-P", String(app.process().pid!), "-f", "attach"], {
    encoding: "utf8",
  })
    .split("\n")
    .map(Number)
    .filter((pid) => pid > 1);
  process.kill(attach!, "SIGKILL");
  await expect.poll(state, { intervals: [20] }).not.toBe("connected");

  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Storage", exact: true }).click();
  await app.evaluate((_, path) => void (process.env["PLXD_PATH"] = path), real);
  await expect.poll(state, { timeout: 20_000 }).toBe("connected");

  await expect(settings.getByText(/\d+ archived threads?/)).toBeVisible();
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Lost connection to")).toHaveCount(0);

  // A short drop with the loaded page open: it reads again, with nothing changing on the way.
  await page.evaluate(`(() => {
    const seen = new Set();
    globalThis.seen = seen;
    const words = ["Not connected", "not connected", "Counting", "Reconnecting", "Disconnected"];
    const look = () => {
      const text = document.body.innerText;
      for (const word of words) if (text.includes(word)) seen.add(word);
      requestAnimationFrame(look);
    };
    look();
  })()`);
  const [again] = execFileSync("pgrep", ["-P", String(app.process().pid!), "-f", "attach"], {
    encoding: "utf8",
  })
    .split("\n")
    .map(Number)
    .filter((pid) => pid > 1);
  process.kill(again!, "SIGKILL");
  await expect.poll(state, { intervals: [20] }).not.toBe("connected");
  await expect.poll(state, { intervals: [20] }).toBe("connected");
  await expect(settings.getByText(/\d+ archived threads?/)).toBeVisible();
  expect(await page.evaluate(`[...globalThis.seen]`)).toEqual([]);
});

test("a killed app's plxd serve exits, and its agent with it (PLX-990)", async () => {
  const { app, dataDir } = await startStreaming();
  const serve = servePids(dataDir).at(-1)!;
  // The fake backend's shell, streaming the thread.
  const [agent] = execFileSync("pgrep", ["-P", String(serve), "-f", "resume="], {
    encoding: "utf8",
  })
    .split("\n")
    .map(Number)
    .filter((pid) => pid > 1);
  expect(agent).toBeDefined();

  // Nothing is left for afterEach to close.
  launched = undefined;
  app.process().kill("SIGKILL");
  await expect.poll(() => alive(serve), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => alive(agent!)).toBe(false);
});
