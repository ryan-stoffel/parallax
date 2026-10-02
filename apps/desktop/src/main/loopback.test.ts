import { expect, test } from "vite-plus/test";

import { listenForCode } from "./loopback";

test("resolves to the redirect's code, answers in plain text, and stops listening", async () => {
  const { url, code } = await listenForCode();
  expect((await fetch(url.replace("/callback", "/favicon.ico"))).status).toBe(404);
  const res = await fetch(`${url}?code=abc`);
  expect(res.headers.get("content-type")).toContain("text/plain");
  await expect(code).resolves.toBe("abc");
  await expect(fetch(url)).rejects.toThrow();
});

test("rejects with the provider's error, on close, and on timeout", async () => {
  const denied = await listenForCode();
  await fetch(`${denied.url}?error=access_denied&error_description=User+denied`);
  await expect(denied.code).rejects.toThrow("User denied");

  const closed = await listenForCode();
  closed.close();
  await expect(closed.code).rejects.toThrow("cancelled");

  await expect((await listenForCode(10)).code).rejects.toThrow("timed out");
});
