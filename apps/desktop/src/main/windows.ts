import { BrowserWindow, type WebContents } from "electron";

/** Sends `channel` with `args` to every window. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args);
}

/**
 * `sender`'s own map in `all`, made on first use. `end` runs on it when the window reloads or
 * closes, since nothing there can use its entries any more, and a closed window's map goes.
 */
export function perWindow<T>(
  all: Map<WebContents, Map<string, T>>,
  sender: WebContents,
  end: (own: Map<string, T>) => void,
): Map<string, T> {
  let own = all.get(sender);
  if (!own) {
    const created = new Map<string, T>();
    // `did-navigate` fires when a main-frame navigation commits, such as a reload. Not
    // `did-start-navigation`, which also fires for link clicks that `will-navigate` cancels.
    sender.on("did-navigate", () => end(created));
    sender.once("destroyed", () => {
      end(created);
      all.delete(sender);
    });
    all.set(sender, created);
    own = created;
  }
  return own;
}
