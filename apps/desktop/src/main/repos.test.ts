import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { githubSlug } from "../preload/bridge";
import { createRepo, expandHome, listFolders } from "./repos";

const temp = () => mkdtempSync(path.join(tmpdir(), "parallax-repos-"));

test("a slug is owner/name, from a URL too, and nothing that could leave its folder", () => {
  expect(githubSlug("ryan-stoffel/photon")).toBe("ryan-stoffel/photon");
  expect(githubSlug(" https://github.com/ryan-stoffel/photon.git ")).toBe("ryan-stoffel/photon");
  for (const bad of ["photon", "a/b/c", "../b", "a/..", "a b/c", "-/x;rm"])
    expect(githubSlug(bad), bad).toBeUndefined();
  expect(expandHome("~/Developer", "/home/me")).toBe(path.join("/home/me", "Developer"));
});

test("lists a folder's folders by name, linked ones included, and says why it can't", async () => {
  const dir = temp();
  for (const name of ["beta", "Alpha", ".hidden"]) mkdirSync(path.join(dir, name));
  writeFileSync(path.join(dir, "file.txt"), "");
  symlinkSync(path.join(dir, "beta"), path.join(dir, "linked"));
  const listing = await listFolders(dir);
  expect("folders" in listing && listing.folders.map((f) => f.name)).toEqual([
    ".hidden",
    "Alpha",
    "beta",
    "linked",
  ]);
  expect(await listFolders(path.join(dir, "missing"))).toEqual({
    error: `Can't open ${path.join(dir, "missing")}: ENOENT`,
  });
});

test("New Repository makes a repository with a first commit, once, and refuses a bad name", async () => {
  vi.stubEnv("GIT_AUTHOR_NAME", "parallax");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "parallax@localhost");
  vi.stubEnv("GIT_COMMITTER_NAME", "parallax");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "parallax@localhost");
  const home = temp();
  const made = await createRepo("photon", home);
  const dir = path.join(home, ".parallax", "projects", "photon");
  expect(made).toEqual({ path: dir });
  expect(execFileSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" })).toBe(
    "Initial commit\n",
  );
  expect(await createRepo("photon", home)).toEqual({
    error: "~/.parallax/projects/photon already exists",
  });
  expect(await createRepo("../escape", home)).toHaveProperty("error");
  vi.unstubAllEnvs();
});
