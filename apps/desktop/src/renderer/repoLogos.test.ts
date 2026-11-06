import { describe, expect, it } from "vite-plus/test";

import type { ConnectionState } from "../preload/bridge";
import type { ChosenIcon, Repo } from "../protocol/generated/protocol";
import type { Host } from "./hosts";
import { logoPlacement } from "./images";
import { reposWantingLogo } from "./repoLogos";
import { emptyThreads, type ThreadsView } from "./threads";

const repo = (id: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  name: id,
  path: `/${id}`,
  createdAt: "2026-11-03T00:00:00Z",
  ...extra,
});
const view = (repos: Repo[], extra: Partial<ThreadsView> = {}) =>
  ({
    capabilities: { repoLogo: {} },
    iconImageBytes: 65536,
    state: { repos },
    ...extra,
  }) as unknown as ThreadsView;
const hosts = [{ id: "a" }] as Host[];
const icon: ChosenIcon = { name: "rocket" };
const ids = (v: ThreadsView, shared = new Map<string, ChosenIcon>(), tried = new Set<string>()) =>
  reposWantingLogo(hosts, { a: v }, [], shared, tried).map((r) => r.repo);

describe("reposWantingLogo", () => {
  it("takes only repositories with no icon, not chats, Projects, or tried ones", () => {
    const repos = [
      repo("bare"),
      repo("chosen", { icon }),
      repo("namesake"),
      repo("scratch", { scratch: true }),
      repo("project", { project: true }),
      repo("tried"),
    ];
    expect(ids(view(repos), new Map([["namesake", icon]]), new Set(["a/tried"]))).toEqual(["bare"]);
  });

  it("skips a computer whose plxd can't find logos or keep images", () => {
    expect(ids(view([repo("r")], { capabilities: {} }))).toEqual([]);
    expect(ids(view([repo("r")], { iconImageBytes: undefined }))).toEqual([]);
  });

  it("waits for every computer's first list, but not for an offline one", () => {
    const wanted = (other: ThreadsView | undefined, connection: ConnectionState["status"]) =>
      reposWantingLogo(
        [{ id: "a" }, { id: "b" }] as Host[],
        { a: view([repo("r")]), ...(other && { b: other }) },
        [undefined, { status: connection } as ConnectionState],
        new Map(),
        new Set(),
      ).map((r) => r.repo);
    const unlisted = view([], { state: emptyThreads });
    expect(wanted(undefined, "connecting")).toEqual([]);
    expect(wanted(unlisted, "connected")).toEqual([]);
    expect(wanted(view([], { loading: true }), "connected")).toEqual([]);
    expect(wanted(view([]), "connected")).toEqual(["r"]);
    expect(wanted(undefined, "failed")).toEqual(["r"]);
    expect(wanted({ ...unlisted, error: "no list" }, "connected")).toEqual(["r"]);
  });
});

describe("logoPlacement", () => {
  it("centers a non-square logo whole", () => {
    expect(logoPlacement(100, 50, 128)).toEqual({ x: 0, y: 32, width: 128, height: 64 });
  });

  it("refuses a wordmark and fills the square for an SVG with no size", () => {
    expect(logoPlacement(300, 100, 128)).toBeUndefined();
    expect(logoPlacement(0, 0, 128)).toEqual({ x: 0, y: 0, width: 128, height: 128 });
  });
});
