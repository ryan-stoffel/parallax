import { expect, test, vi } from "vitest";

import { ClerkError, deleteOnClerk, refreshOrSignOut, restore, type Refreshed } from "./clerkSession";

test("a refresh token Clerk refused signs the phone out", async () => {
  const signOut = vi.fn(async () => {});
  const answer = await refreshOrSignOut(() => Promise.reject(new ClerkError("refused", true)), signOut);
  expect(answer).toEqual({ state: "refused" });
  expect(signOut).toHaveBeenCalledOnce();
});

test("any other failure, or none, leaves it signed in", async () => {
  const signOut = vi.fn(async () => {});
  const unreachable = { state: "unreachable" };
  expect(await refreshOrSignOut(() => Promise.reject(new ClerkError("Clerk answered 500.")), signOut)).toEqual(unreachable);
  expect(await refreshOrSignOut(() => Promise.reject(new Error("offline")), signOut)).toEqual(unreachable);
  expect(await refreshOrSignOut(async () => "token", signOut)).toEqual({ state: "valid", value: "token" });
  expect(signOut).not.toHaveBeenCalled();
});

/** Runs a deletion whose refreshes answer `states` in turn, and says whether the page opened. */
async function deletion(...states: Refreshed<unknown>["state"][]) {
  const openPage = vi.fn(async () => {});
  const outcome = await deleteOnClerk(async () => states.shift()!, openPage);
  return { outcome, opened: openPage.mock.calls.length === 1 };
}

test("a token Clerk took before its page and refuses after is a deleted account", async () => {
  expect(await deletion("valid", "refused")).toEqual({ outcome: "deleted", opened: true });
  expect(await deletion("valid", "valid")).toEqual({ outcome: "kept", opened: true });
});

test("no answer after the page leaves the deletion unconfirmed, and none before it doesn't open the page", async () => {
  expect(await deletion("valid", "unreachable")).toEqual({ outcome: "unconfirmed", opened: true });
  expect(await deletion("unreachable")).toEqual({ outcome: "unreachable", opened: false });
});

test("a token already revoked before the page is a sign-out, not a deletion", async () => {
  expect(await deletion("refused")).toEqual({ outcome: "revoked", opened: false });
});

test("a session from another Clerk instance is signed out, and one from before the phone kept its instance is development's (PLX-1049)", () => {
  const api = "https://clerk.parallax.codes";
  const devApi = "https://adjusted-mastodon-8705.clerk.accounts.dev";
  const user = { given_name: "Ryan" };
  const raw = (saved: object) => JSON.stringify({ refreshToken: "rt", user, ...saved });
  expect(restore(raw({}), api)).toEqual({ session: null, moved: true });
  expect(restore(raw({}), devApi)).toEqual({ session: { refreshToken: "rt", user, api: devApi }, moved: false });
  const dev = raw({ api: devApi });
  expect(restore(dev, api)).toEqual({ session: null, moved: true });
  expect(restore(raw({ api }), api)).toEqual({ session: { refreshToken: "rt", user, api }, moved: false });
  expect(restore(null, api)).toEqual({ session: null, moved: false });
});
