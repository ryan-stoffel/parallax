import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { close, launch, printFailure, type Launched } from "./launch";

// Move to another computer (PLX-1538) on a real connection: two apps, each with its own
// fake-backend plxd, the laptop paired with the mini through `plxd dial` as in read-only.spec.ts.
// The laptop moves its thread to the mini from the sidebar, and its follow-up runs there.

/** A port nothing listens on now, for the mini's remote listener. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A folder holding a `tailscale` that always fails. */
function fakeTailscale(): string {
  const bin = mkdtempSync(path.join(tmpdir(), "parallax-e2e-tailscale-"));
  const name = path.join(bin, process.platform === "win32" ? "tailscale.cmd" : "tailscale");
  writeFileSync(name, process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
  chmodSync(name, 0o755);
  return bin;
}

const connected = (page: Page, id: string) =>
  expect
    .poll(() =>
      page.evaluate(`window.parallax.connectionState(${JSON.stringify(id)}).then((s) => s.status)`),
    )
    .toBe("connected");

/** Makes the fake backend `page`'s host's default account. */
const fakeDefault = (page: Page) =>
  page.evaluate(`window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  })`);

let mini: Launched | undefined;
let laptop: Launched | undefined;
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus)
    for (const each of [mini, laptop]) if (each) await printFailure(each);
  await close(laptop);
  await close(mini);
});

test("a thread moves to another computer and its follow-up runs there", async () => {
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const bin = fakeTailscale();
  const port = await freePort();
  process.env["PLXD_REMOTE_PORT"] = String(port);
  mini = await launch("move-there.json", bin);
  delete process.env["PLXD_REMOTE_PORT"];
  await connected(mini.page, "local");
  expect(
    await mini.page.evaluate(`window.parallax.request("local", "host/settings/set", {
      remote: true, deviceName: "Mac mini"
    })`),
  ).not.toHaveProperty("error");
  await expect
    .poll(() =>
      mini!.page.evaluate(
        `window.parallax.request("local", "remote/sessions", {}).then((a) => a.result)`,
      ),
    )
    .toMatchObject({ listening: true });
  const code = await mini.page.evaluate<string>(
    `window.parallax.request("local", "remote/pair", {}).then((a) => a.result.code)`,
  );

  laptop = await launch("web.json", bin);
  const page = laptop.page;
  await connected(page, "local");
  expect(await fakeDefault(page)).not.toHaveProperty("error");
  const target = JSON.stringify({ address: `127.0.0.1:${port}` });
  expect(
    await page.evaluate(`window.parallax.pairLan(${target}, ${JSON.stringify(code)})`),
  ).toBeUndefined();
  const miniId = await page.evaluate<string>(
    `window.parallax.hosts().then((hosts) => hosts.find((h) => h.routes).id)`,
  );
  await connected(page, miniId);

  // A thread on the laptop, its turn done.
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Add a README");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("The fake agent is on it.")).toBeVisible();

  // Move to another computer, from its sidebar row.
  const row = page.locator("#sidebar li[data-kind='thread']").filter({ hasText: /Add a README/ });
  const move = page.getByRole("menuitem", { name: "Move to another computer…" });
  await expect(async () => {
    await row.first().hover();
    await row.first().getByRole("button", { name: "Thread actions" }).click();
    await expect(move).toBeEnabled({ timeout: 1000 });
  }).toPass();
  await move.click();
  const dialog = page.getByRole("dialog", { name: "Move to another computer" });
  await expect(dialog.getByRole("button", { name: "Move here" })).toBeEnabled();
  await shot(page, "pick");
  await dialog.getByRole("button", { name: "Move here" }).click();
  const done = page.getByRole("dialog", { name: /^Moved to / });
  await expect(done).toBeVisible();
  await shot(page, "moved");
  await done.getByRole("button", { name: "Open thread" }).click();

  // It's the mini's now, with the conversation, and archived here.
  const there = await page.evaluate<{ threads: { archived?: boolean }[] }>(
    `window.parallax.request(${JSON.stringify(miniId)}, "thread/list", {}).then((a) => a.result)`,
  );
  expect(there.threads).toHaveLength(1);
  const here = await page.evaluate<{ threads: { archived?: boolean }[] }>(
    `window.parallax.request("local", "thread/list", {}).then((a) => a.result)`,
  );
  expect(here.threads.map((t) => t.archived)).toEqual([true]);
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();

  // Its follow-up runs on the mini's agent.
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("Carry on");
  await box.press("Enter");
  await expect(transcript.getByText("Picked it up on this computer.")).toBeVisible();
  await shot(page, "continued");
});
