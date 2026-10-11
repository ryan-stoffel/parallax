import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Profile } from "../preload/bridge";
import { serveCallback, type Callback } from "./loopback";
import { broadcast } from "./windows";

// The Clerk instance that holds Parallax accounts (0067), named by its publishable key, and the
// app's OAuth application there. Both are public. PLX_CLERK_PUBLISHABLE_KEY and
// PLX_CLERK_CLIENT_ID point a dev build at another instance.
const PUBLISHABLE_KEY =
  process.env["PLX_CLERK_PUBLISHABLE_KEY"] ??
  "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk";
const CLIENT_ID = process.env["PLX_CLERK_CLIENT_ID"] ?? "SXDueyOLOJ2v4Vmq";
const SCOPES = "profile email offline_access";

/** The Frontend API a publishable key names: `pk_test_` or `pk_live_`, then base64 of `<host>$`. */
export function frontendApi(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_(test|live)_/, "");
  return `https://${Buffer.from(encoded, "base64").toString().replace(/\$$/, "")}`;
}

/**
 * Clerk's hosted Account Portal for a Frontend API: `accounts.<domain>` beside `clerk.<domain>`,
 * or `<slug>.accounts.dev` for a development instance's `<slug>.clerk.accounts.dev`.
 */
export function accountPortal(api: string): string {
  return api
    .replace("://clerk.", "://accounts.")
    .replace(/\.clerk\.accounts\.dev$/, ".accounts.dev");
}

/** What Clerk's userinfo says of the user (OpenID Connect claims), as much as the app shows. */
type User = {
  email?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
};

/** What the app keeps, encrypted: the refresh token, and the user, to show before Clerk answers. */
type Session = { refreshToken: string; user: User };

/** A failed call to Clerk. `revoked` if Clerk refused the refresh token itself. */
class ClerkError extends Error {
  constructor(
    message: string,
    readonly revoked = false,
  ) {
    super(message);
  }
}

/** A picture as a data: URL, since the renderer's CSP loads no remote images. */
async function fetchPicture(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return undefined;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Brings the app's window forward once the browser has signed it in. */
function bringForward() {
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isMinimized()) win.restore();
  win?.show();
  app.focus({ steal: true });
}

/** The account's access token, for Parallax Relay (PLX-652). Main only: it never reaches a renderer. */
export type Account = {
  accessToken(): Promise<string | undefined>;
  currentToken(): string | undefined;
};

/**
 * Starts the Parallax account (0067): Clerk's OAuth sign-in with PKCE, run from the main process,
 * so the renderer only ever sees the profile. The browser signs in on Clerk's page and comes back
 * to a loopback callback (loopback.ts). The refresh token is kept in one file in userData,
 * encrypted with the OS keychain; where the OS has none (Linux without a keyring), the session
 * lives in memory and ends with the app. Call once the app is ready, as safeStorage needs.
 */
