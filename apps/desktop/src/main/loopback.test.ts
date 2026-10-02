import { request } from "node:http";
import { expect, test } from "vite-plus/test";

import { serveSignIn, type Accounts, type Answer } from "./loopback";

const fail = async (): Promise<Answer> => ({ error: "unreachable" });
const accounts = (overrides: Partial<Accounts>): Accounts => ({
  oauthUrl: async () => ({ error: "unreachable" }),
  signIn: fail,
  signUp: fail,
  exchange: fail,
  ...overrides,
});
const postEmail = (url: string, body: object, origin = new URL(url).origin) =>
  fetch(`${url}email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("serves the page, and signs in with email only from the page itself", async () => {
  const seen: string[] = [];
  const { url, done } = await serveSignIn(
    accounts({
      signIn: async (email, password) => {
        seen.push(`${email}:${password}`);
        return password === "right" ? { signedIn: true } : { error: "Invalid login credentials" };
      },
    }),
  );
  const page = await fetch(url);
  expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
  expect(await page.text()).toContain('href="/oauth/github"');

  expect(
    (await postEmail(url, { email: "a@b.c", password: "x" }, "https://evil.test")).status,
  ).toBe(403);
  expect(await (await postEmail(url, { email: "a@b.c", password: "wrong" })).json()).toEqual({
    error: "Invalid login credentials",
  });
  expect(await (await postEmail(url, { email: " a@b.c ", password: "right" })).json()).toEqual({
    signedIn: true,
  });
  expect(seen).toEqual(["a@b.c:wrong", "a@b.c:right"]);
  await expect(done).resolves.toBeUndefined();
  await expect(fetch(url)).rejects.toThrow();
});

test("answers only to its own address, so a DNS-rebound name gets nothing", async () => {
  const { url, close } = await serveSignIn(accounts({}));
  const { port } = new URL(url);
  const status = await new Promise((resolve) =>
    request({ host: "127.0.0.1", port, headers: { host: `evil.test:${port}` } }, (res) =>
      resolve(res.statusCode),
    ).end(),
  );
  expect(status).toBe(403);
  close();
});

test("sends the browser to the provider, and trades the code that comes back", async () => {
  const codes: string[] = [];
  const { url, done } = await serveSignIn(
    accounts({
      oauthUrl: async (provider, redirectTo) =>
        `https://auth.test/authorize?provider=${provider}&redirect_to=${redirectTo}`,
      exchange: async (code) => {
        codes.push(code);
        return code === "good" ? { signedIn: true } : { error: "Code expired" };
      },
    }),
  );
  const start = await fetch(`${url}oauth/github`, { redirect: "manual" });
  expect(start.status).toBe(302);
  expect(start.headers.get("location")).toBe(
    `https://auth.test/authorize?provider=github&redirect_to=${url}callback`,
  );
  expect((await fetch(`${url}oauth/gitlab`)).status).toBe(404);

  // A failed step shows on the page, and the page keeps waiting.
  const denied = await fetch(`${url}callback?error=access_denied&error_description=<b>No</b>`);
  expect(await denied.text()).toContain("&lt;b&gt;No&lt;/b&gt;");
  expect(await (await fetch(`${url}callback?code=old`)).text()).toContain("Code expired");

  expect(await (await fetch(`${url}callback?code=good`)).text()).toContain("Signed in");
  expect(codes).toEqual(["old", "good"]);
  await expect(done).resolves.toBeUndefined();
});

test("resolves to why it stopped: on close, and on timeout", async () => {
  const closed = await serveSignIn(accounts({}));
  closed.close();
  await expect(closed.done).resolves.toContain("cancelled");

  await expect((await serveSignIn(accounts({}), 10)).done).resolves.toContain("timed out");
});
