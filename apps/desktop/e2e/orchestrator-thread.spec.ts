import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

// An orchestrator's row offers a thread's actions, against a real plxd rather than a fixture
// (PLX-1176, 0093): plxd has to list the orchestrator's run as a thread for the row to have them.

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

test("an orchestrator's row pins and archives as a thread's does", async () => {
  launched = await launch("agent.json");
  const { page } = launched;
  const request = async <T>(method: string, params: object) => {
    const answer = (await page.evaluate(
      `window.parallax.request("local", ${JSON.stringify(method)}, ${JSON.stringify(params)})`,
    )) as { result?: T; error?: unknown };
    expect(answer.error).toBeUndefined();
    return answer.result as T;
  };
  await expect
    .poll(() => page.evaluate(`window.parallax.connectionState("local").then((s) => s.status)`))
    .toBe("connected");

  const repo = path.join(mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-")), "ember");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const identity = ["-c", "user.name=parallax", "-c", "user.email=parallax@localhost"];
  execFileSync("git", ["-C", repo, ...identity, "commit", "-q", "--allow-empty", "-m", "Start"]);

  await request("accounts/defaults/set", {
    role: "orchestrator",
    account: { kind: "subscription", backend: "fake" },
  });
  const id = uuidv7();
  await request("orchestrator/create", { id, name: "ember", repoPath: repo });
  const { run } = await request<{ run: { id: string } }>("orchestrator/start", {
    orchestrator: id,
    runId: uuidv7(),
    prompt: "Plan it.",
  });

  // The requests above went around the app's state, so it reads them anew.
  await page.reload();
  // Working's drawer holds it while it works, folded until opened (0075).
  const working = page.locator("#sidebar details").filter({ hasText: /^Working/ });
  await working.locator("summary").click();
  const row = page.locator('#sidebar li[data-kind="orchestrator"]').filter({ hasText: "ember" });
  await expect(row).toHaveCount(1);
  await row.hover();
  await row.getByRole("button", { name: "Orchestrator actions" }).click();
  const menu = page.getByRole("menu", { name: "Orchestrator actions" });
  for (const name of ["Pin to top", "Rename", "Archive", "Change icon…", "Autonomy…", "Delete…"])
    await expect(menu.getByRole("menuitem", { name, exact: true })).toBeVisible();
  const proof = process.env["PLX_PROOF_DIR"];
  if (proof) {
    // The popover opens with a transition.
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(proof, "orchestrator-menu.png") });
  }

  await menu.getByRole("menuitem", { name: "Pin to top" }).click();
  const threadOf = async () => {
    const { threads } = await request<{
      threads: { id: string; pinned?: boolean; archived?: boolean }[];
    }>("thread/list", {});
    return threads.find((t) => t.id === run.id);
  };
  await expect.poll(async () => (await threadOf())?.pinned).toBe(true);

  await row.hover();
  await row.getByRole("button", { name: "Orchestrator actions" }).click();
  await menu.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect.poll(async () => (await threadOf())?.archived).toBe(true);
  await expect(page.locator('#sidebar ul[aria-label="Threads"] li')).toHaveCount(0);
  if (proof) await page.screenshot({ path: path.join(proof, "orchestrator-archived.png") });
});
