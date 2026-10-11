import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, test, vi } from "vite-plus/test";

import type { Profile } from "../preload/bridge";

// Electron as main sees it: a userData folder, IPC handlers by channel, a keychain that just marks
// what it encrypts, and a browser that records what it was sent to.
const electron = vi.hoisted(() => {
  process.env["PLX_CLERK_PUBLISHABLE_KEY"] = `pk_test_${btoa("clerk.parallax.test$")}`;
  process.env["PLX_CLERK_CLIENT_ID"] = "desktop";
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const focus: (() => void)[] = [];
  return {
    userData: "",
    handlers,
    focus,
    opened: [] as string[],
    app: {
      getPath: () => electron.userData,
      on: (_event: string, listener: () => void) => focus.push(listener),
      focus: () => {},
    },
    ipcMain: {
      handle: (channel: string, h: (...args: unknown[]) => unknown) => handlers.set(channel, h),
    },
    backend: "gnome_libsecret",
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => electron.backend,
      encryptString: (text: string) => Buffer.from(`enc:${Buffer.from(text).toString("base64")}`),
      decryptString: (data: Buffer) =>
        Buffer.from(data.toString().replace(/^enc:/, ""), "base64").toString(),
    },
    shell: { openExternal: async (url: string) => void electron.opened.push(url) },
    BrowserWindow: { getAllWindows: () => [] },
  };
});
vi.mock("electron", () => electron);
const published: (Profile | null)[] = [];
vi.mock("./windows", () => ({
  broadcast: (_channel: string, profile: Profile | null) => published.push(profile),
}));

const { accountPortal, frontendApi, startAccount } = await import("./account");

// A mocked Clerk instance at https://clerk.parallax.test: the OAuth endpoints the app calls, as
// Clerk documents them, with a public client that must use PKCE (S256).
const clerk = {
  codes: new Map<string, { challenge: string; redirectUri: string }>(),
  access: new Set<string>(),
  refresh: new Set<string>(),
  revoked: [] as string[],
  user: {
    sub: "user_1",
    email: "ryan@example.com",
    given_name: "Ryan",
    family_name: "Stoffel",
    picture: "https://img.clerk.test/ryan.png",
  },
  issued: 0,
};
function issue(refreshToken = `rt${++clerk.issued}`) {
  const accessToken = `at${clerk.issued}`;
  clerk.access.add(accessToken);
  clerk.refresh.add(refreshToken);
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 86400,
  });
}
const oauthError = (error: string) => Response.json({ error }, { status: 400 });
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
  const url = new URL(input);
  if (url.host === "img.clerk.test")
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
  if (url.host !== "clerk.parallax.test") return realFetch(input, init);
  const form = new URLSearchParams(init?.body as URLSearchParams | undefined);
  if (form.get("client_id") !== null && form.get("client_id") !== "desktop")
    return oauthError("invalid_client");
  switch (url.pathname) {
    case "/oauth/token": {
      if (form.get("grant_type") === "authorization_code") {
        const grant = clerk.codes.get(form.get("code")!);
        clerk.codes.delete(form.get("code")!);
        const verifier = createHash("sha256").update(form.get("code_verifier") ?? "");
        if (
          !grant ||
          grant.redirectUri !== form.get("redirect_uri") ||
          grant.challenge !== verifier.digest("base64url")
        )
          return oauthError("invalid_grant");
        return issue();
      }
      const old = form.get("refresh_token")!;
      if (!clerk.refresh.delete(old)) return oauthError("invalid_grant");
      return issue();
    }
    case "/oauth/userinfo": {
      const bearer = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
      if (!clerk.access.has(bearer!)) return new Response(null, { status: 401 });
      return Response.json({ object: "oauth_user_info", ...clerk.user });
    }
    case "/oauth/token/revoke":
      clerk.revoked.push(form.get("token")!);
      clerk.refresh.delete(form.get("token")!);
      return new Response(null, { status: 200 });
  }
  return new Response(null, { status: 404 });
});

