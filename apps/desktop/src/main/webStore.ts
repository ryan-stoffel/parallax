import {
  BrowserWindow,
  dialog,
  type Extension,
  type IpcMainInvokeEvent,
  type Session,
} from "electron";

import { installExtension, removeExtension } from "./extensions";

// The Chrome Web Store's install button in the side panel's browser (PLX-962). The store enables
// Add to Chrome only for a Chrome user agent, and installs through `chrome.webstorePrivate` and
// `chrome.management`, which Chrome gives its pages alone. The webStore preload fills those in on
// the store's pages and asks main here, which installs through the same download as a pasted store
// link (extensions.ts), so either way an extension lands in one folder and one list. The calls
// mirror electron-chrome-web-store's, whose own installer keeps a layout of its own.

export const storeOrigin = "https://chromewebstore.google.com";

/**
 * The user agent with Electron's and the app's tokens taken out, so pages see plain Chrome. A
 * nightly's name, `Parallax (Nightly)`, arrives as `Parallax(Nightly)/<version>`.
 */
export const chromeUserAgent = (userAgent: string) =>
  userAgent.replace(/ (?!(?:AppleWebKit|Chrome|Safari)\/)\S+\/\S+/g, "");

/**
 * What the store shows for an extension: added, too old for Chrome to install (Manifest V2, as
 * Chrome now treats it), or installable. `manifest` is the store's JSON for it, if any.
 */
export function storeStatus(installed: boolean, manifest: unknown) {
  if (installed) return "enabled";
  try {
    const version = (JSON.parse(String(manifest)) as { manifest_version?: unknown })
      .manifest_version;
    if (typeof version === "number" && version < 3) return "deprecated_manifest_version";
  } catch {
    // A missing or unreadable manifest leaves the store to decide.
  }
  return "installable";
}

// Extensions being installed, so a second click waits for the first.
const installing = new Set<string>();

/**
 * Answers one of the store page's calls (webStore.ts in preload) for the browser's `session`. Main
 * passes only calls from the store's own origin.
 */
export async function answerStore(
  session: Session,
  event: IpcMainInvokeEvent,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const id = typeof args[0] === "string" ? args[0] : "";
  switch (method) {
    case "getExtensionStatus":
      return storeStatus(!!session.extensions.getExtension(id), args[1]);
    case "getAll":
      return session.extensions.getAllExtensions().map(info);
    case "beginInstall":
      return begin(session, event, args[0]);
    case "uninstall": {
      const extension = session.extensions.getExtension(id);
      if (!extension) return "success";
      const confirmed = await confirm(event, {
        message: `Remove “${extension.name}”?`,
        button: "Remove",
      });
      if (!confirmed) return "user_cancelled";
      await removeExtension(session, id);
      changed();
      return "success";
    }
    default:
      return undefined;
  }
}

/** Asks to add the extension the store's button names, then installs it from the store. */
async function begin(session: Session, event: IpcMainInvokeEvent, details: unknown) {
  const { id, localizedName } = (details ?? {}) as { id?: unknown; localizedName?: unknown };
  if (typeof id !== "string") return { result: "invalid_id" };
  if (session.extensions.getExtension(id)) return { result: "already_installed" };
  if (installing.has(id)) return { result: "install_in_progress" };
  installing.add(id);
  try {
    const name = typeof localizedName === "string" ? localizedName : "this extension";
    const confirmed = await confirm(event, {
      message: `Add “${name}”?`,
      detail: "It runs in Parallax's browser, as it would in Chrome.",
      button: "Add Extension",
    });
    if (!confirmed) return { result: "user_cancelled" };
    const answer = await installExtension(session, id);
    if (typeof answer === "string") return { result: "install_error", message: answer };
    changed();
    const extension = session.extensions.getExtension(id);
    return { result: "success", ...(extension && { info: info(extension) }) };
  } finally {
    installing.delete(id);
  }
}

/** Asks the user, over the window that shows the store's page, as Chrome asks before a change. */
async function confirm(
  event: IpcMainInvokeEvent,
  ask: { message: string; detail?: string; button: string },
) {
  const page = event.sender;
  const window = BrowserWindow.fromWebContents(page.hostWebContents ?? page);
  const options = {
    type: "question" as const,
    message: ask.message,
    ...(ask.detail && { detail: ask.detail }),
    buttons: [ask.button, "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = await (window
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options));
  return response === 0;
}

/** Tells every window the installed list changed, so the browser's toolbar shows it. */
function changed() {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("parallax:extensionsChanged");
}

/** An extension as `chrome.management` describes one. */
function info(extension: Extension) {
  const manifest = extension.manifest as Record<string, unknown>;
  const text = (key: string) => (typeof manifest[key] === "string" ? manifest[key] : "");
  return {
    id: extension.id,
    name: extension.name,
    shortName: text("short_name") || extension.name,
    description: text("description"),
    version: extension.version,
    enabled: true,
    mayDisable: true,
    isApp: false,
    type: "extension",
    installType: "normal",
    homepageUrl: text("homepage_url"),
    updateUrl: text("update_url"),
    optionsUrl:
      text("options_page") && `chrome-extension://${extension.id}/${text("options_page")}`,
    offlineEnabled: false,
    permissions: Array.isArray(manifest["permissions"]) ? manifest["permissions"] : [],
    hostPermissions: Array.isArray(manifest["host_permissions"])
      ? manifest["host_permissions"]
      : [],
    icons: [],
  };
}
