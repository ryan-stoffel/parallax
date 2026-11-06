// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import samples from "../../../../crates/parallax-protocol/samples/v1/agents.json";
import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun, GitStatus, LoggedEvent } from "../protocol/generated/protocol";
import { gitActions, GitMenu, syncBrief, syncText } from "./GitMenu";
import { Notifications } from "./notifications";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers. The menu is in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
HTMLElement.prototype.showPopover = () => {};

const logged = (samples as { method?: string; params?: unknown }[])
  .filter((m) => m.method === "events/event")
  .map((m) => m.params as LoggedEvent);
// The sample's run, as it started (running, in a worktree, with no commit yet).
const started = (logged[0]!.event as { run: AgentRun }).run;
const finished: AgentRun = {
  ...started,
  status: "completed",
  diff: { commit: "abc", files: 1, insertions: 1, deletions: 0 },
};
const clean: GitStatus = {
  branch: "parallax/readme",
  changes: 0,
  insertions: 0,
  deletions: 0,
  upstream: "origin/parallax/readme",
  ahead: 0,
  origin: true,
};

test("the main action is the next useful one, and the others are off when they can't run", () => {
  // The actions that can't run, and the main one.
  const plan = (run: AgentRun, status: GitStatus, openPr = true) => {
    const { why, main } = gitActions(run, status, openPr);
    return { off: Object.keys(why).sort(), main };
  };
  expect(plan(started, clean)).toEqual({ off: ["commit", "pr", "push"], main: "commit" });
  expect(plan(finished, { ...clean, changes: 2 })).toEqual({ off: ["push"], main: "commit" });
  expect(plan(finished, { ...clean, ahead: 1 }).main).toBe("push");
  expect(plan(finished, clean)).toEqual({ off: ["commit", "push"], main: "pr" });
  // A worktree run with no commit has no pull request to open, nor does a plxd without openPr.
  expect(plan({ ...finished, diff: undefined }, clean).off).toContain("pr");
  expect(plan(finished, clean, false).off).toContain("pr");
  expect(plan(finished, { ...clean, origin: false }).off).toEqual(["commit", "pr", "push"]);
  // An open pull request already covers the branch.
  expect(gitActions(finished, clean, true, true).why.pr).toBe("A pull request is already open");
  expect(plan(finished, { ...clean, branch: null, changes: 1 })).toEqual({
    off: ["pr", "push"],
    main: "commit",
  });
});

test("says where the branch stands in words", () => {
  expect(syncText(clean)).toBe("No uncommitted changes · Up to date with origin/parallax/readme");
  expect(syncText({ ...clean, changes: 3, ahead: 1 })).toBe(
    "3 uncommitted files · 1 commit to push",
  );
  expect(syncText({ ...clean, upstream: null })).toBe("No uncommitted changes · Not pushed yet");
  expect(syncText({ ...clean, origin: false, changes: 1 })).toBe(
    "1 uncommitted file · No origin remote",
  );
  // Beside the branch, in fewer words.
  expect(syncBrief(clean)).toBe("Synced");
  expect(syncBrief({ ...clean, changes: 3, ahead: 1 })).toBe("3 uncommitted · 1 to push");
  expect(syncBrief({ ...clean, upstream: null })).toBe("Not pushed");
  expect(syncBrief({ ...clean, branch: null })).toBe("Clean");
});

/** A bridge whose plxd has `capabilities` and answers the Git methods with `answers`. */
function fakeBridge(
  capabilities: Record<string, object>,
  answers: Record<string, () => object> = {},
) {
  const request = vi.fn(async (_host: string, method: string) => {
    const answer = answers[method];
    return answer ? { ...answer(), logId: "log-1" } : { result: {}, logId: "log-1" };
  });
  window.parallax = {
    platform: "darwin",
    connectionState: async () => ({
      status: "connected",
      plxd: "0.1.0",
      protocol: 1,
      capabilities,
    }),
    onConnectionState: () => () => {},
    request,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  return request;
}

let root: Root | undefined;
afterEach(() => {
  // Notifications outlive a render, so close this test's.
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Notifications"] button[aria-label="Close"]',
  ))
    act(() => close.click());
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};

