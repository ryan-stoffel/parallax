import { AuthClient, type SupportedStorage, type User } from "@supabase/auth-js";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

import type { Profile } from "../preload/bridge";
import { serveSignIn, type Answer, type SignInPage } from "./loopback";
import { broadcast } from "./windows";

// The Supabase project that holds Parallax accounts (0037). Both values are public: the key only
// names the project. PLX_SUPABASE_URL and PLX_SUPABASE_KEY point a dev build at another project.
const SUPABASE_URL = process.env["PLX_SUPABASE_URL"] ?? "https://hkfrqrikselgxhoswgtk.supabase.co";
const SUPABASE_KEY =
  process.env["PLX_SUPABASE_KEY"] ?? "sb_publishable_YYLxUEvqEOWBt000SGDoiA_i5_vhanC";

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

/**
 * The first and last name the user gave, at sign-up or in Settings > Account, or else their
 * provider's, split at its first space: GitHub and Google send `full_name`.
 */
export function namesOf(meta: Record<string, unknown>): Pick<Profile, "firstName" | "lastName"> {
  const text = (key: string) => (typeof meta[key] === "string" ? meta[key].trim() : "");
  if (text("first_name") || text("last_name"))
    return { firstName: text("first_name"), lastName: text("last_name") };
  const [firstName = "", ...rest] = (text("full_name") || text("name")).split(/\s+/);
  return { firstName, lastName: rest.join(" ") };
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
 * main serves on loopback (loopback.ts), with PKCE. Call once the app is ready, as safeStorage
 * needs.
 */
export function startAccount() {
  const auth = new AuthClient({
    url: `${SUPABASE_URL}/auth/v1`,
    headers: { apikey: SUPABASE_KEY },
    storage: encryptedStorage(path.join(app.getPath("userData"), "account")),
    flowType: "pkce",
    detectSessionInUrl: false,
    // Each redirect carries its PKCE flow id, so a sign-up's email link and an OAuth sign-in
    // started on the same page each trade their code with their own verifier. Sign-up has no
    // other way to name its flow. Experimental in auth-js: recheck it on upgrades (PLX-300).
    experimental: { appendPkceFlowIdToRedirects: true },
  });

  // Undefined until auth-js reads the stored session, so a signed-in user never looks signed out.
  let profile: Profile | null | undefined;
  const publish = (next: Profile | null) => {
    profile = next;
    broadcast("parallax:profile", profile);
  };
  // The last picture fetched, so an hourly token refresh doesn't fetch it again.
  let picture: { url: string; data: string | undefined } | undefined;
  // Each change gets a number, so a slow picture fetch never overwrites a newer profile.
  let changes = 0;
  auth.onAuthStateChange((_event, session) => {
    const change = ++changes;
    const user: User | undefined = session?.user;
    if (!user) return publish(null);
    const names = namesOf(user.user_metadata);
    const name = [names.firstName, names.lastName].filter(Boolean).join(" ");
    const shown = { ...names, name, email: user.email ?? "" };
    const url = pictureUrl(user.user_metadata);
    if (!url || url === picture?.url) return publish({ ...shown, picture: url && picture?.data });
    // The name now, the picture once it's here. Not awaited: auth-js holds a lock while this runs.
    publish(shown);
    void fetchPicture(url).then((data) => {
      picture = { url, data };
      if (change === changes) publish({ ...shown, picture: data });
    });
  });

  // The open sign-in page, if any.
  let page: SignInPage | undefined;

  ipcMain.handle("parallax:profile", () => profile);

  ipcMain.handle("parallax:signIn", async (_event, create: boolean) => {
    // One page at a time, so a late one can't switch accounts.
    page?.close();
    const signedIn = (error: { message: string } | null): Answer =>
      error ? { error: error.message } : { signedIn: true };
    const current = await serveSignIn({
      oauthUrl: async (provider, redirectTo) => {
        const { data, error } = await auth.signInWithOAuth({
          provider,
          options: { redirectTo, skipBrowserRedirect: true },
        });
        return error ? { error: error.message } : data.url;
      },
      signIn: async (email, password) =>
        signedIn((await auth.signInWithPassword({ email, password })).error),
      signUp: async (account, redirectTo) => {
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
      exchange: async (code, flowId) =>
        signedIn((await auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined)).error),
    });
    page = current;
    const url = new URL(current.url);
    if (create) url.searchParams.set("create", "");
    try {
      await shell.openExternal(url.href);
    } catch (error) {
      current.close();
      return `Couldn't open your browser: ${(error as Error).message}`;
    }
    const error = await current.done;
    if (page === current) page = undefined;
    if (!error) bringForward();
    return error;
  });

  // Settings > Account's name. Saved where sign-up keeps it, which a provider's sign-in leaves
  // alone; the profile republishes when Supabase answers.
  ipcMain.handle("parallax:saveName", async (_event, firstName: unknown, lastName: unknown) => {
    if (typeof firstName !== "string" || typeof lastName !== "string") return "Enter a name.";
    const { error } = await auth.updateUser({
      data: { first_name: firstName.trim(), last_name: lastName.trim() },
    });
    return error?.message;
  });

  ipcMain.handle("parallax:signOut", async () => {
    page?.close();
    // Local: other devices stay signed in.
    await auth.signOut({ scope: "local" });
  });
}
