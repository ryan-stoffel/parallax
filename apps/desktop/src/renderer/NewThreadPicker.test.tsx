// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Repo } from "../protocol/generated/protocol";
import { NewThreadPicker, type NewThreadPickerHandle } from "./NewThreadPicker";
import { pickerPrefs } from "./prefs";
import { noRepo, type OtherRepo } from "./threads";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { parallax: { platform: "darwin" } });
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
  this.dispatchEvent(new Event("close"));
};

const repo = (name: string): Repo =>
  ({ id: name, name, path: `/code/${name}`, createdAt: "2026-01-01T00:00:00Z" }) as Repo;
const repos = ["atlas", "beacon", "cobalt"].map(repo);

const scrolled = vi.fn();
let root: Root;
let handle: { current: NewThreadPickerHandle | null };
const onPick = vi.fn();
const onNewOrchestrator = vi.fn();

function render(
  lastUsed: [string, number][] = [],
  elsewhere: OtherRepo[] = [],
  several?: ReadonlySet<string>,
) {
  handle = createRef();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <NewThreadPicker
        ref={handle}
        groups={[
          ...repos.map((r) => ({ id: r.id, name: r.name })),
          { id: noRepo, name: "No repo" },
        ]}
        repos={repos}
        hostId="local"
        hostName="mini"
        elsewhere={elsewhere}
        several={several}
        lastUsed={new Map(lastUsed)}
        onPick={onPick}
        onPickElsewhere={vi.fn()}
        orchestrators={[
          { key: "local/o1", name: "photon", icon: null, hint: "main", open: vi.fn() },
        ]}
        onNewOrchestrator={onNewOrchestrator}
      />,
    ),
  );
  act(() => handle.current!.open());
}

const box = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const names = () =>
  [...document.querySelectorAll('[role="option"]')].map(
    (o) => o.querySelector(".text-reading")!.textContent,
  );
const activeName = () => document.querySelector("[data-active] .text-reading")!.textContent;
const press = (key: string) =>
  act(() => {
    box().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

beforeEach(() => {
  Element.prototype.scrollIntoView = scrolled;
  pickerPrefs.set({ order: "added", compact: false, orchestrators: true });
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

test("Up on the first row goes to the last and scrolls it into view, and Down wraps back", () => {
  render();
  expect(activeName()).toBe("atlas");
  press("ArrowUp");
  expect(activeName()).toBe("photon");
  expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
  press("ArrowDown");
  expect(activeName()).toBe("atlas");
});

test("a mouse move with no movement, as a scroll under a resting pointer sends, leaves the active row", () => {
  render();
  const row = document.querySelectorAll('[role="option"]')[2]!;
  const move = (movementX: number) =>
    act(() => {
      row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX }));
    });
  move(0);
  expect(activeName()).toBe("atlas");
  move(3);
  expect(activeName()).toBe("cobalt");
});

test("Tab switches to Orchestrator, where a repository starts one in it, without No repo", () => {
  render();
  press("Tab");
  expect(names()).toEqual(["atlas", "beacon", "cobalt", "photon"]);
  press("ArrowDown");
  act(() => {
    box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onNewOrchestrator).toHaveBeenCalledWith({ hostId: "local", repo: repos[1] });
  expect(onPick).not.toHaveBeenCalled();
});

test("open('orchestrator') starts there, and closing goes back to Thread", () => {
  render();
  act(() => handle.current!.open("orchestrator"));
  expect(names()).not.toContain("No repo");
  act(() => document.querySelector("dialog")!.close());
  expect(names()).toContain("No repo");
});

test("search finds a row by its path too, with name matches first", () => {
  render();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      box(),
      "code cobalt",
    );
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(names()).toEqual(["cobalt"]);
});

test("Recently used lists the repository last used first, with No repo last", () => {
  pickerPrefs.set({ order: "recent", compact: false, orchestrators: false });
  render([
    ["local/cobalt", 5],
    ["local/beacon", 9],
  ]);
  expect(names()).toEqual(["beacon", "cobalt", "atlas", "No repo"]);
});

test("Date added mixes other computers' repositories in by when they were added", () => {
  const older = { ...repo("dune"), createdAt: "2025-06-01T00:00:00Z" };
  render([], [{ host: { id: "mini", name: "mini" } as OtherRepo["host"], repo: older }]);
  expect(names()).toEqual(["dune", "atlas", "beacon", "cobalt", "No repo", "photon"]);
});

test("a repository on several computers shows as one project, with no computer or path (PLX-1498)", () => {
  render([], [], new Set(["beacon"]));
  const rows = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  expect(rows.slice(0, 3)).toEqual([
    "atlasmini · /code/atlas",
    "beacon",
    "cobaltmini · /code/cobalt",
  ]);
});

test("a repository used while the picker is open keeps its place until it opens again", () => {
  pickerPrefs.set({ order: "recent", compact: false, orchestrators: false });
  const picker = (used: [string, number][]) => (
    <NewThreadPicker
      ref={handle}
      groups={repos.map((r) => ({ id: r.id, name: r.name }))}
      repos={repos}
      hostId="local"
      elsewhere={[]}
      lastUsed={new Map(used)}
      onPick={onPick}
      onPickElsewhere={vi.fn()}
    />
  );
  handle = createRef();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(picker([])));
  act(() => handle.current!.open());
  act(() => root.render(picker([["local/cobalt", 9]])));
  expect(names()).toEqual(["atlas", "beacon", "cobalt"]);
  act(() => document.querySelector("dialog")!.close());
  act(() => handle.current!.open());
  expect(names()).toEqual(["cobalt", "atlas", "beacon"]);
});
