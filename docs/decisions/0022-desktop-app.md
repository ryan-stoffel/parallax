# 0022: The desktop app's stack and layout

- Status: accepted
- Date: 2026-09-27
- Issue: RYA-6

## Context

0020 dropped the editor fork and left wisp with no UI until a new frontend was decided. The new frontend is an Electron desktop app in this repo. Users open Projects, laid out like Cursor's, on this machine or on SSH hosts, and chat with their agents. It targets macOS, Windows, and Linux.

The app follows T3 Code (github.com/pingdotgg/t3code): its stack, its layout, and its calm look. We follow its structure and principles only. This repo is public, so no T3 Code assets, icons, or branding are ever committed.

RYA-9 scaffolds the app, RYA-10 generates the protocol types, RYA-12 and RYA-26 connect to wispd, and RYA-13 builds the layout. They all need the same answers first.

## Decision

### Stack

- **App:** Electron, React, and strict TypeScript, in `apps/desktop/`. Its source has three parts: `src/main/`, `src/preload/`, and `src/renderer/`. The renderer is part of the app, not a separate web app, because wisp has no web server to serve one.
- **Toolchain:** Vite+ (`vite-plus`, MIT), which T3 Code uses. One dev dependency and one `vp` CLI cover:
  - `vp dev` and `vp build`: Vite, for the renderer, with hot reload.
  - `vp pack`: tsdown, which bundles the main process and the preload. Every JS dependency is inlined, as in T3 Code, so packaging never depends on the `node_modules` layout.
  - `vp check`: Oxlint, Oxfmt, and the type-check, in one pass.
  - `vp test`: Vitest.
  - Vite+ is a 1.0 release candidate, so its version is pinned exactly. Each part is a standard tool with its own config block in `vite.config.ts`, so leaving Vite+ means installing those tools directly.
- **Dev loop:** `pnpm dev` runs `vp dev` and `vp pack --watch`, plus a short script that starts Electron on the dev server's URL and restarts it when the main bundle changes. That script is the one piece electron-vite would have given us.
- **Styling:** Tailwind CSS v4 through its Vite plugin, with the themes as CSS variables. RYA-13 adds UI libraries as screens need them, and prefers the ones T3 Code uses.

### Package manager and workspace

- **pnpm** workspace at the repo root, next to the Cargo workspace:

  ```
  package.json          private root; packageManager, scripts
  pnpm-workspace.yaml   apps/*, packages/*
  pnpm-lock.yaml
  .node-version         24
  apps/desktop/         @wisp/desktop
  packages/protocol/    @wisp/protocol, generated types
  ```

- pnpm is pinned exactly in the root `packageManager` field, which corepack reads (12.6.0 today). Node is pinned to 24, the active LTS, in `.node-version`, which CI's `setup-node` also reads. T3 Code also uses pnpm and Node 24.
- Why pnpm: it's what T3 Code uses, the `workspace:*` protocol links `@wisp/protocol` without publishing it, and its strict `node_modules` fails on a dependency that isn't declared. Only packages listed in `allowBuilds`, such as `electron`, may run install scripts.
- `packages/protocol` has no build step. It exports its `.ts` source, and Vite and tsdown compile it inside the app.

### Transport

0007's client rules now apply to the app. Where 0007 says "the editor", read "the app's main process".

- **Main owns every process.** The main process spawns the child and speaks JSON-RPC over its stdio:
  - Locally, the bundled `wispd attach`. In development, the path comes from `WISPD_PATH`, defaulting to the Cargo debug build.
  - For a host, `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ControlPath=none -- <destination> wispd attach`.
  - It keeps one child per host in use, and 0007's rules hold for each: destination checks, the `initialize` handshake, `host/health` every 30 s with a 10 s liveness window, reconnect with 1 s to 10 s backoff, resubscribing from the last `seq`, and caller-generated ids for creates and starts.
  - Exit status 4 means wispd can't be reached on that machine (0010), 127 means `wispd` isn't installed there, and 255 is an ssh error. The app shows the child's stderr in each case.
- **Client:** a small hand-written NDJSON JSON-RPC 2.0 client in `src/main/`, with no RPC dependency. It splits lines on `\n`, enforces `maxFrameBytes`, matches responses by id, sends `$/cancelRequest`, and routes `events/event` notifications. 0007's plan to reuse Code - OSS's `JsonRpcProtocol` went away with the fork.
- **Renderer:** it never spawns processes and never sees Node.
  - Every window has `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
  - The preload exposes one typed `window.wisp` bridge through `contextBridge`: calls to wispd's methods by host id, event subscriptions, and app actions. Its types come from `@wisp/protocol`.
  - The renderer names a host by its id. Only the main process stores hosts and builds the ssh command, so a renderer bug can't run a command of its choosing.
- **Other OSes:** how wispd listens on Windows and Linux, and which `ssh` the app runs there, is RYA-7's decision. The rule that main spawns `wispd attach` doesn't change.

### Protocol types

- `wisp-protocol` stays the single source of truth (0007).
- An explicit generator command, not `#[ts(export)]`, runs ts-rs 12 with `Config::with_large_int("number")`. It writes `packages/protocol/src/generated/`, which is committed.
- A `cargo test` staleness test regenerates the types in memory and fails when they differ from the committed copy, so `check-rust` catches a forgotten regeneration. RYA-10 builds both, bringing back what 0020 removed in a new place.

### Layout

Following T3 Code's layout, built by RYA-13:

- A minimal left sidebar lists Projects, grouped by host, and their threads.
- The main pane is the chat, with a breadcrumb header and a centered composer.
- An optional right side panel holds diffs and review.
- Settings has General and Providers.
- A calm, high-contrast dark theme, and a light one.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| electron-vite, plus Biome and Vitest | Three tools where Vite+ is one, and a different toolchain from T3 Code's. Its one extra, the Electron dev loop, is a short script. |
| Electron Forge | It ties the build to packaging, which RYA-64 decides, and it isn't what T3 Code uses. |
| Separate `apps/web` for the renderer, as in T3 Code | T3 Code also serves its web app from a server. wisp has no server, so a second package only adds wiring. |
| npm workspaces | No `workspace:` protocol, and hoisting hides undeclared dependencies. |
| Bun | Electron's main process runs Node anyway, and Electron's native-module tooling expects Node. |
| Tauri | It drops T3 Code's stack, and each OS's webview renders differently. |
| An npm JSON-RPC library (`vscode-jsonrpc`, `json-rpc-2.0`) | The framing and the id matching are about a hundred lines. The rules that matter, like the frame cap, heartbeat, and resync, are wisp's own either way. |

## Consequences

- **Supersedes** 0020's "no UI for now". The rest of 0020 stands.
- **Replaces two lines of 0007:** its TypeScript framing (Code - OSS's `JsonRpcProtocol`) and the generated types' location under `editor/`.
- **CI:** RYA-11 adds a job that runs `pnpm install --frozen-lockfile`, `vp check`, `vp test`, and the build on macOS, Windows, and Linux.
- **Two toolchains:** contributors need Node 24 and pnpm (corepack) as well as Rust. A change to `wisp-protocol` also means regenerating the types.
- **Vite+ is young.** If it stalls, its parts are replaced one for one.
- **Out of scope:** packaging, signing, and updates are RYA-64, RYA-66, and RYA-68.
