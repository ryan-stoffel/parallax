// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { AgentRun } from "../protocol/generated/protocol";
import { Favorites, type Favorite } from "./Favorites";
import { projectStatus } from "./Sidebar";
import { emptyThreads, type ThreadsState } from "./threads";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const run = (id: string, status: AgentRun["status"]) => ({ id, status }) as AgentRun;

test("a Project works while any run does, and counts the runs waiting on an approval", () => {
  const state = {
    ...emptyThreads,
    approvals: { a: { items: [{}, {}] }, b: { items: [{}] } },
  } as unknown as ThreadsState;
  expect(
    projectStatus(state, [run("a", "completed"), run("b", "running"), run("c", "failed")]),
  ).toEqual({
    working: true,
    waiting: 2,
  });
  expect(projectStatus(emptyThreads, [run("c", "completed")])).toEqual({
    working: false,
    waiting: 0,
  });
});

let unmount = () => {};
afterEach(() => act(() => unmount()));

test("a Project's square shows its working ring and waiting count in place of a dot", () => {
  window.parallax = { platform: "darwin" } as Partial<ParallaxBridge> as ParallaxBridge;
  const favorite = (key: string, project: Favorite["project"]): Favorite => ({
    key,
    kind: "project",
    title: key,
    icon: null,
    attention: "needsYou",
    project,
    selected: false,
  });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <Favorites
        items={[
          favorite("busy", { working: true, waiting: 2 }),
          favorite("quiet", { working: false, waiting: 0 }),
        ]}
        onOpen={() => {}}
        onAdd={() => {}}
        onPinRow={() => {}}
        onRemove={() => {}}
      />,
    ),
  );
  unmount = () => {
    root.unmount();
    document.body.innerHTML = "";
  };
  const [busy, quiet] = [...document.querySelectorAll<HTMLButtonElement>("button[data-row]")];
  expect(busy!.getAttribute("aria-description")).toBe("working, 2 waiting on you");
  expect(busy!.querySelector(".mark-working")).not.toBeNull();
  expect(busy!.textContent).toBe("2");
  expect(quiet!.getAttribute("aria-description")).toBeNull();
  expect(quiet!.querySelector(".mark-working, .dot-in")).toBeNull();
});
