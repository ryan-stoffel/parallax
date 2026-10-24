import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  app,
  BrowserWindow,
  net,
  session as sessions,
  type ContextMenuParams,
  type Extension,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
} from "electron";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { unzipSync } from "fflate";

import type { BrowserAction, ExtensionInfo } from "../preload/bridge";

// Chrome extensions in the side panel's browser (PLX-888). Electron loads unpacked folders only,
// and only on each launch, so the folders are listed in a file and loaded again at startup. One
// from the Chrome Web Store is downloaded and unpacked into a folder of its own here first.
// electron-chrome-extensions supplies the Chrome APIs Electron lacks, such as tabs, windows, the
// toolbar's actions and their popups, and context menus, over the browser's tabs, which are the
// side panel's webviews.

let chrome: ElectronChromeExtensions | undefined;
// The browser tab shown last, which `chrome.tabs` calls active.
let active: WebContents | undefined;
// Tabs an extension asked for, each waiting for the next webview to attach.
const waiting: ((tab: WebContents) => void)[] = [];
// Asks a tab's browser view (Browser.tsx) for something, as main.ts does for its pages.
let tellTab: (tab: WebContents, action: BrowserAction) => void = () => {};

/**
 * Sets up the Chrome extension APIs for the browser's session, before any extension loads.
 * `tell` asks the renderer to open, show, or close a tab.
 */
export function startExtensions(
  session: Session,
  tell: (tab: WebContents, action: BrowserAction) => void,
) {
  tellTab = tell;
  // ponytail: GPL-3.0 is the library's free license, which binds the app's distribution; Ryan
  // decides between it and the Patron license (PLX-888).
  chrome = new ElectronChromeExtensions({
    license: "GPL-3.0",
    session,
    createTab: async (details) => [await openTab(details.url), hostWindow()],
    selectTab: (tab) => tellTab(tab, { kind: "select" }),
    removeTab: (tab) => tellTab(tab, { kind: "closeTab" }),
    createWindow: async (details) => {
      await openTab([details.url ?? []].flat()[0]);
      return hostWindow();
    },
  });
  chrome.on("browser-action-popup-created", fitPopup);
  const filePath = path.join(__dirname, "../preload/extensionBrowser.cjs");
  for (const type of ["frame", "service-worker"] as const)
    session.registerPreloadScript({ type, filePath });
  // The Chrome Web Store's install calls, on its pages only (webStore.ts).
  session.registerPreloadScript({
    type: "frame",
    filePath: path.join(__dirname, "../preload/webStore.cjs"),
  });
  // The toolbar's extension buttons draw their icons from crx:// in the app's own session.
  ElectronChromeExtensions.handleCRXProtocol(sessions.defaultSession);
  // Each extension's worker asks, as it starts, whether its extension was just added, to hear the
  // `runtime.onInstalled` Electron never fires (extensionBrowser.ts). Asked once, it says no after.
  const asking = new WeakSet<ServiceWorkerMain>();
  session.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
    if (runningStatus !== "starting") return;
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker?.scope.startsWith("chrome-extension://") || asking.has(worker)) return;
    asking.add(worker);
    worker.ipc.handle("parallax:extensionAdded", async () => {
      await adding;
      return added.delete(new URL(worker.scope).host);
    });
  });
}

// A page's preferred size, as Chrome sizes an extension's popup: its content's widest line, and
// its height at the width it has.
const measure = `(() => {
  const html = document.documentElement;
  const width = html.style.width;
  html.style.width = "max-content";
  const preferred = Math.ceil(html.getBoundingClientRect().width);
  html.style.width = width;
  return { width: preferred, height: Math.ceil(html.scrollHeight) };
})()`;

/**
 * Sizes an extension's popup to its page while it's open. Electron 44 never reports a popup's
 * preferred size, which the library waits on to size, place, and show it, so main measures the
 * page and reports each change itself, through the event the library listens for.
 */
function fitPopup(popup: { browserWindow?: BrowserWindow; isDestroyed(): boolean }) {
  let last = "";
  const timer = setInterval(() => {
    const page = popup.browserWindow?.webContents;
    if (popup.isDestroyed() || !page || page.isDestroyed()) return clearInterval(timer);
    void page
      .executeJavaScript(measure)
      .then((size: { width: number; height: number }) => {
        if (JSON.stringify(size) === last || page.isDestroyed()) return;
        last = JSON.stringify(size);
        page.emit("preferred-size-changed", {}, size);
      })
      .catch(() => {});
  }, 300);
}

/** A webview `window` attached: a tab for the extensions, and perhaps the one an extension asked for. */
export function addTab(tab: WebContents, window: BrowserWindow) {
  chrome?.addTab(tab, window);
  waiting.shift()?.(tab);
}

