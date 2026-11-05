// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { ThreadDetails, useThreadDetails } from "./ThreadDetails";
import {
  moveCard,
  resetThreadDetails,
  toggleItem,
  useThreadDetailsPrefs,
} from "./threadDetailsItems";
import type { ParallaxBridge } from "../preload/bridge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount = () => {};
function show(node: React.ReactNode) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(node));
  unmount = () => {
    root.unmount();
    host.remove();
  };
  return host;
}

beforeEach(() => {
  resetThreadDetails();
  window.parallax = {
    platform: "darwin",
    openTargets: async () => [],
    terminalApps: async () => [],
    sshDestination: async () => undefined,
  } as Partial<ParallaxBridge> as ParallaxBridge;
});
afterEach(() => {
  act(() => unmount());
  localStorage.clear();
});

const details = (
  <ThreadDetails
    mode="docked"
    host={{ id: "local", name: "macbook" }}
    folder="/Users/me/repo"
    usage={{
      context: "42%",
      contextUsed: 42,
      contextDetail: "84K / 200K",
      contextTitle: "",
      cacheTitle: "",
      speedTitle: "",
      summary: { used: 42, label: "42% of context used", tone: "normal" },
    }}
  />
);
const visibleSections = (body: HTMLElement) =>
  [...body.querySelectorAll<HTMLElement>("aside section:not([hidden])")].map((s) =>
    s.getAttribute("aria-label"),
  );

test("shows the thread's context in its own card, which the menu can turn off", () => {
  const body = show(details);
  expect(visibleSections(body)).toEqual(["Workspace", "Context"]);
  expect(body.querySelector('section[aria-label="Context"]')!.textContent).toContain("84K / 200K");
  const option = [...body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
    (o) => o.textContent === "Context",
  )!;
  expect(option.getAttribute("aria-checked")).toBe("true");
  act(() => option.click());
  expect(visibleSections(body)).toEqual(["Workspace"]);
  expect(option.getAttribute("aria-checked")).toBe("false");
});

test("the workspace card goes with its last item, and the sliders stay to bring it back", () => {
  const body = show(details);
  act(() => {
    for (const item of ["environment", "openIn", "actions", "project"] as const) toggleItem(item);
  });
  expect(visibleSections(body)).toEqual(["Context"]);
  expect(body.querySelector('[aria-label="Customize Thread details"]')).not.toBeNull();
});

test("a moved card keeps its place, and collapsing it keeps its heading", () => {
  const position = () => {
    let at = 0;
    function Probe() {
      at = useThreadDetailsPrefs().position("lineage");
      return null;
    }
    const probe = show(<Probe />);
    probe.remove();
    return at;
  };
  expect(position()).toBe(4);
  act(() => moveCard("lineage", "git"));
  expect(position()).toBe(1);
  const body = show(details);
  const heading = body.querySelector<HTMLElement>('section[aria-label="Context"] button')!;
  act(() => heading.click());
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(body.querySelector('section[aria-label="Context"] > div')!.hasAttribute("hidden")).toBe(
    true,
  );
});

test("floating, the customize menu stays inside what takes clicks", () => {
  const body = show(details);
  const menu = body.querySelector('[role="menu"][aria-label="Show in Thread details"]')!;
  expect(menu.closest(".pointer-events-auto")).not.toBeNull();
});

test("a destination saved after being asked for still opens what asked", async () => {
  const opened: (string | undefined)[] = [];
  let destination: string | undefined;
  // Answers a task later, as IPC does, so the dialog's close event runs first.
  const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));
  Object.assign(window.parallax, {
    openTargets: async () => [{ target: "terminal", name: "Ghostty" }],
    sshDestination: () => later(destination),
    setSshDestination: async (_host: string, value: string) => {
      destination = value;
    },
    openFolder: async () => {
      opened.push(destination);
      return destination ? undefined : "noDestination";
    },
  });
  const body = show(
    <ThreadDetails mode="docked" host={{ id: "lan:x", name: "mini" }} folder="/Users/me/repo" />,
  );
  await act(async () => {
    await later(0);
    await later(0);
  });
  const terminal = [...body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Open in Ghostty"),
  )!;
  await act(async () => {
    terminal.click();
    await later(0);
  });
  expect(opened).toEqual([undefined]);
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="SSH destination"]')!;
  const input = dialog.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "me@mini",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    dialog
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await later(0);
    // What closing the dialog queues, while the destination is still on its way.
    dialog.dispatchEvent(new Event("close"));
    await later(0);
    await later(0);
  });
  expect(opened).toEqual([undefined, "me@mini"]);
});

test("a card takes the place of the one it's dropped on, in either direction", () => {
  const order = () => {
    const at = { git: 0, prs: 0, context: 0, lineage: 0 };
    function Probe() {
      const { position } = useThreadDetailsPrefs();
      for (const card of ["git", "prs", "context", "lineage"] as const) at[card] = position(card);
      return null;
    }
    show(<Probe />).remove();
    return (Object.keys(at) as (keyof typeof at)[]).sort((a, b) => at[a] - at[b]);
  };
  act(() => moveCard("git", "prs"));
  expect(order()).toEqual(["prs", "git", "context", "lineage"]);
  act(() => moveCard("prs", "lineage"));
  expect(order()).toEqual(["git", "context", "lineage", "prs"]);
  act(() => moveCard("prs", "git"));
  expect(order()).toEqual(["prs", "git", "context", "lineage"]);
});

test("the destination dialog isn't inside the panel, which can be hidden when it asks", () => {
  show(
    <ThreadDetails mode="hidden" host={{ id: "lan:x", name: "mini" }} folder="/Users/me/repo" />,
  );
  const dialog = document.querySelector('dialog[aria-label="SSH destination"]')!;
  expect(dialog.closest("[hidden]")).toBeNull();
  expect(dialog.closest("aside")).toBeNull();
});

test("a Remote Control thread still has the customize button", () => {
  const body = show(
    <ThreadDetails
      mode="docked"
      host={{ id: "local", name: "macbook" }}
      remoteControl={{ session: undefined }}
    />,
  );
  expect(body.querySelector('[aria-label="Customize Thread details"]')).not.toBeNull();
});

test("a close from an earlier render doesn't reopen a panel the user closed since", () => {
  let hook!: ReturnType<typeof useThreadDetails>;
  function Probe() {
    hook = useThreadDetails("a");
    return null;
  }
  show(<Probe />);
  act(() => hook.toggle());
  const fromWhenItWasOpen = hook.close;
  act(() => hook.close());
  act(() => fromWhenItWasOpen());
  expect(hook.mode).toBe("hidden");
});

test("close hides the panel for its thread, and only when it's shown", () => {
  let hook!: ReturnType<typeof useThreadDetails>;
  function Probe() {
    hook = useThreadDetails("a");
    return null;
  }
  show(<Probe />);
  act(() => hook.close());
  expect(hook.mode).toBe("hidden");
  act(() => hook.toggle());
  expect(hook.mode).not.toBe("hidden");
  act(() => hook.close());
  expect(hook.mode).toBe("hidden");
});
