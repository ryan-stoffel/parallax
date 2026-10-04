# 0022: The desktop app's stack and layout

- Status: accepted; how plxd listens on Linux and Windows, and which `ssh` the app runs on Windows, which this record deferred, are in [0023](0023-cross-platform.md)
- Date: 2026-09-27
- Issue: PLX-6

## Context

0020 dropped the editor fork and left Parallax with no UI until a new frontend was decided. The new frontend is an Electron desktop app in this repo. Users open Projects, laid out like Cursor's, on this machine or on SSH hosts, and chat with their agents. It targets macOS, Windows, and Linux.

The app follows T3 Code (github.com/pingdotgg/t3code): its stack, its layout, and its calm look. We follow its structure and principles only. This repo is public, so no T3 Code assets, icons, or branding are ever committed.

PLX-9 scaffolds the app, PLX-10 generates the protocol types, PLX-12 and PLX-26 connect to plxd, and PLX-13 builds the layout. They all need the same answers first.

## Decision

### Stack

- **App:** Electron, React, and strict TypeScript, in `apps/desktop/`. Its source has three parts: `src/main/`, `src/preload/`, and `src/renderer/`. The renderer is part of the app, not a separate web app, because Parallax has no web server to serve one.
- **Toolchain:** Vite+ (`vite-plus`, MIT), which T3 Code uses. One dev dependency and one `vp` CLI cover:
  - `vp dev` and `vp build`: Vite, for the renderer, with hot reload.
  - `vp pack`: tsdown, which bundles the main process and the preload. Every JS dependency is inlined, as in T3 Code, so packaging never depends on the `node_modules` layout.
  - `vp check`: Oxlint, Oxfmt, and the type-check, in one pass.
  - `vp test`: Vitest.
  - Vite+ is a 1.0 release candidate, so its version is pinned exactly. Each part is a standard tool with its own config block in `vite.config.ts`, so leaving Vite+ means installing those tools directly.
- **Dev loop:** `pnpm dev` runs `vp dev` and `vp pack --watch`, plus a short script that starts Electron on the dev server's URL and restarts it when the main bundle changes. That script is the one piece electron-vite would have given us.
- **Styling:** Tailwind CSS v4 through its Vite plugin, with the themes as CSS variables. PLX-13 adds UI libraries as screens need them, and prefers the ones T3 Code uses.

### Package manager and layout

- **No JS workspace.** `apps/desktop/` is one pnpm package that holds everything: its `package.json`, `pnpm-lock.yaml`, `.node-version`, `vite.config.ts`, and the generated protocol types. There's one app and nothing else to share with. A workspace would only add root files, so we add one when a second package appears.
- pnpm is pinned exactly in `packageManager` to **11.10.0**, the version T3 Code uses, through corepack. We stay on 11 rather than the month-old pnpm 12 rewrite. Node is pinned to 24, the active LTS, in `.node-version`, which CI's `setup-node` also reads. T3 Code also uses Node 24.
- Why pnpm: it's what T3 Code uses, and its strict `node_modules` fails on a dependency that isn't declared. Only dependencies allowed through pnpm's `allowBuilds`, such as `electron`, may run install scripts.
- Run pnpm inside `apps/desktop/`, not with `pnpm -C apps/desktop` from the repo root. Corepack picks the pnpm version from the current directory's `package.json`, and the root has none, so it runs its default pnpm, which rejects the `packageManager` pin with `ERR_PNPM_BAD_PM_VERSION`.

### Transport

0007's client rules now apply to the app. Where 0007 says "the editor", read "the app's main process".

- **Main owns every process.** The main process spawns the child and speaks JSON-RPC over its stdio:
  - Locally, the bundled `plxd attach`. In development, the path comes from `PLXD_PATH`, defaulting to the Cargo debug build.
  - For a host, `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ControlPath=none -- <destination> plxd attach`.
  - It keeps one child per host in use, and 0007's rules hold for each: destination checks, the `initialize` handshake, `host/health` every 30 s with a 10 s liveness window, reconnect with 1 s to 10 s backoff, resubscribing from the last `seq`, and caller-generated ids for creates and starts.
  - Exit status 4 means plxd can't be reached on that machine (0010), 127 means `plxd` isn't installed there, and 255 is an ssh error. The app shows the child's stderr in each case.
