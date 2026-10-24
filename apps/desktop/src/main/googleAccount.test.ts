import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const { parseListAccounts } = await import("./googleAccount");

test("the signed-in account is the first valid one not signed out", () => {
  const out = ["gaia.l.a", 1, "Old", "old@gmail.com", "https://lh3/old=s48-c", 1, 1, 0, null, 1];
  const signedIn = [
    "gaia.l.a",
    1,
    "Ryan",
    "ryan@gmail.com",
    "https://lh3/a=s48-c",
    1,
    1,
    0,
    null,
    0,
  ];
  expect(parseListAccounts(JSON.stringify(["gaia.l.a.r", [out, signedIn]]))).toEqual({
    name: "Ryan",
    email: "ryan@gmail.com",
    picture: "https://lh3/a=s48-c",
  });
  expect(parseListAccounts(JSON.stringify(["gaia.l.a.r", [out]]))).toBeUndefined();
  expect(parseListAccounts(JSON.stringify(["gaia.l.a.r", []]))).toBeUndefined();
  expect(parseListAccounts("<html>")).toBeUndefined();
});
