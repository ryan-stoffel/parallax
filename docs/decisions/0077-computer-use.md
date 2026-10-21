# 0077: Agents use the Mac's apps with Codex's computer use tools, run by plxd

- Status: accepted
- Date: 2026-10-21
- Issue: PLX-897

## Context

Agents can drive a browser tab (`preview_*`, [0064](0064-agent-ui-tools-and-terminals.md)) and a simulator (`device_*`), but not a desktop app. Codex's desktop app has Computer Use on macOS: the agent reads an app's window as an accessibility tree and a screenshot, then clicks, types, scrolls, and presses keys in it. The user allows each app the first time, and Settings lists the apps always allowed. It can't control terminals or Codex itself, and its events reach the app without taking the user's pointer.

macOS gates this behind two permissions, Accessibility and Screen Recording, which it checks against the responsible process. A thread's `plxd mcp` descends from `plxd serve`, which the Parallax `LaunchAgent` starts, so the permissions are plxd's, not the app's.

## Decision

- `plxd mcp` serves Codex's nine tools on macOS, prefixed `computer_` as the other plxd tools are prefixed: `list_apps`, `get_app_state`, `click`, `perform_secondary_action`, `scroll`, `drag`, `type_text`, `press_key`, and `set_value`, with Codex's snake_case inputs. Other OSes don't list them.
- `get_app_state` reads the app's focused window through Accessibility as numbered lines, leaving out empty containers, and screenshots it with `screencapture -l`, at most 1568 pixels a side. Every action answers with the state after it. An action names an element by its number, or a point in the latest screenshot's pixels. A plain click on an element with `AXPress` presses it; anything else is a Quartz event posted to the app's process with `CGEventPostToPid`.
- The system calls are in `daemon/src/computer/macos.rs`, the second module allowed `unsafe` after `windows.rs`, on `core-foundation`, which `security-framework` already builds.
- A thread's first use of an app calls `computer/ask`. The run's actor logs an `approvalRequested` item with tool `computer_use`, input `{"app"}`, and `alwaysAllow: [app]`, so the app's approval card asks "Allow Parallax to use Notes?" with Deny, Always allow, and Allow. `agent/approve` answers it in plxd rather than the CLI. Allow lasts for the thread's `plxd mcp`; Always allow saves the app to `computer-use.json` in plxd's data folder, for every thread.
- Terminals, Parallax, and Keychain Access are refused by bundle id.
- `computer/status` reports both permissions and the always-allowed apps, asking macOS for what's missing with `request`, and `computer/forget` removes an app. Behind the `computerUse` capability, which only a macOS plxd advertises. Settings > Computer use shows them for this computer.

## Consequences

- Agents can operate any app with an accessibility tree, and check what they did, without the user's pointer moving.
- The user grants plxd, not Parallax, both permissions, and macOS lists it as `plxd`. Settings says so.
- Some apps ignore events posted to a process in the background; the agent can still act on elements, which most controls offer.
- Windows (UI Automation), Linux (AT-SPI), and an overlay over the app being controlled are left for later.
