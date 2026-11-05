import { expect, test, vi } from "vitest";

import { ClerkError, refreshOrSignOut } from "./clerkSession";

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
