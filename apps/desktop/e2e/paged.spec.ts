import { writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Page } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, servePids, type Launched } from "./launch";

// A long run opens at its end and loads older pages as the transcript scrolls up, keeping what's
// in view where it is (PLX-490). Its turns are written into plxd's database while plxd is
// stopped. With PLX_LOAD=1 the run is 10,000 events long, the transcript scrolls back by wheel,
// and the time to open it is printed and written to PLX_LOAD_OUT when set. PLX_LOAD_VIDEO, a
// folder, records the window there:
//   PLX_LOAD=1 pnpm e2e paged.spec.ts

const measure = process.env["PLX_LOAD"] === "1";
// Each turn is 21 events: its message, a thought, eight tool calls and results, its answer,
// its end, and the run's end.
const turns = measure ? 476 : 96;
const prompt = "The long run's first message";

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

async function connected(page: Page) {
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");
}

/** Appends `turns` turns to run `runId` in the stopped plxd's database under `dataDir`. */
function seed(dataDir: string, runId: string) {
  // close() signals plxd and returns at once. The file stays locked until that process exits.
  const db = new DatabaseSync(path.join(dataDir, "plxd.sqlite3"), { timeout: 10_000 });
  const { project, head } = db
    .prepare(
      "SELECT (SELECT project_id FROM events WHERE thread_id = ? LIMIT 1) AS project, MAX(seq) AS head FROM events",
    )
    .get(runId) as { project: string; head: number };
  const insert = db.prepare(
    "INSERT INTO events (seq, time, project_id, thread_id, type, payload) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let seq = head;
  const add = (event: { kind: string } & Record<string, unknown>) => {
    seq += 1;
    const time = new Date(Date.UTC(2026, 9, 1) + seq * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    insert.run(seq, time, project, runId, event.kind, JSON.stringify({ ...event, runId }));
  };
  const output = (item: Record<string, unknown>) => add({ kind: "agent.output", items: [item] });
  db.exec("BEGIN");
  for (let i = 1; i <= turns; i++) {
    output({ kind: "turnStarted", turnId: uuidv7(), text: `Message ${i}` });
    output({ kind: "reasoning", text: `Thinking about step ${i}.` });
    for (let j = 1; j <= 8; j++) {
      const callId = `call-${i}-${j}`;
      output({ kind: "toolCall", callId, name: "Bash", input: { command: `ls step-${j}` } });
      output({ kind: "toolResult", callId, status: "ok", output: `step-${j}/README.md` });
    }
    output({ kind: "text", text: `Answer ${i}.` });
    output({ kind: "turnFinished", result: `Answer ${i}.` });
    add({ kind: "agent.finished", outcome: { status: "completed", result: `Answer ${i}.` } });
  }
  db.exec("COMMIT");
  db.close();
  return seq - head;
}

/** The transcript's scroll offset, and the top of the message bubble reading `text` in the window. */
const where = (page: Page, text: string) =>
  page.evaluate<{ scrollTop: number; top?: number }>(`(() => {
    const log = document.querySelector('[role="log"]');
    const row = [...log.querySelectorAll("div")].find(
      (d) => d.childElementCount === 0 && d.textContent === ${JSON.stringify(text)},
    );
    return { scrollTop: log.scrollTop, top: row?.getBoundingClientRect().top };
  })()`);

test("a long run opens at its end and scrolls back to its start (PLX-490)", async () => {
  test.setTimeout(measure ? 300_000 : 120_000);
  launched = await launch("paged.json");
  await connected(launched.page);
  const set = await launched.page
    .evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker",
    account: { kind: "subscription", backend: "fake" },
  })`);
  expect(set).not.toHaveProperty("error");
  const runId = uuidv7();
  const started = await launched.page.evaluate(
    `window.parallax.request("local", "thread/start", ${JSON.stringify({ runId, prompt })})`,
  );
  expect(started).not.toHaveProperty("error");
  await expect
    .poll(() =>
      launched!.page.evaluate(
        `window.parallax.request("local", "agent/list", {}).then((a) => a.result.runs.find((r) => r.id === ${JSON.stringify(runId)})?.status)`,
      ),
    )
    .toBe("completed");
  await close(launched);
  const events = seed(launched.dataDir, runId);

  const video = process.env["PLX_LOAD_VIDEO"];
  launched = await launch(
    "paged.json",
    undefined,
    video ? { dir: video, size: { width: 1200, height: 800 } } : undefined,
    launched.dataDir,
  );
  const { page } = launched;
  await connected(page);
  const transcript = page.getByRole("log", { name: "Transcript" });
  const opened = Date.now();
  await page.getByRole("button", { name: new RegExp(prompt) }).click();
  await expect(transcript.getByText(`Answer ${turns}.`, { exact: true })).toBeVisible();
  const openMs = Date.now() - opened;
  const first = transcript.getByText(prompt, { exact: true });

  if (measure) {
    await transcript.hover();
    // Steadily up to the very top, as a quick reader scrolls back, then a pause there.
    const scrollTop = `document.querySelector('[role="log"]').scrollTop`;
    while ((await page.evaluate<number>(scrollTop)) > 0 || !(await first.isVisible())) {
      await page.mouse.wheel(0, -500);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(1000);
    const json = JSON.stringify({ events, openMs }, null, 2);
    console.log(json);
    if (process.env["PLX_LOAD_OUT"]) writeFileSync(process.env["PLX_LOAD_OUT"], json);
    return;
  }

  // Scrolled to within a screen of the top, the page before loads, and the first message in view
  // stays where it was, at a greater scroll offset, until there's no page left.
  let pages = 0;
  const plxd = servePids(launched.dataDir).at(-1)!;
  for (;;) {
    // Every other page arrives after the list has stopped scrolling, as from a slow host: plxd
    // is paused until then (PLX-545). Windows has no way to pause it.
    const slow = pages % 2 === 1 && process.platform !== "win32";
    // Two screens down, where nothing loads, so the rows around there render.
    await page.evaluate(`(() => {
      const log = document.querySelector('[role="log"]');
      log.scrollTop = log.clientHeight * 2;
    })()`);
    await page.waitForTimeout(300);
    // Then up into the last screen in one go, which loads the page before. The rows rendered
    // above the old view are in the new one, and none has moved for the load yet.
    // The rows around the new offset render a frame later, so it waits for one in view.
    if (slow) {
      process.kill(plxd, "SIGSTOP");
      // Well past the 150 ms after its last scroll event that the virtualizer counts as scrolling.
      setTimeout(() => process.kill(plxd, "SIGCONT"), 500);
    }
    const shown = await page.evaluate<{
      anchor: string;
      top: number;
      scrollTop: number;
    }>(`(async () => {
      const log = document.querySelector('[role="log"]');
      log.scrollTop = log.clientHeight - 1;
      for (;;) {
        const { top, bottom } = log.getBoundingClientRect();
        const row = [...log.querySelectorAll("div")].find((d) => {
          const at = d.getBoundingClientRect().top;
          return d.childElementCount === 0 && /^Message \\d+$/.test(d.textContent) && at >= top && at < bottom;
        });
        if (row) return { anchor: row.textContent, top: row.getBoundingClientRect().top, scrollTop: log.scrollTop };
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    })()`);
    const loaded = await expect
      .poll(async () => (await where(page, shown.anchor)).scrollTop, { timeout: 3000 })
      .toBeGreaterThan(shown.scrollTop + 100)
      .then(() => true)
      .catch(() => false);
    if (!loaded) break;
    // The row can be out of the window for a frame while the list catches up with the new
    // offset, so a slow machine sees it missing once. It must settle where it was.
    await expect
      .poll(async () => Math.abs(((await where(page, shown.anchor)).top ?? Infinity) - shown.top), {
        timeout: 3000,
      })
      .toBeLessThan(2);
    pages += 1;
  }
  expect(pages).toBeGreaterThanOrEqual(3);
  await page.evaluate(`document.querySelector('[role="log"]').scrollTop = 0`);
  await expect(first).toBeVisible();
});
