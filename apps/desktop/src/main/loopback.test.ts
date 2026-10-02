import { expect, test } from "vite-plus/test";

import { listenForCode } from "./loopback";

test("hands over the code, answers with the outcome in plain text, and stops listening", async () => {
  const seen: unknown[] = [];
  const { url, done } = await listenForCode(async (code) => {
    seen.push(code);
    return undefined;
  });
  expect((await fetch(url.replace("/callback", "/favicon.ico"))).status).toBe(404);
  const res = await fetch(`${url}?code=abc`);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toContain("Signed in");
  expect(seen).toEqual(["abc"]);
  await expect(done).resolves.toBeUndefined();
  await expect(fetch(url)).rejects.toThrow();
});

test("a failed exchange tells the browser and `done`", async () => {
  const { url, done } = await listenForCode(async () => "Code expired");
  expect(await (await fetch(`${url}?code=abc`)).text()).toContain(
    "couldn't sign you in: Code expired",
  );
  await expect(done).resolves.toBe("Code expired");
});

test("resolves to the provider's error, on close, and on timeout", async () => {
  const never = async () => "unreachable";
  const denied = await listenForCode(never);
  await fetch(`${denied.url}?error=access_denied&error_description=User+denied`);
  await expect(denied.done).resolves.toBe("User denied");

  const closed = await listenForCode(never);
  closed.close();
  await expect(closed.done).resolves.toContain("cancelled");

  await expect((await listenForCode(never, 10)).done).resolves.toContain("timed out");
});
