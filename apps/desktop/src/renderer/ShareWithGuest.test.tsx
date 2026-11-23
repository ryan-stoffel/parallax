// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { GuestLink } from "../protocol/generated/protocol";
import { useGuestLink } from "./guestLinks";
import { GuestSuggestions } from "./GuestSuggestions";
import { ShareWithGuest } from "./ShareWithGuest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.showPopover = () => {};
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};

const thread = "thread-1";
const link: GuestLink = {
  id: "link-1",
  threadId: thread,
  createdAt: "2026-11-23T00:00:00Z",
  expiresAt: "2026-11-24T00:00:00Z",
};
// What plxd lists, whether its `hostedClient` is on, and what the bridge was asked.
let links: GuestLink[] = [];
let hostedClient = true;
/** Holds `guest/list`'s answers back while set, and lets them go when called. */
let release: (() => void) | undefined;
const request = vi.fn(async (_host: string, method: string, params: { suggestion?: string }) => {
  if (method === "host/settings/get") return { result: { hostedClient }, logId: "log" };
  if (method === "guest/list" && release)
    await new Promise<void>((resolve) => {
      const before = release!;
      release = () => (before(), resolve());
    });
  if (method === "guest/revoke") links = [];
  if (method === "guest/send" || method === "guest/dismiss")
    links = links.map((each) => ({
      ...each,
      suggestions: each.suggestions?.filter((s) => s.id !== params.suggestion) ?? [],
    }));
  return { result: { links }, logId: "log" };
});
const shareWithGuest = vi.fn(async (_host: string, _thread: string, canSuggest: boolean) => {
  const made = { ...link, ...(canSuggest && { canSuggest }) };
  links = [made];
  return made;
});
const copyGuestLink = vi.fn(async () => true);
const forgetGuestLink = vi.fn(async () => {});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  links = [];
  hostedClient = true;
  release = undefined;
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function render(node: React.ReactNode) {
  window.parallax = {
    request: request as unknown as ParallaxBridge["request"],
    shareWithGuest,
    copyGuestLink,
    forgetGuestLink,
  } as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(node));
  await act(async () => {});
}
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
const click = async (element: Element) => {
  await act(async () => (element as HTMLElement).click());
  await act(async () => {});
};
const lists = () => request.mock.calls.filter(([, method]) => method === "guest/list").length;

test("sharing says what a guest sees, makes a link with suggestions off, copies it once, and stops", async () => {
  // Each test uses its own host, since a host's links are kept between renders.
  await render(<ShareWithGuest hostId="share" runId={thread} onClose={() => {}} />);
  const said = () => document.querySelector("dialog")!.textContent;
  expect(said()).toContain(
    "A guest sees everything in this thread's transcript, including what the agent read or printed.",
  );
  const suggest = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(suggest.closest("label")?.textContent).toBe("Guest can suggest messages");
  expect(suggest.checked).toBe(false);
  // Cancel has the focus, not Create link.
  expect(document.activeElement).toBe(button("Cancel"));

  await click(button("Create link"));
  expect(shareWithGuest).toHaveBeenCalledWith("share", thread, false);
  expect(said()).toContain("Expires");
  expect(said()).toContain("OpenedNot yet");
  expect(said()).toContain("Copy the link now.");

  // Copy link asks main to copy it. The window never holds the link itself.
  await click(button("Copy link"));
  expect(copyGuestLink).toHaveBeenCalledWith(link.id);
  expect(button("Copied").disabled).toBe(true);
  expect(said()).toContain("To get one again, stop sharing and create a new one.");

  await click(button("Stop sharing"));
  expect(request).toHaveBeenCalledWith("share", "guest/revoke", { link: link.id });
  expect(button("Create link")).toBeDefined();
});