/** Plays the browser on Clerk's page: the user signs in, and Clerk sends back a code. */
async function signInInBrowser(sent: string, state = new URL(sent).searchParams.get("state")) {
  const authorize = new URL(sent);
  const redirectUri = authorize.searchParams.get("redirect_uri")!;
  const code = `code${clerk.codes.size + 1}`;
  clerk.codes.set(code, { challenge: authorize.searchParams.get("code_challenge")!, redirectUri });
  return realFetch(`${redirectUri}?code=${code}&state=${state}`);
}

const call = (channel: string, ...args: unknown[]) =>
  electron.handlers.get(channel)!({}, ...args) as Promise<string | undefined>;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const savedFile = () => path.join(electron.userData, "account");

const dirs: string[] = [];
beforeEach(() => {
  electron.userData = fs.mkdtempSync(path.join(os.tmpdir(), "plx-account-"));
  dirs.push(electron.userData);
  electron.opened.length = 0;
  published.length = 0;
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a publishable key names its Frontend API and Account Portal", () => {
  const live = frontendApi(`pk_live_${btoa("clerk.parallx.dev$")}`);
  expect(live).toBe("https://clerk.parallx.dev");
  expect(accountPortal(live)).toBe("https://accounts.parallx.dev");
  const dev = frontendApi("pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk");
  expect(dev).toBe("https://adjusted-mastodon-8705.clerk.accounts.dev");
  expect(accountPortal(dev)).toBe("https://adjusted-mastodon-8705.accounts.dev");
});

