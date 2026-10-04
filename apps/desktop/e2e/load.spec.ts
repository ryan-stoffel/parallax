import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

// How smooth the app stays with 30 threads streaming at once, one of them open (PLX-447): the
// renderer's frame times and long tasks over 20 s, and the subscription bytes main sends it.
// A measurement, not a check, so it runs only with PLX_LOAD=1:
//   PLX_LOAD=1 pnpm e2e load.spec.ts
// It prints a summary and writes load.json to the test's output folder, and to PLX_LOAD_OUT when
// set. PLX_LOAD_VIDEO, a folder, records the window there.

const threads = 30;
const deltaMs = 50;
// About 45 s of streaming, which outlasts starting the threads and the 20 s sample. A longer
// script would pass Linux's 128 KiB limit on one argument, since plxd hands it to `sh -c`.
const deltas = 900;
const sampleMs = 20_000;

test.skip(process.env["PLX_LOAD"] !== "1", "a measurement; run with PLX_LOAD=1");

let launched: Launched | undefined;

interface IpcStats {
  messages: number;
  bytes: number;
}

test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

/** A fake backend script that streams `deltas` text deltas, `deltaMs` apart, then waits. */
function streamingScript(): string {
  const steps: unknown[] = [{ init: { sessionId: "load", model: "fake-model" } }];
  for (let i = 1; i <= deltas; i++) {
    const end = i % 10 === 0 ? "\n\n" : " ";
    steps.push({ emit: { kind: "textDelta", text: `Delta ${i} of the load test.${end}` } });
    steps.push({ sleepMs: deltaMs });
  }
  steps.push({ endTurn: {} }, "hang");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "parallax-load-")), "load.json");
  writeFileSync(file, JSON.stringify(steps));
  return file;
}

/** The value at fraction `q` of sorted `values`. */
const quantile = (values: number[], q: number) =>
  values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;

test("30 streaming threads, one open", async () => {
  test.setTimeout(180_000);
  process.env["PLX_IPC_STATS"] = "1";
  const video = process.env["PLX_LOAD_VIDEO"];
  launched = await launch(
    streamingScript(),
    undefined,
    video ? { dir: video, size: { width: 1200, height: 800 } } : undefined,
  );
  const { app, page } = launched;

  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
  const set = await page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");

  const name = (i: number) => `Load thread ${String(i).padStart(2, "0")}`;
  for (let i = 1; i <= threads; i++) {
    const params = JSON.stringify({ runId: uuidv7(), prompt: name(i) });
    const started = await page.evaluate(
      `window.parallax.request("local", "thread/start", ${params})`,
    );
    expect(started).not.toHaveProperty("error");
  }

  await page.getByRole("button", { name: new RegExp(`${name(1)}\\b`) }).click();
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText(name(1))).toBeVisible();
  await expect(transcript.getByText(/Delta \d+ of the load test/).first()).toBeVisible();
  // Off the thread's button, whose hover card would cover the transcript in the video.
  await transcript.hover();

  // hosts.ts keeps them with PLX_IPC_STATS set.
  const ipcStats = () =>
    app.evaluate(() => ({ ...(globalThis as { ipcStats?: IpcStats }).ipcStats! }));
  const before = await ipcStats();
  // A string, as the e2e folder is type-checked without the DOM's types.
  const frames = await page.evaluate<{ deltas: number[]; longTasks: number[] }>(`(async () => {
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask" });
    const deltas = [];
    await new Promise((done) => {
      requestAnimationFrame((start) => {
        let last = start;
        const frame = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - start < ${sampleMs}) requestAnimationFrame(frame);
          else done();
        };
        requestAnimationFrame(frame);
      });
    });
    observer.disconnect();
    return { deltas, longTasks };
  })()`);
  const after = await ipcStats();

  const sorted = [...frames.deltas].sort((a, b) => a - b);
  const seconds = sampleMs / 1000;
  const result = {
    threads,
    deltaMs,
    sampleMs,
    frames: {
      count: sorted.length,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      max: sorted.at(-1) ?? 0,
      over33ms: sorted.filter((d) => d > 33.4).length,
      deltas: frames.deltas,
    },
    longTasks: {
      count: frames.longTasks.length,
      totalMs: frames.longTasks.reduce((sum, d) => sum + d, 0),
      max: Math.max(0, ...frames.longTasks),
      durations: frames.longTasks,
    },
    ipc: {
      messagesPerSecond: (after.messages - before.messages) / seconds,
      bytesPerSecond: (after.bytes - before.bytes) / seconds,
    },
  };
  const json = JSON.stringify(result, null, 2);
  writeFileSync(test.info().outputPath("load.json"), json);
  if (process.env["PLX_LOAD_OUT"]) writeFileSync(process.env["PLX_LOAD_OUT"], json);
  const { deltas: _, ...summary } = result.frames;
  console.log(JSON.stringify({ frames: summary, ipc: result.ipc }, null, 2));
  console.log(`long tasks: ${result.longTasks.count}, ${Math.round(result.longTasks.totalMs)} ms`);
  expect(after.bytes).toBeGreaterThan(before.bytes);
});
