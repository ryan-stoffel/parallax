# 0076: The side panel browser runs Chrome extensions through electron-chrome-extensions

- Status: accepted; the license is pending Ryan's confirmation
- Date: 2026-10-21
- Issue: PLX-888

## Context

Ryan wants Chrome extensions such as password managers in the side panel browser. Electron loads unpacked extensions and runs their content scripts, workers, `chrome.runtime`, `chrome.storage.local`, and part of `chrome.tabs`. It has no toolbar actions or popups, no `chrome.windows`, and no real tabs, so Bitwarden's and 1Password's popups stayed blank under a fill-in of our own. [electron-chrome-extensions](https://github.com/samuelmaddock/electron-chrome-extensions) implements those APIs over an app's own tabs and windows. Running a real Chrome over the DevTools protocol, as the agent's tabs do, was the other option. It would give native messaging too, but the page would be a streamed image.

## Decision

- The app depends on electron-chrome-extensions. Main creates it for the browser's session before any extension loads. Each page webview is a tab, and the shown tab is its active one. An extension's new tabs and windows open as tabs in the panel.
- The toolbar uses its `<browser-action-list>` element, which draws each extension's button and badge and opens its popup. Electron 44 never reports a popup's preferred size, which the library waits on, so main measures the popup's page and reports the size itself.
- Extensions install from a Chrome Web Store link (main downloads the CRX, unpacks it, and gives it its store id from the CRX3 key) or an unpacked folder, and load again at each launch.
- The store's own Add to Chrome button installs too (PLX-962). The browser's user agent is Chrome's, without Electron's and the app's tokens, which enables the button. A preload on the store's pages fills in `chrome.webstorePrivate` and `chrome.management` with the calls electron-chrome-web-store answers, and main answers them from that origin only, through the same download as a pasted link, after the user confirms. Remove from Chrome confirms too. That library was the other option, but it installs into its own folder layout, which would have been a second install path. The store still shows its "Switch to Chrome" banner, which doesn't block installing.
- The browser is apart from the side panel's views (PLX-962). The right column shows one or the other: the top bar's globe (Mod+Shift+B) toggles the browser, whose top bar has only its page tabs, and the side panel button toggles the views, which no longer list Browser.
- The sidebar's footer opens a permanent browser in the main pane, apart from every chat's (PLX-964). Each browser's own tabs are saved in localStorage by scope, the newest 100 browsers kept, and come back after a restart, each tab loading when first shown. Every browser shares the one session, so sign-ins and extensions carry over.
- The library is dual-licensed: GPL-3.0, or a Patron license for those sponsoring its author. The code selects `GPL-3.0`, which binds the app's distribution to GPL-3.0 while this repository stays Apache-2.0. Ryan confirms that or sponsors and switches the code to `Patron-License-2020-11-19`.

## Consequences

- Dark Reader, Bitwarden, and 1Password work, popups included. 1Password needed `browser` pointed at the filled-in `chrome`: Chromium gives extensions a separate `browser` namespace, which the library doesn't fill in, and 1Password uses it.
- The library supports native messaging, through the native host manifests Chrome reads. Store installs keep their store ids, so a desktop app's host lists them in `allowed_origins` and the extension can start that host from Parallax, as it would from Chrome. Whether a desktop app accepts the connection is up to it: 1Password's browser helper checks which browser is calling, so its desktop unlock may need Parallax added as a trusted browser in 1Password's settings.
- The library's preload ships beside `main.cjs`, which `vite.config.ts` copies there, since the packaged app has no `node_modules`.