test("nothing is offered until plxd lists the links, and a live link keeps the focus off Stop sharing", async () => {
  links = [{ ...link, boundAt: "2026-11-23T01:30:00Z", canSuggest: true }];
  release = () => {};
  await render(<ShareWithGuest hostId="opened" runId={thread} onClose={() => {}} />);
  // A new link would end the live one, so there's no Create link while it isn't known.
  expect(button("Create link")).toBeUndefined();
  expect(button("Stop sharing")).toBeUndefined();
  const answer = release;
  release = undefined;
  await act(async () => answer());
  await act(async () => {});

  const said = document.querySelector("dialog")!.textContent;
  const opened = new Date("2026-11-23T01:30:00Z").toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  expect(said).toContain(`Opened${opened}`);
  expect(said).toContain("Guest can suggest messages");
  // This window didn't make the link, so there's nothing to copy, and Enter only closes.
  expect(button("Copy link")).toBeUndefined();
  expect(button("Create link")).toBeUndefined();
  expect(document.activeElement).toBe(button("Done"));
  expect(request).not.toHaveBeenCalledWith("opened", "guest/revoke", expect.anything());
});

test("a link made elsewhere since the last read is shown, not replaced", async () => {
  await render(<ShareWithGuest hostId="raced" runId={thread} onClose={() => {}} />);
  links = [link];
  await click(button("Create link"));
  expect(shareWithGuest).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "This thread is already shared. Stop sharing to create a new link.",
  );
  expect(button("Stop sharing")).toBeDefined();
});

test("with Parallax on the web off, the dialog says why and Create link is off", async () => {
  hostedClient = false;
  await render(<ShareWithGuest hostId="off" runId={thread} onClose={() => {}} />);
  expect(document.querySelector("dialog")!.textContent).toContain(
    "Parallax on the web is off on this thread's computer.",
  );
  expect(button("Create link").disabled).toBe(true);
  expect(document.querySelector('input[type="checkbox"]')).toBeNull();
});

test("closing a dialog with an uncopied link forgets its secret", async () => {
  await render(<ShareWithGuest hostId="closed" runId={thread} onClose={() => {}} />);
  await click(button("Create link"));
  act(() => root?.unmount());
  root = undefined;
  expect(forgetGuestLink).toHaveBeenLastCalledWith(link.id);
});

test("a thread's links are still read on the timer after it renders again", async () => {
  vi.useFakeTimers();
  let again = () => {};
  function Thread() {
    const [, setCount] = useState(0);
    again = () => setCount((n) => n + 1);
    return <p>{useGuestLink("timer", thread, true)?.id ?? "none"}</p>;
  }
  await render(<Thread />);
  expect(lists()).toBe(1);
  // A render with nothing changed, as a transcript's every event makes.
  await act(async () => again());
  await act(async () => again());
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(lists()).toBe(2);
  // A link made on another device shows, and is then read more often.
  links = [link];
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(document.body.textContent).toBe(link.id);
  await act(async () => again());
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(lists()).toBe(4);
  // Nothing reads once it's gone.
  act(() => root?.unmount());
  root = undefined;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(lists()).toBe(4);
});

test("a guest's messages show whole, and Send or Dismiss answers each", async () => {
  const waiting = {
    ...link,
    canSuggest: true,
    suggestions: [
      { id: "t1", text: "Also check the\nWindows build", at: "2026-11-23T01:00:00Z" },
      { id: "t2", text: "Thanks!", at: "2026-11-23T01:01:00Z" },
    ],
  };
  links = [waiting];
  await render(<GuestSuggestions hostId="strip" link={waiting} />);
  const rows = () => [...document.querySelectorAll("li")];
  expect(rows().map((row) => row.textContent)).toEqual([
    "Also check the\nWindows build",
    "Thanks!",
  ]);

  await click(rows()[0]!.querySelector('button[aria-label="Send"]')!);
  expect(request).toHaveBeenLastCalledWith("strip", "guest/send", {
    link: link.id,
    suggestion: "t1",
  });
  await click(rows()[1]!.querySelector('button[aria-label="Dismiss"]')!);
  expect(request).toHaveBeenLastCalledWith("strip", "guest/dismiss", {
    link: link.id,
    suggestion: "t2",
  });
});
