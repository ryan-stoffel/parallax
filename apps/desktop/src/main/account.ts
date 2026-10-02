import { AuthClient, type SupportedStorage, type User } from "@supabase/auth-js";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

import type { Profile } from "../preload/bridge";
import { serveSignIn, type Answer, type SignInPage } from "./loopback";

// The Supabase project that holds Parallax accounts (0037). Both values are public: the key only
// names the project. PLX_SUPABASE_URL and PLX_SUPABASE_KEY point a dev build at another project.
const SUPABASE_URL = process.env["PLX_SUPABASE_URL"] ?? "";
const SUPABASE_KEY = process.env["PLX_SUPABASE_KEY"] ?? "";
const notSetUp = "Accounts aren't set up in this build yet.";

/**
 * The session's storage: one file in userData, encrypted with the OS keychain. Where the OS has
 * no keychain (some Linux desktops), the session lives in memory and ends with the app.
 */
function encryptedStorage(file: string): SupportedStorage {
  const persist = safeStorage.isEncryptionAvailable();
  let items: Record<string, string> = {};
  try {
    if (persist) items = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
  } catch {
    // None yet, or unreadable: signed out.
  }
  const save = () => {
    if (persist)
      fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(items)), { mode: 0o600 });
  };
  return {
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
      save();
    },
    removeItem: (key) => {
      delete items[key];
      save();
    },
  };
}

/** The name the user gave, or their provider's: GitHub and Google send `full_name`. */
function nameOf(meta: Record<string, unknown>): string {
  const text = (key: string) => (typeof meta[key] === "string" ? meta[key].trim() : "");
  const given = [text("first_name"), text("last_name")].filter(Boolean).join(" ");
  return given || text("full_name") || text("name");
}

/** The provider's picture's https URL, if it sent one. */
function pictureUrl(meta: Record<string, unknown>): string | undefined {
  const url = meta["avatar_url"] ?? meta["picture"];
  return typeof url === "string" && url.startsWith("https://") ? url : undefined;
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

/**
 * Starts the Parallax account (0037): a Supabase Auth session kept in the main process, so the
 * renderer only ever sees the profile. Signing in happens on a page in the system browser that
 * main serves on loopback (loopback.ts), and OAuth uses PKCE. Call once the app is ready, as safeStorage needs.
 */
export function startAccount() {
  const auth = SUPABASE_URL
    ? new AuthClient({
        url: `${SUPABASE_URL}/auth/v1`,
        headers: { apikey: SUPABASE_KEY },
        storage: encryptedStorage(path.join(app.getPath("userData"), "account")),
        flowType: "pkce",
        detectSessionInUrl: false,
      })
    : undefined;

  // Undefined until auth-js reads the stored session, so a signed-in user never looks signed out.
  let profile: Profile | null | undefined = auth ? undefined : null;
  const publish = (next: Profile | null) => {
    profile = next;
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("parallax:profile", profile);
  };
  // The last picture fetched, so an hourly token refresh doesn't fetch it again.
  let picture: { url: string; data: string | undefined } | undefined;
  // Each change gets a number, so a slow picture fetch never overwrites a newer profile.
  let changes = 0;
  auth?.onAuthStateChange((_event, session) => {
    const change = ++changes;
    const user: User | undefined = session?.user;
    if (!user) return publish(null);
    const shown = { name: nameOf(user.user_metadata), email: user.email ?? "" };
    const url = pictureUrl(user.user_metadata);
    if (!url || url === picture?.url) return publish({ ...shown, picture: url && picture?.data });
    // The name now, the picture once it's here. Not awaited: auth-js holds a lock while this runs.
    publish(shown);
    void fetchPicture(url).then((data) => {
      picture = { url, data };
      if (change === changes) publish({ ...shown, picture: data });
    });
  });

  // The open sign-in page, if any. Its last OAuth sign-in's PKCE flow id picks the verifier its
  // code is traded with. Sign-up's email link has no id, and uses the latest verifier.
  let page: SignInPage | undefined;

  ipcMain.handle("parallax:profile", () => profile);

  ipcMain.handle("parallax:signIn", async (_event, create: boolean) => {
    if (!auth) return notSetUp;
    // One page at a time, so a late one can't switch accounts.
    page?.close();
    let flowId: string | undefined;
    const signedIn = (error: { message: string } | null): Answer =>
      error ? { error: error.message } : { signedIn: true };
    const current = await serveSignIn({
      oauthUrl: async (provider, redirectTo) => {
        const { data, error } = await auth.signInWithOAuth({
          provider,
          options: { redirectTo, skipBrowserRedirect: true },
        });
        if (error) return { error: error.message };
        flowId = data.flowId ?? undefined;
        return data.url;
      },
      signIn: async (email, password) =>
        signedIn((await auth.signInWithPassword({ email, password })).error),
      signUp: async (account, redirectTo) => {
        flowId = undefined;
        const { data, error } = await auth.signUp({
          email: account.email,
          password: account.password,
          options: {
            emailRedirectTo: redirectTo,
            data: { first_name: account.firstName.trim(), last_name: account.lastName.trim() },
          },
        });
        if (error || data.session) return signedIn(error);
        // The link comes back to this page, which waits an hour, as long as Supabase's links last
        // by default. A later click still confirms the account.
        return { note: `Check ${account.email} for a link to confirm your account.` };
      },
      exchange: async (code) =>
        signedIn((await auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)).error),
    });
    page = current;
    await shell.openExternal(create ? `${current.url}?create` : current.url);
    const error = await current.done;
    if (page === current) page = undefined;
    if (!error) bringForward();
    return error;
  });

  ipcMain.handle("parallax:signOut", async () => {
    page?.close();
    // Local: other devices stay signed in.
    await auth?.signOut({ scope: "local" });
  });
}
