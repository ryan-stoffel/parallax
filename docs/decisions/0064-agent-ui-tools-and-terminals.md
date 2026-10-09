# 0064: plxd owns terminals, and agents get browser, HTML, and device tools

- Status: accepted; supersedes in part [0022](0022-desktop-app.md) (terminals in the app's main process)
- Date: 2026-10-09
- Issue: PLX-636, for PLX-637, PLX-639, PLX-640, and PLX-650

## Context

Parallax's terminals live in the app's main process: `apps/desktop/src/main/terminal.ts` with `node-pty` 1.2.0-beta.15, keyed per window, with no history. Closing the window or quitting kills them. A remote host's shell, installs, and CLI sign-ins run `ssh -t` from the app, Connect devices included (`terminal.ts`, `hosts.ts`). Agents and setup scripts can't use a terminal. `plxd mcp` has thread, PR, context, question, memory, and land tools, and nothing that drives a browser, renders HTML, or controls a simulator (`daemon/src/mcp/`). plxd has no PTY crate, and is 16.1 MB after PLX-611.

T3 Code (`apps/server/src/`):

- **Terminals** (`terminal/Manager.ts`, `NodePtyAdapter.ts`, `docs/internals/terminal-runtime.md`): the server owns PTYs keyed by `(threadId, terminalId)`. History is capped at 5,000 lines and 8 MiB, with terminal query and response escapes stripped, and it is restored on the next open. Every client attaches through the environment connection, and a disconnect only unsubscribes, so the PTY keeps running and clients can share it. A thread's idle-prompt terminals close when it settles. Archive and delete enqueue `terminal.cleanup`, which kills with SIGTERM then SIGKILL and deletes history. Setup scripts run in terminals `setup-<id>` and `settle-<id>-<uuid8>` (`project/ProjectSetupScriptRunner.ts`).
- **Browser preview** (`preview/Manager.ts`, `ServerBrowser.ts`, `PreviewBrowser.ts`, `mcp/toolkits/preview/tools.ts`): tabs keyed by `(threadId, tabId)`, driven by Playwright over CDP. With a desktop app attached, a tab renders in the app's `<webview>` and is driven through its debugger. Otherwise a pinned `chrome-headless-shell`, about 120 MB, is downloaded on first use. A human can take control of a tab, and the agent's actions then stop with "A human controls this tab." Recording uses a CDP screencast, at most 50 MiB. Tools: `preview_status`, `_open`, `_dialog`, `_navigate`, `_resize`, `_set_appearance`, `_snapshot`, `_click`, `_type`, `_hover`, `_select`, `_drag`, `_upload`, `_press`, `_scroll`, `_evaluate`, `_wait_for`, `_recording_start`, `_recording_stop`, and `t3_preview_list`, `t3_preview_close`. Delete enqueues `preview.cleanup`.
- **HTML** (`mcp/toolkits/html/tools.ts`): `html_preview` renders in the headless browser and returns a PNG, its height, and console output. `html_render` shows the page inline above the agent's final reply.
- **Devices** (`device/`, `docs/internals/devices.md`, `mcp/toolkits/device/tools.ts`): `device_list`, `device_open`, `device_screenshot`, `device_close`. iOS through `xcrun simctl`, Android through `adb`. expo-device-hub streams the screen and the `agent-device` CLI drives it, both installed at pinned versions after the user consents, with the CLI on the agent's `PATH`. The hub listens only on loopback behind the server's authenticated proxy. `device_open` shows the device in the app's Device panel.

## Decision

### Terminals

- plxd owns PTYs, keyed by `(threadId, terminalId)`, with T3's history caps and escape stripping. History is saved in the data folder and restored on the next open. Methods: `terminal/open`, `write`, `resize`, `close`, `list`, and `terminal/attach`, which streams output as notifications on the connection that asked. A disconnect detaches. It doesn't kill.
- The PTY is plxd's own code with no new crate: `rustix`'s `pty` module on macOS and Linux, and ConPTY (`CreatePseudoConsole`) through `windows-sys`'s `Win32_System_Console`, already a dependency.
- Settle closes a thread's terminals that sit at an idle prompt. Archive and delete enqueue `terminal.cleanup` ([0059](0059-orchestration-rewrite.md)).
- The app's terminal panel attaches to plxd for every host, so a remote terminal is plxd's, not `ssh -t`. Provider installs and CLI sign-ins run in plxd terminals too. `node-pty` and `terminal.ts` leave the app.
- Setup and settle scripts (PLX-650) run in terminals `setup-<id>` and `settle-<id>-<uuid8>`, as T3.

### Browser preview and HTML

- A Node sidecar, `sidecar/preview`, runs Playwright (`playwright-core`, pinned to T3's 1.60.0) for every thread's tabs, keyed by `(threadId, tabId)`. It installs on first use into `<data>/tools/preview/`, like 0053's Cursor SDK, and needs Node 22 or newer. `chrome-headless-shell` downloads on first use into `<data>/tools/`.
- When the app runs on the same computer as plxd and is attached, tabs render in the app's `<webview>`, driven through its debugger over the app's connection. Otherwise they run headless, and the app shows a screencast of the tab.
- T3's control rules, recording limit, and tools, with `preview_list` and `preview_close` for `t3_preview_list` and `t3_preview_close`. `html_preview` and `html_render` render through the same sidecar. `preview.cleanup` closes a deleted thread's tabs.

### Devices

- `device_list`, `device_open`, `device_screenshot`, and `device_close`, with `xcrun simctl` on macOS and `adb` where the Android SDK is installed. expo-device-hub and `agent-device` install at T3's pinned versions into `<data>/tools/` after the user agrees in the app, and `agent-device` goes on the thread's `PATH`. The hub listens on loopback only, and the app reaches it through plxd. A host with neither toolchain answers `device_list` with why.

### All tools

- They are `plxd mcp` tools (0041), so every thread on every provider gets them. They act only on their own thread's terminals, tabs, and devices, except reads, as T3.

## Consequences

- Terminals outlive the window and the app, keep their history, and work the same on local, SSH, and Connect hosts. The app loses `node-pty`'s native module.
- plxd gains PTY code for three OSes but no dependency. PLX-637 checks the binary size.
- Browser tools need Node 22 and a one-time 120 MB download per host. Device tools need Xcode or the Android SDK.
- Agents can test the UI they build, show rendered HTML in the transcript, and drive simulators, which the thread tools couldn't.
