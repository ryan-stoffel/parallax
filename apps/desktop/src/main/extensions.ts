import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { app, net, type Extension, type Session } from "electron";
import { unzipSync } from "fflate";

import type { ExtensionInfo } from "../preload/bridge";

// Chrome extensions in the side panel's browser (PLX-888). Electron loads unpacked folders only,
// and only on each launch, so the folders are listed in a file and loaded again at startup. One
// from the Chrome Web Store is downloaded and unpacked into a folder of its own here first.

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

/**
 * Loads every listed folder into the browser's session. One that no longer loads, such as a
 * moved unpacked folder, is skipped with a warning and stays listed.
 */
export async function loadExtensions(session: Session) {
  // The fill-in for APIs Electron lacks, in extensions' pages and workers (extensionShim.ts).
  const filePath = path.join(__dirname, "../preload/extensionShim.cjs");
  for (const type of ["frame", "service-worker"] as const)
    session.registerPreloadScript({ type, filePath });
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
    const files = unzipSync(crxZip(new Uint8Array(await answer.arrayBuffer())));
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

async function add(session: Session, folder: string): Promise<ExtensionInfo> {
  const extension = await session.extensions.loadExtension(folder);
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
