import { app, net, protocol, session, WebContentsView } from "electron";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The built renderer loads from app://renderer rather than file:// because Chromium keeps a V8
// code cache only for a scheme with the codeCache privilege: from the third launch after an
// update, the main chunk compiles in about 20 ms instead of 60 (PLX-625). The page's CSP 'self'
// and links.ts's reload check work the same on it.
export const rendererUrl = "app://renderer/index.html";
const rendererDir = path.join(__dirname, "../renderer");

/** Registers the app scheme. Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "app", privileges: { standard: true, secure: true, codeCache: true } },
  ]);
}

/** The file in `dir` an app:// URL names, or undefined when it names one outside it. */
export function rendererFile(url: string, dir = rendererDir): string | undefined {
  const file = path.join(dir, decodeURIComponent(new URL(url).pathname));
  return file.startsWith(dir + path.sep) ? file : undefined;
}

const notFound = () => new Response(null, { status: 404 });

/**
 * Serves dist/renderer (inside app.asar when packaged) at app://renderer, and 404 for the rest.
 * The first time, it copies the file:// origin's localStorage over before resolving.
 */
export async function serveAppScheme(): Promise<void> {
  const userData = app.getPath("userData");
  const copied = path.join(userData, "app-scheme-storage-copied");
  const done = existsSync(copied);
  // Read before protocol.handle opens the default session, which creates `Local Storage`.
  const hasStorage = existsSync(path.join(userData, "Local Storage"));
  protocol.handle("app", async (request) => {
    const file = rendererFile(request.url);
    return file ? net.fetch(pathToFileURL(file).href).catch(notFound) : notFound();
  });
  if (done) return;
  try {
    // A new install has none to copy.
    if (hasStorage) await copyFileStorage();
    await writeFile(copied, "");
  } catch (error) {
    console.warn("could not copy localStorage:", error);
  }
}

/**
 * Copies the file:// origin's localStorage (theme, prefs, Actions, the Open target, thread
 * titles) into app://renderer, before the first app:// page reads it, since localStorage is kept
 * per origin. The file:// copy stays, so a build still on file:// (Stable shares userData with
 * Nightly) keeps working on it. Neither page runs the app's scripts: the file:// one is
 * package.json as text, the app:// one a 404.
 *
 * Remove, with its call, once every install has launched an app:// build, a few Stable releases
 * after the first.
 */
async function copyFileStorage(): Promise<void> {
  // Used through `view` each time: a view that is garbage collected mid-load fails its loads.
  const view = new WebContentsView();
  await view.webContents.loadURL(pathToFileURL(path.join(app.getAppPath(), "package.json")).href);
  const items = (await view.webContents.executeJavaScript(
    "JSON.stringify(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))]))",
  )) as string;
  await view.webContents.loadURL("app://renderer/storage-copy");
  await view.webContents.executeJavaScript(
    `for (const [k, v] of ${items}) localStorage.setItem(k, v)`,
  );
  view.webContents.close();
  session.defaultSession.flushStorageData();
}
