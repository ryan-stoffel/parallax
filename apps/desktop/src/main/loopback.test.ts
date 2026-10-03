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

/** Opens the page as the browser would: the secret in its URL becomes a cookie. */
async function open(url: string) {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/");
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const base = new URL("/", url).href;
  const get = (
    path: string,
    init?: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
  ) =>
    fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { cookie, ...init?.headers } });
  const postEmail = (body: object, origin = new URL(base).origin) =>
    get("email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { base, get, postEmail };
}

test("serves the page, and signs in with email only from the page the app opened", async () => {
  const seen: string[] = [];
  const { url, done } = await serveSignIn(
    accounts({
      signIn: async (email, password) => {
        seen.push(`${email}:${password}`);
        return password === "right" ? { signedIn: true } : { error: "Invalid login credentials" };
      },
    }),
  );
  const { base, get, postEmail } = await open(url);
  const page = await get("");
  expect(page.headers.get("content-security-policy")).toContain("script-src 'nonce-");
  expect(await page.text()).toContain('href="/oauth/github"');

  // Without the secret's cookie, with the spent secret, from another site, or from another local
  // program.
  expect((await fetch(base)).status).toBe(403);
  expect((await fetch(url, { redirect: "manual" })).status).toBe(403);
  const body = JSON.stringify({ email: "a@b.c", password: "right" });
  const headers = { origin: new URL(base).origin, "content-type": "application/json" };
  expect((await fetch(`${base}email`, { method: "POST", headers, body })).status).toBe(403);
  expect((await postEmail({ email: "a@b.c", password: "x" }, "https://evil.test")).status).toBe(
    403,
  );

  expect(await (await postEmail({ email: "a@b.c", password: "wrong" })).json()).toEqual({
    error: "Invalid login credentials",
  });
  expect(await (await postEmail({ email: " a@b.c ", password: "right" })).json()).toEqual({
    signedIn: true,
  });
  expect(seen).toEqual(["a@b.c:wrong", "a@b.c:right"]);
  await expect(done).resolves.toBeUndefined();
  await expect(fetch(base)).rejects.toThrow();
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

test("sends the browser to the provider, and trades the code with its flow's id", async () => {
  const exchanged: string[] = [];
  const { url, done } = await serveSignIn(
    accounts({
      oauthUrl: async (provider, redirectTo) =>
        `https://auth.test/authorize?provider=${provider}&redirect_to=${redirectTo}`,
      exchange: async (code, flowId) => {
        exchanged.push(`${code}:${flowId}`);
        return code === "good" ? { signedIn: true } : { error: "Code expired" };
      },
    }),
  );
  const { base, get } = await open(url);
  expect((await fetch(`${base}oauth/github`, { redirect: "manual" })).status).toBe(403);
  const start = await get("oauth/github");
  expect(start.status).toBe(302);
  expect(start.headers.get("location")).toBe(
    `https://auth.test/authorize?provider=github&redirect_to=${base}callback`,
  );
  expect((await get("oauth/gitlab")).status).toBe(404);

  // The callback needs no cookie, since a provider redirects there. A failed step shows on the
  // page, and the page keeps waiting.
  const denied = await fetch(`${base}callback?error=access_denied&error_description=<b>No</b>`);
  expect(await denied.text()).toContain("&lt;b&gt;No&lt;/b&gt;");
  expect(await (await fetch(`${base}callback?code=old`)).text()).toContain("Code expired");

  expect(await (await fetch(`${base}callback?code=good&sb_flow_id=f1`)).text()).toContain(
    "Signed in",
  );
  expect(exchanged).toEqual(["old:undefined", "good:f1"]);
  await expect(done).resolves.toBeUndefined();
});

test("resolves to why it stopped: on close, and on timeout", async () => {
  const closed = await serveSignIn(accounts({}));
  closed.close();
  await expect(closed.done).resolves.toContain("cancelled");

  await expect((await serveSignIn(accounts({}), 10)).done).resolves.toContain("timed out");
});
