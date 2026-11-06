import { expect, test, vi } from "vitest";

import { ClerkError, refreshOrSignOut, restore } from "./clerkSession";

test("a refresh token Clerk refused signs the phone out", async () => {
  const signOut = vi.fn(async () => {});
  const answer = await refreshOrSignOut(() => Promise.reject(new ClerkError("refused", true)), signOut);
  expect(answer).toBeUndefined();
  expect(signOut).toHaveBeenCalledOnce();
});

test("any other failure, or none, leaves it signed in", async () => {
  const signOut = vi.fn(async () => {});
  await refreshOrSignOut(() => Promise.reject(new ClerkError("Clerk answered 500.")), signOut);
  await refreshOrSignOut(() => Promise.reject(new Error("offline")), signOut);
  expect(await refreshOrSignOut(async () => "token", signOut)).toBe("token");
  expect(signOut).not.toHaveBeenCalled();
});

test("a session from another Clerk instance, or from before the phone kept one, is signed out (PLX-1049)", () => {
  const api = "https://clerk.parallax.codes";
  const user = { given_name: "Ryan" };
  const raw = (saved: object) => JSON.stringify({ refreshToken: "rt", user, ...saved });
  expect(restore(raw({}), api)).toEqual({ session: null, moved: true });
  const dev = raw({ api: "https://adjusted-mastodon-8705.clerk.accounts.dev" });
  expect(restore(dev, api)).toEqual({ session: null, moved: true });
  expect(restore(raw({ api }), api)).toEqual({ session: { refreshToken: "rt", user, api }, moved: false });
  expect(restore(null, api)).toEqual({ session: null, moved: false });
});
