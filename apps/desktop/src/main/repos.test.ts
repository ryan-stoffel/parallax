import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, vi } from "vite-plus/test";

import { githubSlug } from "../preload/bridge";
import { createRepo } from "./repos";

const temp = () => mkdtempSync(path.join(tmpdir(), "parallax-repos-"));

test("a slug is owner/name, from a URL too, and nothing that could leave its folder", () => {
  expect(githubSlug("ryan-stoffel/photon")).toBe("ryan-stoffel/photon");
  // Links and clone URLs, as pasted from a browser or GitHub's Code menu (PLX-1009).
  for (const link of [
    " https://github.com/ryan-stoffel/photon.git ",
    "http://www.github.com/ryan-stoffel/photon/",
    "github.com/ryan-stoffel/photon",
    "https://github.com/ryan-stoffel/photon/tree/main/src?tab=readme#install",
    "https://github.com/ryan-stoffel/photon#readme",
    "git@github.com:ryan-stoffel/photon.git",
    "ssh://git@github.com/ryan-stoffel/photon.git",
  ])
    expect(githubSlug(link), link).toBe("ryan-stoffel/photon");
  for (const bad of [
    "photon",
    "a/b/c",
    "../b",
    "a/..",
    "a b/c",
    "-/x;rm",
    "https://github.com/ryan-stoffel",
    "github.com/ryan-stoffel",
    "www.github.com/ryan-stoffel/",
    "https://gitlab.com/ryan-stoffel/photon",
  ])
    expect(githubSlug(bad), bad).toBeUndefined();
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
