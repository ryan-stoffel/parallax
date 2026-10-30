import { expect, test } from "vite-plus/test";

import type { AgentRun, Project, Repo, Thread } from "../protocol/generated/protocol";
import type { Draft } from "./drafts";
import type { Host } from "./hosts";
import {
  dayOf,
  draftItems,
  folderGroups,
  sidebarItems,
  todayGroups,
  type HostThreads,
} from "./sidebarItems";
import { emptyThreads, type ThreadsView } from "./threads";

const repo = (id: string, name: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  name,
  path: `/src/${name}`,
  createdAt: "2026-10-01T09:00:00Z",
  ...extra,
});
const zeta = repo("r-zeta", "zeta");
const alpha = repo("r-alpha", "Alpha");
const scratch = repo("r-scratch", "scratch", { scratch: true });
const essays = repo("s-essays", "Essays", { space: true });
const thread = (
  id: string,
  repoId: string,
  minutes: number,
  extra: Partial<Thread> = {},
): Thread => ({
  id,
  repo: repoId,
  createdAt: new Date(Date.parse("2026-10-29T12:00:00Z") - minutes * 60_000).toISOString(),
  ...extra,
});
const host = (id: string): Host => ({ id, name: id === "local" ? "This Mac" : "Studio" }) as Host;
const listed = (
  id: string,
  repos: Repo[],
  threads: Thread[],
  extra: { projects?: Project[]; runs?: Record<string, AgentRun> } = {},
): HostThreads => ({
  host: host(id),
  view: {
    state: {
      ...emptyThreads,
      repos,
      threads,
      projects: extra.projects ?? [],
      runs: extra.runs ?? {},
    },
    capabilities: {},
  } as unknown as ThreadsView,
});

test("sidebarItems lists threads and Projects with their repo, keeps a Project's threads inside it, and reads a marked-unread finished thread as done", () => {
  const project: Project = {
    id: "p-ember",
    name: "ember",
    repoPath: zeta.path,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-29T11:00:00Z",
  } as Project;
  const runs = {
    "t-done": {
      id: "t-done",
      status: "completed",
      updatedAt: "2026-10-29T11:30:00Z",
      branch: "fix/flaky",
      pullRequests: ["https://github.com/acme/zeta/pull/12"],
    },
    "t-child": { id: "t-child", status: "running", project: "p-ember" },
  } as unknown as Record<string, AgentRun>;
  const seen = { seenAt: "2026-10-29T12:00:00Z" };
  const items = sidebarItems(
    [
      listed(
        "local",
        [zeta],
        [thread("t-done", zeta.id, 30, seen), thread("t-child", zeta.id, 10)],
        { projects: [project], runs },
      ),
    ],
    ["local/t-done"],
  );
  expect(items.map((i) => [i.kind, i.key, i.repo?.name])).toEqual([
    ["thread", "local/t-done", "zeta"],
    ["project", "local/p-ember", "zeta"],
  ]);
  expect(items[0]!.attention).toBe("done");
  expect(items[0]!.text).toBe("Thread zeta fix/flaky #12");
});

test("draftItems keeps drafts on listed hosts in scope that hold every word, keyed apart from rows", () => {
  const draft = (id: string, hostId: string, groupId: string, text: string) =>
    ({ id, hostId, groupId, text, doc: {}, images: [], files: [], threads: [] }) as Draft;
  const hosts = [listed("local", [zeta, scratch], [])];
  const list = [
    draft("d1", "local", zeta.id, "Fix the flaky test"),
    draft("d2", "local", scratch.id, "Tidy the README"),
    draft("d3", "gone", zeta.id, "On a computer no longer listed"),
  ];
  expect(draftItems(list, hosts, "all", []).map((d) => d.key)).toEqual(["draft:d1", "draft:d2"]);
  expect(draftItems(list, hosts, "none", []).map((d) => d.key)).toEqual(["draft:d2"]);
  expect(draftItems(list, hosts, "repo:local/r-zeta", []).map((d) => d.key)).toEqual(["draft:d1"]);
  expect(draftItems(list, hosts, "all", ["flaky", "fix"]).map((d) => d.key)).toEqual(["draft:d1"]);
});

test("folderGroups makes a folder per host and repo, by name, puts a Space's added threads under it, and No repo last", () => {
  const hosts = [
    listed(
      "local",
      [zeta, alpha, scratch, essays],
      [
        thread("t-1", zeta.id, 1),
        thread("t-2", scratch.id, 2),
        thread("t-3", alpha.id, 3),
        thread("t-4", zeta.id, 4, { space: essays.id }),
        thread("t-5", zeta.id, 5),
      ],
    ),
  ];
  const rows = sidebarItems(hosts, []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const folders = folderGroups(rows, false);
  expect(folders.map((f) => [f.key, f.label, f.host, f.rows.map((i) => i.key)])).toEqual([
    ["local/r-alpha", "Alpha", undefined, ["local/t-3"]],
    ["local/s-essays", "Essays", undefined, ["local/t-4"]],
    ["local/r-zeta", "zeta", undefined, ["local/t-1", "local/t-5"]],
    ["local/none", "No repo", undefined, ["local/t-2"]],
  ]);
  // Newer work in a folder doesn't move it.
  const newer = sidebarItems(
    [listed("local", [zeta, alpha], [thread("t-3", alpha.id, 1), thread("t-1", zeta.id, 0)])],
    [],
  );
  expect(folderGroups(newer, false).map((f) => f.label)).toEqual(["Alpha", "zeta"]);
});

test("folderGroups names the computer only when there are several, keeping same-named repos apart", () => {
  const rows = sidebarItems(
    [
      listed("local", [zeta], [thread("t-1", zeta.id, 1)]),
      listed("studio", [repo("r-zeta-2", "zeta")], [thread("t-2", "r-zeta-2", 2)]),
    ],
    [],
  );
  expect(folderGroups(rows, true).map((f) => [f.key, f.label, f.host])).toEqual([
    ["studio/r-zeta-2", "zeta", "Studio"],
    ["local/r-zeta", "zeta", "This Mac"],
  ]);
});

test("todayGroups groups by repo or day where each group's newest row falls", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const rows = sidebarItems(
    [
      listed(
        "local",
        [zeta, alpha],
        [
          thread("t-1", zeta.id, 5),
          thread("t-2", alpha.id, 10),
          thread("t-3", zeta.id, 60 * 24 * 2),
        ],
      ),
    ],
    [],
  ).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  expect(todayGroups(rows, "repo", now, false).map((g) => [g.label, g.rows.length])).toEqual([
    ["zeta", 2],
    ["Alpha", 1],
  ]);
  expect(todayGroups(rows, "day", now, false).map((g) => [g.key, g.rows.length])).toEqual([
    ["Today", 2],
    ["Earlier this week", 1],
  ]);
  expect(dayOf("2026-10-28T12:00:00Z", now)).toBe("Yesterday");
});