async function render(run: AgentRun) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root!.render(
      <>
        <GitMenu hostId="local" run={run} />
        <Notifications />
      </>,
    ),
  );
  await settle();
}

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name);
const item = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    b.textContent?.startsWith(name),
  )!;

test("Commit asks for a message prefilled from the title, then the menu shows the new status", async () => {
  let status = { ...clean, changes: 2 };
  const request = fakeBridge(
    { git: {}, openPr: {} },
    {
      "agent/gitStatus": () => ({ result: status }),
      "agent/commit": () => ({ result: (status = { ...clean, ahead: 1 }) }),
    },
  );
  await render(finished);
  expect(request).toHaveBeenCalledWith("local", "agent/gitStatus", { runId: finished.id });
  expect(item("Push").disabled).toBe(true);

  await act(async () => button("Commit")!.click());
  const message = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Commit message"]',
  )!;
  expect(message.value).toBe("Add a README that explains how to build the app.");
  await act(async () => document.querySelector("form")!.requestSubmit());
  expect(request).toHaveBeenCalledWith("local", "agent/commit", {
    runId: finished.id,
    message: "Add a README that explains how to build the app.",
  });
  // Committed: Push is next.
  expect(button("Push")).toBeDefined();
  expect(item("Commit").disabled).toBe(true);
});

test("new repository status requires its own capability and never enables writes", async () => {
  const request = fakeBridge(
    { repoGitStatus: {} },
    {
      "repo/gitStatus": () => ({ result: { ...clean, insertions: 715, deletions: 4 } }),
    },
  );
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<GitMenu hostId="local" repo="repo-1" />));
  await settle();
  expect(request).toHaveBeenCalledWith("local", "repo/gitStatus", { repo: "repo-1" });
  expect(document.body.textContent).toContain("+715 −4");
  for (const action of ["Commit", "Push", "Create PR"]) expect(item(action).disabled).toBe(true);
});

test("a failed refresh clears stale status and turns every action off", async () => {
  let missing = false;
  fakeBridge(
    { git: {} },
    {
      "agent/gitStatus": () =>
        missing
          ? {
              error: {
                code: -32000,
                message: "Missing /full/recorded/path",
                data: { kind: "worktreeMissing" },
              },
            }
          : { result: { ...clean, changes: 1, insertions: 12, deletions: 3 } },
    },
  );
  await render(finished);
  expect(document.body.textContent).toContain("+12 −3");
  missing = true;
  await render({ ...finished, diff: { ...finished.diff!, commit: "changed" } });
  expect(document.body.textContent).not.toContain("+12");
  for (const action of ["Commit", "Push", "Create PR"]) expect(item(action).disabled).toBe(true);
});

test("switching repositories clears status and ignores the previous request", async () => {
  fakeBridge({ repoGitStatus: {} });
  let previous: (answer: unknown) => void = () => {};
  window.parallax.request = vi.fn((_host, _method, params) =>
    params?.repo === "repo-1"
      ? new Promise((resolve) => {
          previous = resolve;
        })
      : Promise.resolve({ result: { ...clean, branch: "second", insertions: 2 }, logId: "log-1" }),
  ) as ParallaxBridge["request"];
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<GitMenu hostId="local" repo="repo-1" />));
  await settle();
  await act(async () => root!.render(<GitMenu hostId="local" repo="repo-2" />));
  await settle();
  await act(async () =>
    previous({ result: { ...clean, branch: "first", insertions: 100 }, logId: "log-1" }),
  );
  expect(document.body.textContent).toContain("second");
  expect(document.body.textContent).toContain("+2 −0");
  expect(document.body.textContent).not.toContain("first");
});
