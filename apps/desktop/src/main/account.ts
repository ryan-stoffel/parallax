import { AuthClient, type SupportedStorage, type User } from "@supabase/auth-js";
import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

import type { NewAccount, OAuthProvider, Profile } from "../preload/bridge";
import { listenForCode, type Loopback } from "./loopback";

// The Supabase project that holds Parallax accounts (0034). Both values are public: the key only
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

/**
 * Starts the Parallax account (0034): a Supabase Auth session kept in the main process, so the
 * renderer only ever sees the profile. Sign-ins use PKCE, and come back from the browser to a
 * loopback server (loopback.ts). Call once the app is ready, as safeStorage needs.
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

  // Sign-ins waiting on the browser. Each OAuth one keeps the id of its own PKCE verifier, so two
  // at once both work. Sign-up's email link has no id, and uses the latest verifier.
  const pending = new Set<Loopback>();
  const listen = async (flow: { id?: string }, timeoutMs?: number) => {
    const loopback: Loopback = await listenForCode(async (code) => {
      try {
        const options = flow.id ? { flowId: flow.id } : undefined;
        const { error } = await auth!.exchangeCodeForSession(code, options);
        // Signed in: the other browser sign-ins end, so a late one can't switch accounts.
        if (!error) for (const other of pending) if (other !== loopback) other.close();
        return error?.message;
      } catch (error) {
        return (error as Error).message;
      }
    }, timeoutMs);
    pending.add(loopback);
    void loopback.done.then(() => pending.delete(loopback));
    return loopback;
  };
  // Another way in, or out, ends the browser sign-ins, so a late one can't switch accounts.
  const cancelPending = () => {
    for (const loopback of pending) loopback.close();
  };

  ipcMain.handle("parallax:profile", () => profile);

  ipcMain.handle("parallax:signInWith", async (_event, provider: OAuthProvider) => {
    if (!auth) return notSetUp;
    if (!["github", "google", "apple"].includes(provider)) return "Unknown provider.";
    const flow: { id?: string } = {};
    const loopback = await listen(flow);
    const { data, error } = await auth.signInWithOAuth({
      provider,
      options: { redirectTo: loopback.url, skipBrowserRedirect: true },
    });
    if (error) {
      loopback.close();
      return error.message;
    }
    flow.id = data.flowId ?? undefined;
    await shell.openExternal(data.url);
    return loopback.done;
  });

  ipcMain.handle("parallax:signInWithEmail", async (_event, email: string, password: string) => {
    if (!auth) return notSetUp;
    cancelPending();
    const { error } = await auth.signInWithPassword({ email, password });
    return error?.message;
  });

  ipcMain.handle("parallax:signUp", async (_event, account: NewAccount) => {
    if (!auth) return notSetUp;
    cancelPending();
    // The confirmation email's link comes back here too, and signs the app in, for as long as
    // Supabase's links last by default. A later click still confirms the account.
    const loopback = await listen({}, 60 * 60_000);
    const { data, error } = await auth.signUp({
      email: account.email,
      password: account.password,
      options: {
        emailRedirectTo: loopback.url,
        data: { first_name: account.firstName.trim(), last_name: account.lastName.trim() },
      },
    });
    if (error || data.session) {
      loopback.close();
      return error?.message;
    }
    return `Check ${account.email} for a link to confirm your account.`;
  });

  ipcMain.handle("parallax:signOut", async () => {
    cancelPending();
    // Local: other devices stay signed in.
    await auth?.signOut({ scope: "local" });
  });
}
