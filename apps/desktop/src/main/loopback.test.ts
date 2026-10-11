import { request } from "node:http";
import { expect, test } from "vite-plus/test";

import { serveCallback } from "./loopback";

const never = async () => "unreachable";

test("answers only to its own address and path, so a DNS-rebound name gets nothing", async () => {
  const { redirectUri, close } = await serveCallback("s", never);
  const { port } = new URL(redirectUri);
  const status = await new Promise((resolve) =>
    request(
      {
        host: "127.0.0.1",
        port,
        path: "/callback?state=s&code=c",
        headers: { host: `evil.test:${port}` },
      },
      (res) => resolve(res.statusCode),
    ).end(),
  );
  expect(status).toBe(403);
  expect((await fetch(new URL("/", redirectUri))).status).toBe(404);
  close();
});

test("takes one callback with the state, and resolves to why it stopped", async () => {
  const codes: string[] = [];
  const page = await serveCallback("s", async (code) => {
    codes.push(code);
    return undefined;
  });
  expect((await fetch(`${page.redirectUri}?state=t&code=a`)).status).toBe(403);
  expect(await (await fetch(`${page.redirectUri}?state=s&code=b`)).text()).toContain("Signed in");
  await expect(page.done).resolves.toBeUndefined();
  expect(codes).toEqual(["b"]);

  const closed = await serveCallback("s", never);
  closed.close();
  await expect(closed.done).resolves.toContain("cancelled");
  await expect((await serveCallback("s", never, 10)).done).resolves.toContain("timed out");
});
