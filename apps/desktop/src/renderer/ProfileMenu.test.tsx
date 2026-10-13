// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge, Profile } from "../preload/bridge";
import { ProfileButton } from "./ProfileMenu";

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
    editProfile: vi.fn(async () => {}),
  };
  window.parallax = {
    ...calls,
    onProfile: (listener: (p: Profile | null) => void) => {
      publish = listener;
      listener(profile);
      return () => {};
    },
  } as Partial<ParallaxBridge> as ParallaxBridge;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root!.render(<ProfileButton />));
  return { ...calls, publish: (p: Profile | null) => act(() => publish(p)) };
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  )!;
const menu = () => document.querySelector("[popover]")!;
const click = (b: HTMLButtonElement) => act(() => b.click());

const ryan = { name: "Ryan Stoffel", firstName: "Ryan", lastName: "Stoffel", email: "r@x.dev" };

test("the menu shows the account, and Manage account opens the Account dialog", async () => {
  const { editProfile, signOut, publish } = render(ryan);
  expect(button("Ryan Stoffel").getAttribute("popovertarget")).toBe(menu().id);
  expect(menu().textContent).toContain("r@x.dev");

  click(button("Manage account"));
  const dialog = document.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain("Ryan Stoffel");
  click(button("Update profile"));
  expect(editProfile).toHaveBeenCalledOnce();

  click(button("Sign out"));
  expect(signOut).toHaveBeenCalledOnce();
  // Signed out, the dialog goes and the menu offers Sign in.
  publish(null);
  expect(document.querySelector("dialog")).toBeNull();
  expect(button("Sign in")).toBeDefined();
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
