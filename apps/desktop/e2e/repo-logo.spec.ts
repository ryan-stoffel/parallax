import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { uuidv7 } from "../src/renderer/uuidv7";
import { close, launch, printFailure, type Launched } from "./launch";

// A repo with no icon takes its repository's own favicon or logo (PLX-1272), against a real plxd
// and a real renderer, since only those read the files and decode an SVG.

let launched: Launched | undefined;
test.afterEach(async () => {
  const { status, expectedStatus } = test.info();
  if (launched && status !== expectedStatus) await printFailure(launched);
  await close(launched);
});

const svg = (width: number, height: number, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`;

test("a repo takes its own logo, unless it has only a wordmark or none", async () => {
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

  const root = mkdtempSync(path.join(tmpdir(), "parallax-e2e-repo-"));
  const add = async (name: string, file?: string, contents?: string) => {
    const repo = path.join(root, name);
    mkdirSync(path.join(repo, "public"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    if (file) writeFileSync(path.join(repo, file), contents!);
    const { repo: entry } = await request<{ repo: { id: string } }>("repo/add", {
      id: uuidv7(),
      path: repo,
    });
    return entry.id;
  };
  const icons = async () => {
    const { repos } = await request<{
      repos: { name: string; icon?: { name: string; image?: { mediaType: string } } }[];
    }>("thread/list", {});
    return new Map(repos.map((r) => [r.name, r.icon]));
  };

  await add("wide", "logo.svg", svg(640, 64, "teal"));
  await add("plain");
  await add("favicon", "public/favicon.svg", svg(64, 64, "orange"));

  await expect
    .poll(async () => (await icons()).get("favicon")?.image?.mediaType)
    .toBe("image/webp");
  const after = await icons();
  expect(after.get("wide")).toBeUndefined();
  expect(after.get("plain")).toBeUndefined();

  // Each repo draws in the filter's menu, the image only for the one that has it.
  await page.getByRole("button", { name: "Showing All threads" }).click();
  const menu = page.getByRole("menu", { name: "Repos" });
  const row = (name: string) => menu.getByRole("menuitemradio", { name });
  await expect(row("favicon").locator("[data-icon-image]")).toBeVisible();
  await expect(row("plain").locator("[data-icon-image]")).toHaveCount(0);
  await expect(row("wide").locator("[data-icon-image]")).toHaveCount(0);
  const proof = process.env["PLX_PROOF_DIR"];
  if (proof) await page.screenshot({ path: path.join(proof, "repo-logo.png") });
});
