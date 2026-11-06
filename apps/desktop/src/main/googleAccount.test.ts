import { expect, test, vi } from "vite-plus/test";

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const { parseListAccounts } = await import("./googleAccount");

// ListAccounts' accounts, as Google answers: valid at 9, gaia id at 10, signed out at 14.
const account = (name: string, email: string, valid: number, signedOut: number) => [
  "gaia.l.a",
  1,
  name,
  email,
  `https://lh3/${name}=s48-c`,
  1,
  1,
  0,
  null,
  valid,
  "1234",
  null,
  null,
  null,
  signedOut,
];

test("the signed-in account is the first valid one not signed out", () => {
  const out = account("Old", "old@gmail.com", 1, 1);
  const expired = account("Expired", "expired@gmail.com", 0, 0);
  const signedIn = account("Ryan", "ryan@gmail.com", 1, 0);
  expect(parseListAccounts(JSON.stringify(["gaia.l.a.r", [out, expired, signedIn]]))).toEqual({
    name: "Ryan",
    email: "ryan@gmail.com",
    picture: "https://lh3/Ryan=s48-c",
  });
  expect(parseListAccounts(JSON.stringify(["gaia.l.a.r", [out, expired]]))).toBeUndefined();
  expect(parseListAccounts(JSON.stringify(["gaia.l.a.r", []]))).toBeUndefined();
  expect(parseListAccounts("<html>")).toBeUndefined();
});