export function startAccount(): Account {
  const api = frontendApi(PUBLISHABLE_KEY);
  const file = path.join(app.getPath("userData"), "account");
  // Linux without a keyring falls back to `basic_text`, a hardcoded password: as good as plain
  // text for a refresh token that never expires, so the session stays in memory there.
  const persist =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");

  let session: Session | undefined;
  try {
    const saved = persist && JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    if (typeof saved?.refreshToken === "string" && saved.user) session = saved;
  } catch {
    // None yet, or unreadable: signed out.
  }
  const save = (next: Session | undefined) => {
    session = next;
    if (next && persist)
      fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
    // Also clears a Supabase session left by an older build (0037), or one an older build saved
    // with `basic_text`.
    else if (!next) fs.rmSync(file, { force: true });
  };
  if (!session) save(undefined);

  // The current access token, a JWT good for a day, kept in memory only.
  let access: { token: string; expiresAt: number } | undefined;
  // Counts sign-ins and sign-outs, so an answer from Clerk for an earlier account is dropped.
  let epoch = 0;

  /** Calls Clerk's token endpoint as the app's public client: an access token, maybe a refresh one. */
  async function token(params: Record<string, string>) {
    const res = await fetch(`${api}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body["access_token"] !== "string") {
      const why = [body["error_description"], body["error"]].find((v) => typeof v === "string");
      throw new ClerkError(
        why ?? `Clerk answered ${res.status}.`,
        body["error"] === "invalid_grant",
      );
    }
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
    return {
      access: { token: body["access_token"], expiresAt: Date.now() + expiresIn * 1000 },
      refreshToken: typeof body["refresh_token"] === "string" ? body["refresh_token"] : undefined,
    };
  }

  // One refresh at a time: Clerk may rotate the refresh token on each use.
  let refreshing: Promise<string | undefined> | undefined;
  /** A current access token, refreshed a minute before it expires, or undefined signed out. */
  function accessToken(): Promise<string | undefined> {
    if (access && access.expiresAt - 60_000 > Date.now()) return Promise.resolve(access.token);
    refreshing ??= (async () => {
      const held = epoch;
      if (!session) return undefined;
      try {
        const fresh = await token({
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        });
        if (epoch !== held || !session) return undefined;
        access = fresh.access;
        if (fresh.refreshToken) save({ ...session, refreshToken: fresh.refreshToken });
        return access.token;
      } catch (error) {
        // Revoked, such as by signing out everywhere: signed out here too.
        if (error instanceof ClerkError && error.revoked && epoch === held) {
          epoch++;
          save(undefined);
          publish(null);
        }
        return undefined;
      }
    })().finally(() => (refreshing = undefined));
    return refreshing;
  }

  async function userinfo(bearer: string): Promise<User> {
    const res = await fetch(`${api}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ClerkError(`Clerk answered ${res.status}.`);
    const { email, given_name, family_name, picture } = (await res.json()) as User;
    return { email, given_name, family_name, picture };
  }

  let profile: Profile | null = null;
  const publish = (next: Profile | null) => {
    profile = next;
    broadcast("parallax:profile", profile);
  };
  // The last picture fetched, so a profile refresh doesn't fetch it again.
  let picture: { url: string; data: string | undefined } | undefined;
  // Each change gets a number, so a slow picture fetch never overwrites a newer profile.
  let changes = 0;
  function show(user: User) {
    const change = ++changes;
    const firstName = user.given_name?.trim() ?? "";
    const lastName = user.family_name?.trim() ?? "";
    const name = [firstName, lastName].filter(Boolean).join(" ");
    const shown = { firstName, lastName, name, email: user.email ?? "" };
    const url = user.picture?.startsWith("https://") ? user.picture : undefined;
    if (!url || url === picture?.url) return publish({ ...shown, picture: url && picture?.data });
    // The name now, the picture once it's here.
    publish(shown);
    void fetchPicture(url).then((data) => {
      picture = { url, data };
      if (change === changes) publish({ ...shown, picture: data });
    });
  }

  // When the profile last came from Clerk, so focusing the window refreshes it at most once a
  // minute: a name or picture changed on Clerk's page, or on another device, shows on return.
  let fetchedAt = 0;
  async function refreshProfile() {
    fetchedAt = Date.now();
    const held = epoch;
    const bearer = await accessToken();
    if (!bearer || epoch !== held) return;
    try {
      const user = await userinfo(bearer);
      if (epoch !== held || !session) return;
      save({ ...session, user });
      show(user);
    } catch {
      // Offline, or Clerk is down: the saved profile stays.
    }
  }
  if (session) {
    show(session.user);
    void refreshProfile();
  }
  app.on("browser-window-focus", () => {
    if (session && Date.now() - fetchedAt > 60_000) void refreshProfile();
  });

  // The sign-in waiting for the browser, if any.
  let page: Callback | undefined;

  ipcMain.handle("parallax:profile", () => profile);

  ipcMain.handle("parallax:signIn", async (_event, create: boolean) => {
    // One sign-in at a time, so a late one can't switch accounts.
    page?.close();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(16).toString("base64url");
    const current = await serveCallback(state, async (code) => {
      const fresh = await token({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: current.redirectUri,
      });
      if (!fresh.refreshToken) return "Clerk sent no refresh token.";
      const user = await userinfo(fresh.access.token);
      if (page !== current) return "Sign-in was cancelled.";
      epoch++;
      access = fresh.access;
      save({ refreshToken: fresh.refreshToken, user });
      fetchedAt = Date.now();
      show(user);
      return undefined;
    });
    page = current;

    const authorize = new URL(`${api}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: current.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    // Create an account starts on Clerk's sign-up page, which then continues the same sign-in.
    const url = create
      ? `${accountPortal(api)}/sign-up?redirect_url=${encodeURIComponent(authorize.href)}`
      : authorize.href;
    try {
      await shell.openExternal(url);
    } catch (error) {
      current.close();
      return `Couldn't open your browser: ${(error as Error).message}`;
    }
    const error = await current.done;
    if (page === current) page = undefined;
    if (!error) bringForward();
    return error;
  });

  // Settings > Account's name and picture are edited on Clerk's account page, since an OAuth
  // token can't change the user. Coming back to the app shows the change.
  ipcMain.handle("parallax:editProfile", () => shell.openExternal(`${accountPortal(api)}/user`));

  ipcMain.handle("parallax:signOut", async () => {
    page?.close();
    const held = session;
    epoch++;
    save(undefined);
    access = undefined;
    publish(null);
    // Revokes this computer's refresh token only: other devices stay signed in.
    if (held)
      await fetch(`${api}/oauth/token/revoke`, {
        method: "POST",
        body: new URLSearchParams({ client_id: CLIENT_ID, token: held.refreshToken }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
  });

  return {
    accessToken,
    /** The access token while it's fresh, for a call that can't wait; else starts a refresh. */
    currentToken(): string | undefined {
      if (access && access.expiresAt - 60_000 > Date.now()) return access.token;
      void accessToken();
      return undefined;
    },
  };
}