test("signs in with PKCE through the browser; main keeps the tokens, encrypted", async () => {
  startAccount();
  expect(await call("parallax:profile")).toBeNull();
  const answer = call("parallax:signIn", false);
  await vi.waitFor(() => expect(electron.opened).toHaveLength(1));
  const sent = new URL(electron.opened[0]!);
  expect(sent.origin + sent.pathname).toBe("https://clerk.parallax.test/oauth/authorize");
  expect(Object.fromEntries(sent.searchParams)).toMatchObject({
    response_type: "code",
    client_id: "desktop",
    scope: "profile email offline_access",
    code_challenge_method: "S256",
  });
  expect(sent.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  // A callback without the sign-in's state, as from another program, doesn't count.
  expect((await signInInBrowser(sent.href, "guess")).status).toBe(403);
  const page = await signInInBrowser(sent.href);
  expect(await page.text()).toContain("Signed in to Parallax");
  await expect(answer).resolves.toBeUndefined();

  await vi.waitFor(() => expect(published.at(-1)?.picture).toBe("data:image/png;base64,AQID"));
  expect(published.at(-1)).toEqual({
    firstName: "Ryan",
    lastName: "Stoffel",
    name: "Ryan Stoffel",
    email: "ryan@example.com",
    picture: "data:image/png;base64,AQID",
  });
  // The renderer never gets a token, and the disk only gets it encrypted.
  expect(JSON.stringify(published)).not.toMatch(/\b(at|rt)\d/);
  const disk = fs.readFileSync(savedFile()).toString();
  expect(disk).toMatch(/^enc:/);
  expect(electron.safeStorage.decryptString(Buffer.from(disk))).toContain('"refreshToken":"rt1"');
});

test("a code traded without the sign-in's verifier, or a denied sign-in, shows why", async () => {
  startAccount();
  const answer = call("parallax:signIn", false);
  await vi.waitFor(() => expect(electron.opened).toHaveLength(1));
  const sent = new URL(electron.opened[0]!);
  sent.searchParams.set("code_challenge", "someone-elses");
  const page = await signInInBrowser(sent.href);
  expect(await page.text()).toContain("invalid_grant");
  await expect(answer).resolves.toBe("invalid_grant");

  const denied = call("parallax:signIn", false);
  await vi.waitFor(() => expect(electron.opened).toHaveLength(2));
  const again = new URL(electron.opened[1]!);
  const back = `${again.searchParams.get("redirect_uri")}?error=access_denied&error_description=<b>No</b>&state=${again.searchParams.get("state")}`;
  expect(await (await realFetch(back)).text()).toContain("&lt;b&gt;No&lt;/b&gt;");
  await expect(denied).resolves.toBe("<b>No</b>");
  expect(published.filter(Boolean)).toEqual([]);
});

test("Create an account starts on Clerk's sign-up page, which continues the same sign-in", async () => {
  startAccount();
  void call("parallax:signIn", true);
  await vi.waitFor(() => expect(electron.opened).toHaveLength(1));
  const sent = new URL(electron.opened[0]!);
  expect(sent.origin + sent.pathname).toBe("https://accounts.parallax.test/sign-up");
  const authorize = sent.searchParams.get("redirect_url")!;
  expect(authorize).toMatch(/^https:\/\/clerk\.parallax\.test\/oauth\/authorize\?/);
  expect(await (await signInInBrowser(authorize)).text()).toContain("Signed in");

  await call("parallax:editProfile");
  expect(electron.opened[1]).toBe("https://accounts.parallax.test/user");
});

test("a restart shows the saved profile at once, then refreshes it; sign-out revokes", async () => {
  startAccount();
  const answer = call("parallax:signIn", false);
  await vi.waitFor(() => expect(electron.opened).toHaveLength(1));
  await signInInBrowser(electron.opened[0]!);
  await answer;
  const before = electron.safeStorage.decryptString(fs.readFileSync(savedFile()));
  const refreshToken = JSON.parse(before).refreshToken as string;

  // The next launch, after the name changed on Clerk's page.
  clerk.user = { ...clerk.user, given_name: "Ry", picture: "" };
  published.length = 0;
  startAccount();
  expect(await call("parallax:profile")).toMatchObject({ name: "Ryan Stoffel" });
  await vi.waitFor(() => expect(published.at(-1)).toMatchObject({ name: "Ry Stoffel" }));
  // Clerk rotated the refresh token, and the app kept the new one.
  const after = JSON.parse(electron.safeStorage.decryptString(fs.readFileSync(savedFile())));
  expect(after.refreshToken).not.toBe(refreshToken);
  expect(clerk.refresh.has(after.refreshToken)).toBe(true);

  await call("parallax:signOut");
  expect(published.at(-1)).toBeNull();
  expect(clerk.revoked).toEqual([after.refreshToken]);
  expect(fs.existsSync(savedFile())).toBe(false);
  await settle();
});

test("a refresh token revoked elsewhere signs this computer out", async () => {
  startAccount();
  const answer = call("parallax:signIn", false);
  await vi.waitFor(() => expect(electron.opened).toHaveLength(1));
  await signInInBrowser(electron.opened[0]!);
  await answer;
  clerk.refresh.clear();

  published.length = 0;
  startAccount();
  await vi.waitFor(() => expect(published.at(-1)).toBeNull());
  expect(fs.existsSync(savedFile())).toBe(false);
});

test("an unreadable or older (Supabase) session file is signed out, and removed", async () => {
  fs.writeFileSync(savedFile(), electron.safeStorage.encryptString('{"sb-x-auth-token":"{}"}'));
  startAccount();
  expect(await call("parallax:profile")).toBeNull();
  expect(fs.existsSync(savedFile())).toBe(false);
});

test("Linux's basic_text backend, a hardcoded password, keeps the session in memory", async () => {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  electron.backend = "basic_text";
  try {
    // A file an older build saved that way is removed.
    fs.writeFileSync(savedFile(), electron.safeStorage.encryptString('{"refreshToken":"rt0"}'));
    startAccount();
    expect(fs.existsSync(savedFile())).toBe(false);

    const answer = call("parallax:signIn", false);
    await vi.waitFor(() => expect(electron.opened).toHaveLength(1));
    await signInInBrowser(electron.opened[0]!);
    await expect(answer).resolves.toBeUndefined();
    expect(published.at(-1)).toMatchObject({ email: "ryan@example.com" });
    expect(fs.existsSync(savedFile())).toBe(false);
    await call("parallax:signOut");
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    electron.backend = "gnome_libsecret";
  }
});
