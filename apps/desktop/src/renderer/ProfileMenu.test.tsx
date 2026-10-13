// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { DeviceHost, ParallaxBridge, Profile } from "../preload/bridge";
import { ProfileButton } from "./ProfileMenu";

// The Account dialog's hosts: this computer alone, with Parallax Connect on.
vi.mock("./hosts", () => ({
  localId: "local",
  useHosts: () => [{ id: "local", name: "MacBook" }],
  useConnect: () => ({ on: true }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// happy-dom has no popovers or modal dialogs. The menu is in the DOM either way.
HTMLElement.prototype.hidePopover = () => {};
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

/** Renders the button with `profile` published, and returns the bridge's account calls. */
function render(profile: Profile | null) {
  let publish = (_profile: Profile | null) => {};
  const calls = {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => {}),
    editProfile: vi.fn(async (_page?: "security") => {}),
    removeDevice: vi.fn(async (_hostId: string) => {}),
  };
  window.parallax = {
    ...calls,
    platform: "darwin",
    version: async () => "2610.11213.10000",
    // Never connected, so the dialog asks no host for usage.
    onConnectionState: () => () => {},
    connectionState: () => new Promise(() => {}),
    onDevices: (listener: (devices: DeviceHost[]) => void) => {
      listener([mini]);
      return () => {};
    },
    onProfile: (listener: (p: Profile | null) => void) => {
      publish = listener;
      listener(profile);
      return () => {};
    },
  } as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ProfileButton listed={[]} />));
  return { ...calls, publish: (p: Profile | null) => act(() => publish(p)) };
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const menu = () => document.querySelector("[popover]")!;
const click = (b: HTMLButtonElement) => act(() => b.click());

const mini: DeviceHost = {
  id: "tailnet:mini",
  name: "Mac Mini",
  icon: "mini",
  hostName: "mac-mini",
  ip: "100.64.0.2",
  os: "macOS",
  detected: "mini",
  enabled: true,
};
const ryan = { name: "Ryan Stoffel", firstName: "Ryan", lastName: "Stoffel", email: "r@x.dev" };

test("the menu shows the account, and Manage account opens the Account dialog", async () => {
  const { editProfile, signOut, publish } = render(ryan);
  expect(button("Ryan Stoffel").getAttribute("popovertarget")).toBe(menu().id);
  expect(menu().textContent).toContain("r@x.dev");

  click(button("Manage account"));
  const dialog = document.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('[aria-label="Profile"] h2')!.textContent).toBe("Ryan Stoffel");
  click(button("Edit"));
  expect(editProfile).toHaveBeenCalledOnce();
  click(button("Activity"));
  expect(dialog.querySelector('[aria-label="Activity"]')).not.toBeNull();

  click(button("Sign out"));
  expect(signOut).toHaveBeenCalledOnce();
  // Signed out, the dialog goes and the menu offers Sign in.
  publish(null);
  expect(document.querySelector("dialog")).toBeNull();
  expect(button("Sign in")).toBeDefined();
  // Signing back in doesn't bring the dialog back on its own.
  publish(ryan);
  expect(document.querySelector("dialog")).toBeNull();
});

test("signed out, Sign in and Create an account open Clerk", async () => {
  const { signIn } = render(null);
  expect(menu().textContent).toContain("Sign in to Parallax");
  expect(button("Manage account")).toBeUndefined();
  click(button("Create an account"));
  expect(signIn).toHaveBeenCalledWith(true);
  click(button("Sign in"));
  expect(signIn).toHaveBeenLastCalledWith(false);
});

test("Security opens Clerk's Security page, and Parallax Connect lists and removes devices", async () => {
  const { editProfile, removeDevice } = render(ryan);
  click(button("Manage account"));
  click(button("Security"));
  await act(async () => {});
  const devices = document.querySelector('dialog [aria-label="Sign-in"]')!.textContent;
  expect(devices).toContain("MacintoshThis deviceMacBookParallax 2610.11213.10000");
  click(button("Add a passkey"));
  expect(editProfile).toHaveBeenCalledWith("security");

  click(button("Parallax Connect"));
  const computers = document.querySelector('dialog [aria-label="Computers"]')!;
  expect(computers.textContent).toContain("mac-mini · macOS · 100.64.0.2");
  click(button("Remove"));
  expect(removeDevice).toHaveBeenCalledWith("tailnet:mini");
});