- **Client:** a small hand-written NDJSON JSON-RPC 2.0 client in `src/main/`, with no RPC dependency. It splits lines on `\n`, enforces `maxFrameBytes`, matches responses by id, sends `$/cancelRequest`, and routes `events/event` notifications. 0007's plan to reuse Code - OSS's `JsonRpcProtocol` went away with the fork.
- **Renderer:** it never spawns processes and never sees Node.
  - Every window has `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
  - The preload exposes one typed `window.parallax` bridge through `contextBridge`: calls to plxd's methods by host id, event subscriptions, and app actions. Its types come from `src/protocol/`.
  - The renderer names a host by its id. Only the main process stores hosts and builds the ssh command, so the renderer can't choose the process. It can propose a host's ssh destination from Settings, which the main process checks (0007) before saving it.
  - The renderer can still call any plxd method through the bridge, including `agent/start`, whose agents run shell commands. A compromised renderer therefore has the user's full plxd access, which is 0007's trust boundary (the user).
  - The renderer shows untrusted agent output, such as markdown and diffs. These guards keep that output from taking the renderer over:
    - It loads only the app's bundled files, or the dev server in development.
    - A strict Content Security Policy applies: `default-src 'self'`, and no inline scripts or `eval`.
    - The main process blocks all navigation (`will-navigate`) and every `window.open` (`setWindowOpenHandler`). Links open in the system browser, and only for `https:` URLs.
- **Other OSes:** how plxd listens on Windows and Linux, and which `ssh` the app runs there, is PLX-7's decision. The rule that main spawns `plxd attach` doesn't change.

### Protocol types

- `parallax-protocol` stays the single source of truth (0007).
- An explicit generator command, not `#[ts(export)]`, runs ts-rs 12 with `Config::with_large_int("number")`. It writes `apps/desktop/src/protocol/generated/`, which is committed.
- A `cargo test` staleness test regenerates the types in memory and fails when they differ from the committed copy, so `check-rust` catches a forgotten regeneration. PLX-10 builds both, bringing back what 0020 removed in a new place.

### Layout

Following T3 Code's layout, built by PLX-13:

- A minimal left sidebar lists Projects, grouped by host, and their threads.
- The main pane is the chat, with a breadcrumb header and a centered composer.
- An optional right side panel holds diffs and review.
- Settings has General and Providers.
- A calm, high-contrast dark theme, and a light one.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| electron-vite, plus Biome and Vitest | Three tools where Vite+ is one, and a different toolchain from T3 Code's. Its one extra, the Electron dev loop, is a short script. |
| Electron Forge | It ties the build to packaging, which PLX-64 decides, and it isn't what T3 Code uses. |
| Separate `apps/web` for the renderer, as in T3 Code | T3 Code also serves its web app from a server. Parallax has no server, so a second package only adds wiring. |
| npm | Its hoisting hides undeclared dependencies, and it isn't what T3 Code uses. |
| A root pnpm workspace with a `packages/protocol` package | The app is the only consumer of the types, so a workspace and a second package are wiring with no user. Add them when a second package appears. |
| Bun | Electron's main process runs Node anyway, and Electron's native-module tooling expects Node. |
| Tauri | It drops T3 Code's stack, and each OS's webview renders differently. |
| An npm JSON-RPC library (`vscode-jsonrpc`, `json-rpc-2.0`) | The framing and the id matching are about a hundred lines. The rules that matter, like the frame cap, heartbeat, and resync, are Parallax's own either way. |

## Consequences

- **Supersedes** 0020's "no UI for now". The rest of 0020 stands.
- **Replaces two lines of 0007:** its TypeScript framing (Code - OSS's `JsonRpcProtocol`) and the generated types' location under `editor/`.
- **CI:** PLX-11 adds a job that runs `pnpm install --frozen-lockfile`, `vp check`, `vp test`, and the build in `apps/desktop/` on macOS, Windows, and Linux.
- **Two toolchains:** contributors need Node 24 and pnpm (corepack) as well as Rust. A change to `parallax-protocol` also means regenerating the types.
- **Vite+ is young.** If it stalls, its parts are replaced one for one.
- **Out of scope:** packaging, signing, and updates are PLX-64, PLX-66, and PLX-68.