/** The tab the user shows now, which extensions see as active. */
export function selectTab(tab: WebContents) {
  active = tab;
  chrome?.selectTab(tab);
}

/** Extensions' items for a page's context menu. */
export const extensionMenuItems = (tab: WebContents, params: ContextMenuParams) =>
  chrome?.getContextMenuItems(tab, params) ?? [];

const hostWindow = () => {
  const host = active && !active.isDestroyed() ? active.hostWebContents : undefined;
  const window = host && BrowserWindow.fromWebContents(host);
  if (!window) throw new Error("Open the side panel's browser first.");
  return window;
};

// ponytail: the next webview to attach answers the oldest request, so a tab the user opens at the
// same moment can stand in for it; tag requests if that ever matters.
async function openTab(url = "https://www.google.com/") {
  if (!active || active.isDestroyed()) throw new Error("Open the side panel's browser first.");
  const attached = new Promise<WebContents>((resolve, reject) => {
    waiting.push(resolve);
    setTimeout(() => {
      const at = waiting.indexOf(resolve);
      if (at < 0) return;
      waiting.splice(at, 1);
      reject(new Error("The tab didn't open."));
    }, 10_000);
  });
  tellTab(active, { kind: "open", url });
  return attached;
}

const root = () => path.join(app.getPath("userData"), "extensions");
const listFile = () => path.join(root(), "extensions.json");

/** The folders loaded at launch. */
async function folders(): Promise<string[]> {
  try {
    const list: unknown = JSON.parse(await readFile(listFile(), "utf8"));
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

async function saveFolders(list: string[]) {
  await mkdir(root(), { recursive: true });
  await writeFile(listFile(), JSON.stringify([...new Set(list)], null, 2));
}

/** A Chrome Web Store extension's id, from a link to its store page or the id itself. */
export function storeId(text: string): string | undefined {
  return /(?:^|\/)([a-p]{32})(?:[/?#]|$)/.exec(text.trim())?.[1];
}

/** The zip inside a CRX file, version 3 or 2, after its magic, version, and signature header. */
export function crxZip(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "Cr24")
    throw new Error("The download isn't a Chrome extension.");
  const version = view.getUint32(4, true);
  if (version === 3) return bytes.subarray(12 + view.getUint32(8, true));
  if (version === 2) return bytes.subarray(16 + view.getUint32(8, true) + view.getUint32(12, true));
  throw new Error(`Chrome extension package version ${version} isn't supported.`);
}

/** The Chrome extension id of a public key: its SHA-256's first 16 bytes, each hex digit as a to p. */
export const crxId = (key: Uint8Array) =>
  createHash("sha256")
    .update(key)
    .digest()
    .subarray(0, 16)
    .toString("hex")
    .replace(/./g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

/**
 * The public key of a CRX3 whose id is `id`, as base64 for the manifest's `key`, so Electron gives
 * the unpacked extension its Chrome Web Store id, which its site, sign-in redirects, and companion
 * apps know it by. Its header is a protobuf: fields 2 and 3 are key proofs, whose field 1 is the key.
 */
export function crxKey(bytes: Uint8Array, id: string): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || view.getUint32(4, true) !== 3) return undefined;
  // Each length-delimited field in `data`, as [field number, its bytes].
  const fields = (data: Uint8Array) => {
    const found: [number, Uint8Array][] = [];
    let at = 0;
    const varint = () => {
      let value = 0;
      for (let shift = 0; at < data.length; shift += 7) {
        const byte = data[at++]!;
        value += (byte & 0x7f) * 2 ** shift;
        if (byte < 0x80) break;
      }
      return value;
    };
    while (at < data.length) {
      const tag = varint();
      const wire = tag & 7;
      if (wire === 2) {
        const length = varint();
        found.push([tag >>> 3, data.subarray(at, at + length)]);
        at += length;
      } else if (wire === 0) varint();
      else return found;
    }
    return found;
  };
  const header = bytes.subarray(12, 12 + view.getUint32(8, true));
  for (const [field, proof] of fields(header)) {
    if (field !== 2 && field !== 3) continue;
    const key = fields(proof).find(([f]) => f === 1)?.[1];
    if (key && crxId(key) === id) return Buffer.from(key).toString("base64");
  }
  return undefined;
}

/**
 * A manifest with `key` added. Chromium also reads one with comments, which `JSON.parse` doesn't,
 * so such a manifest stays as it was, and the extension gets a folder id.
 */
function withKey<T extends Uint8Array>(manifest: T, key: string): T | Uint8Array<ArrayBuffer> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(manifest));
    return new TextEncoder().encode(JSON.stringify({ ...(parsed as object), key }));
  } catch {
    return manifest;
  }
}

/**
 * Loads every listed folder into the browser's session. One that no longer loads, such as a
 * moved unpacked folder, is skipped with a warning and stays listed.
 */
