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
- The library is dual-licensed: GPL-3.0, or a Patron license for those sponsoring its author. The code selects `GPL-3.0`, which binds the app's distribution to GPL-3.0 while this repository stays Apache-2.0. Ryan confirms that or sponsors and switches the code to `Patron-License-2020-11-19`.

## Consequences

- Dark Reader and Bitwarden work, popups included. 1Password installs, but its popup waits on a background that never answers, likely because Electron has no native messaging or offscreen documents.
- Native messaging, which desktop-app integrations such as 1Password's unlock need, stays out of reach in Electron. Running a real Chrome is the way to get it.
- The library's preload ships beside `main.cjs`, which `vite.config.ts` copies there, since the packaged app has no `node_modules`.
