import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { close, launch, openThread, printFailure, type Launched } from "./launch";

// A read-only device (PLX-1364) on a real connection: two apps, each with its own fake-backend
// plxd. The laptop pairs with the mini through `plxd dial` over HTTPS, the mini's own app makes it
// read-only in Settings, and the laptop then reads the mini's thread and is refused a message and
// a terminal, and says why. A fake `tailscale` comes first on PATH, since an isolated data folder
// doesn't isolate the tailnet.

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

/** What host `id` answers `page` for `method`: its result, or the kind of its refusal. */
const ask = (page: Page, id: string, method: string, params: object) =>
  page.evaluate<{ result?: unknown; kind?: string }>(
    `window.parallax.request(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})
      .then((a) => ({ result: a.result, kind: a.error && (a.error.data?.kind ?? a.error.message) }))`,
  );

let mini: Launched | undefined;
let laptop: Launched | undefined;
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus)
    for (const each of [mini, laptop]) if (each) await printFailure(each);
  await close(laptop);
  await close(mini);
});

test("a read-only device reads the thread and is told why a message and a terminal are refused", async () => {
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const bin = fakeTailscale();
  const port = await freePort();
  process.env["PLXD_REMOTE_PORT"] = String(port);
  mini = await launch("web.json", bin);
  delete process.env["PLXD_REMOTE_PORT"];
  const host = mini.page;
  await connected(host, "local");
  const set = await host.evaluate(`window.parallax.request("local", "host/settings/set", {
    remote: true
  }).then(() => window.parallax.request("local", "accounts/defaults/set", {
    role: "worker", account: { kind: "subscription", backend: "fake" }
  }))`);
  expect(set).not.toHaveProperty("error");
  await host.getByRole("button", { name: "Profile", exact: true }).click();
  await host.getByRole("menuitem", { name: "Settings" }).click();
  await host.getByRole("button", { name: "Close settings" }).click();
  await host.getByRole("textbox", { name: "Message" }).fill("Add a README");
  await host.getByRole("button", { name: "Send", exact: true }).click();
  await expect(host.getByText("The fake agent is on it.")).toBeVisible();

  // The laptop pairs with the code the mini shows.
  await expect
    .poll(() =>
      host.evaluate(
        `window.parallax.request("local", "remote/sessions", {}).then((a) => a.result)`,
      ),
    )
    .toMatchObject({ listening: true });
  const code = await host.evaluate<string>(
    `window.parallax.request("local", "remote/pair", {}).then((a) => a.result.code)`,
  );
  laptop = await launch("web.json", bin);
  const device = laptop.page;
  await connected(device, "local");
  const target = JSON.stringify({ address: `127.0.0.1:${port}` });
  const failed = await device.evaluate(
    `window.parallax.pairLan(${target}, ${JSON.stringify(code)})`,
  );
  expect(failed).toBeUndefined();
  const hostId = await device.evaluate<string>(
    `window.parallax.hosts().then((hosts) => hosts.find((h) => h.routes).id)`,
  );
  await connected(device, hostId);
  expect((await ask(device, hostId, "host/settings/set", { autoResume: true })).kind).toBe(
    undefined,
  );

  // The mini's own app makes it read-only.
  await host.getByRole("button", { name: "Profile", exact: true }).click();
  await host.getByRole("menuitem", { name: "Settings" }).click();
  await host.getByRole("button", { name: "Connections" }).click();
  await host.getByRole("button", { name: "Make read-only" }).click();
  await expect(host.getByText(/This can't be undone/)).toBeVisible();
  await shot(host, "settings-confirm");
  await host.getByRole("button", { name: "Make read-only" }).click();
  await expect(host.getByText(/It reads threads and can't change anything/)).toBeVisible();
  await expect(host.getByRole("button", { name: "Make read-only" })).toHaveCount(0);
  await shot(host, "settings-read-only");

  // It reconnects read-only. These reach the mini over the connection, and the mini answers.
  await expect
    .poll(async () => (await ask(device, hostId, "host/settings/set", { autoResume: false })).kind)
    .toBe("readOnly");
  expect((await ask(device, hostId, "remote/pair", {})).kind).toBe("readOnly");
  const listed = await ask(device, hostId, "thread/list", {});
  expect((listed.result as { threads: unknown[] }).threads).toHaveLength(1);

  // The app shows the mini's thread.
  await openThread(device, /Add a README/);
  const transcript = device.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByText("The fake agent is on it.")).toBeVisible();

  // A message is refused, and a notification says why.
  const box = device.getByRole("textbox", { name: "Message", exact: true });
  await box.fill("Change the README");
  await box.press("Enter");
  const notice = device.getByLabel("Notifications");
  await expect(notice).toContainText("Couldn't send the message");
  await expect(notice).toContainText("This device is read-only on this computer");
  // A notice fades in, and a screenshot taken before that doesn't show it.
  await notice.evaluate(
    "(el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))",
  );
  await shot(device, "message-refused");

  // A terminal is refused, and says why in its panel. The notice goes first, as it's an alert too.
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(notice.getByRole("alert")).toHaveCount(0);
  await device.getByRole("button", { name: "Show terminal" }).click();
  await expect(device.getByRole("alert").filter({ hasText: "read-only" })).toBeVisible();
  await expect(device.getByRole("button", { name: "Restart" })).toBeVisible();
  await shot(device, "terminal-refused");

  // Revoked and paired again, it's a new key, and a write goes.
  await host.getByRole("button", { name: "Revoke" }).click();
  await expect(host.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  const again = await host.evaluate<string>(
    `window.parallax.request("local", "remote/pair", {}).then((a) => a.result.code)`,
  );
  expect(
    await device.evaluate(`window.parallax.pairLan(${target}, ${JSON.stringify(again)})`),
  ).toBeUndefined();
  await expect
    .poll(async () => (await ask(device, hostId, "host/settings/set", { autoResume: true })).kind)
    .toBe(undefined);
});