export async function loadExtensions(session: Session) {
  for (const folder of await folders())
    await session.extensions
      .loadExtension(folder)
      .catch((error: unknown) => console.warn(`could not load the extension in ${folder}:`, error));
}

/** The installed extensions, as the browser's toolbar shows them. */
export function listExtensions(session: Session): Promise<ExtensionInfo[]> {
  return Promise.all(session.extensions.getAllExtensions().map(describe));
}

/**
 * Downloads an extension from the Chrome Web Store by its link or id, unpacks it, and loads it.
 * Resolves to it, or to an error for people.
 */
export async function installExtension(
  session: Session,
  text: string,
): Promise<ExtensionInfo | string> {
  const id = storeId(text);
  if (!id) return "Paste a Chrome Web Store link or an extension's id.";
  try {
    const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
    // The app's own session, which no extension's request hooks can touch.
    const answer = await net.fetch(url);
    if (!answer.ok) return `The Chrome Web Store answered ${answer.status}.`;
    const crx = new Uint8Array(await answer.arrayBuffer());
    const files = unzipSync(crxZip(crx));
    // The store's own id, from the package's key, rather than one Electron makes from the folder.
    const key = crxKey(crx, id);
    const manifest = files["manifest.json"];
    if (key && manifest) files["manifest.json"] = withKey(manifest, key);
    const folder = path.join(root(), id);
    await rm(folder, { recursive: true, force: true });
    for (const [name, data] of Object.entries(files)) {
      const file = path.join(folder, name);
      // A name that climbs out of the folder is left out.
      if (!file.startsWith(folder + path.sep) || name.endsWith("/")) continue;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, data);
    }
    return await add(session, folder);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Loads an unpacked extension's folder, as Chrome's Load unpacked does. */
export async function addUnpacked(session: Session, folder: string) {
  try {
    return await add(session, folder);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Extensions added since launch whose worker hasn't yet asked whether it was just installed, and
// the add in progress, whose worker can start before it ends.
const added = new Set<string>();
let adding: Promise<unknown> = Promise.resolve();

async function add(session: Session, folder: string): Promise<ExtensionInfo> {
  const loading = session.extensions.loadExtension(folder);
  adding = loading.then(
    (extension) => added.add(extension.id),
    () => {},
  );
  const extension = await loading;
  await saveFolders([...(await folders()), folder]);
  return describe(extension);
}

/** Unloads an extension and forgets it, deleting its folder when it came from the store. */
export async function removeExtension(session: Session, id: string) {
  const extension = session.extensions.getExtension(id);
  if (!extension) return;
  session.extensions.removeExtension(id);
  await saveFolders((await folders()).filter((f) => f !== extension.path));
  if (extension.path.startsWith(root() + path.sep))
    await rm(extension.path, { recursive: true, force: true });
}

async function describe(extension: Extension): Promise<ExtensionInfo> {
  const manifest = extension.manifest as Manifest;
  const action = manifest.action ?? manifest.browser_action;
  const icon = pickIcon(action?.default_icon) ?? pickIcon(manifest.icons);
  return {
    id: extension.id,
    name: await localized(extension, manifest, manifest.short_name ?? extension.name),
    version: extension.version,
    ...(icon && { icon: await inline(extension.path, icon) }),
    ...(action?.default_popup && {
      popup: `chrome-extension://${extension.id}/${action.default_popup.replace(/^\//, "")}`,
    }),
  };
}

interface Manifest {
  short_name?: string;
  default_locale?: string;
  icons?: Record<string, string>;
  action?: { default_icon?: string | Record<string, string>; default_popup?: string };
  browser_action?: { default_icon?: string | Record<string, string>; default_popup?: string };
}

/** The icon nearest 32 pixels, from a manifest's icon or set of icons by size. */
function pickIcon(icons: string | Record<string, string> | undefined) {
  if (typeof icons === "string" || !icons) return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32));
  return sizes.length ? icons[String(sizes[0])] : undefined;
}

async function inline(folder: string, file: string) {
  const type = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
  const data = await readFile(path.join(folder, file.replace(/^\//, ""))).catch(() => undefined);
  return data && `data:${type};base64,${data.toString("base64")}`;
}

/** A manifest string, with a `__MSG_name__` read from the extension's default locale. */
async function localized(extension: Extension, manifest: Manifest, text: string) {
  const key = /^__MSG_(\w+)__$/.exec(text)?.[1];
  if (!key || !manifest.default_locale) return text;
  try {
    const file = path.join(extension.path, "_locales", manifest.default_locale, "messages.json");
    const messages = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      { message?: string }
    >;
    const entry = Object.entries(messages).find(([k]) => k.toLowerCase() === key.toLowerCase());
    return entry?.[1].message ?? text;
  } catch {
    return text;
  }
}
