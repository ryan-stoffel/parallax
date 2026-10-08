# 0053: Cursor runs through the official SDK

- Status: accepted; supersedes the Cursor parts of [0036](0036-cursor-threads.md) and [0040](0040-provider-instances.md)
- Date: 2026-10-04

## Context

0036 ran Cursor threads through `agent acp`, the Cursor CLI's Agent Client Protocol. That CLI is the old integration. Cursor's current one is `@cursor/sdk`: a Node library, local agents, and a browser login that mints a user API key. 0040 left the CLI in place because the SDK needed a sidecar, had no approval callback, and had no Windows arm64 build. Ryan asked to switch to the SDK and to sign in with a Cursor account, the way T3 Code does.

## Decision

- **Backend `cursor`** runs `@cursor/sdk` local agents in a Node sidecar, `sidecar/cursor`, which plxd starts. The sidecar is what a remote `plxd attach` host runs, so the Electron app is not the runtime. It needs Node.js 22.13 or newer. Only the sidecar's own files ship beside `plxd`, in `cursor-sdk/`: `package.json`, `package-lock.json`, and `src/`.
- **The SDK installs on first use** (PLX-626), so users who never pick Cursor don't download its 44 MB. Until it's installed, `providers/list` reports Cursor not installed, and detection never runs npm. Settings > Providers offers Install, which calls `cursor/install`: plxd runs `npm ci --omit=dev` on the sidecar's lockfile in a temp folder under `<data>/tools/cursor-sdk/`, renames it to the pinned version, and deletes every other version. The sidecar runs from there, because the SDK loads its chunks and finds its native tools by walking up from `main.mjs`; plxd copies the shipped `src/` files in before each start when they differ. An update that changes the pin installs the new version on the next probe, since an older version means the user chose Cursor. `PLXD_CURSOR_SDK` overrides the program in tests.
- **Sign-in** follows T3 Code's `CursorAuth`. `Cursor.auth.login()` runs with the browser left to the app (`cursor/signIn` returns the URL; `cursor/signInCancel` and `cursor/signOut` stop or forget it), names the key `Parallax - <instance>`, and writes into an in-memory store. The key is then saved to plxd's data folder, `cursor-sdk/<instance>/auth.json`, checked with `Cursor.me`, and cleared if Cursor rejects it. A stored key past its expiry counts as signed out. Status is `Cursor.me` too.
- **API key.** A `CURSOR_API_KEY` set on the provider instance wins over the browser login, and plxd refuses sign-in and sign-out for that instance, as T3 does. An ambient `CURSOR_API_KEY` is still not a fallback (0004): inherited `CURSOR_*` variables are dropped, and the sidecar deletes every `CURSOR_*` after reading the instance's key. A key kept as a secret is not read by `providers/list`, which reports the instance signed in without models rather than wait on the keychain.
- **Agent options** are T3's `makeCursorAgentOptions`: setting sources `project`, `user`, `team`, `mdm`, and `plugins`; `enableAgentRetries`; `autoReview` on while the mode still asks, which is Plan and Auto; the sandbox off only for Bypass. T3 also warms a sandboxed workspace before an unsandboxed run, because the SDK caches "sandbox unsupported" per process. Each Parallax run is its own sidecar process, so that cache never reaches a later run and the warm-up is left out. Mode, model, and MCP servers go on every send.
- **Permissions.** Edit, Plan, and Auto run sandboxed, Plan in plan mode. Auto's classifier denies instead of asking, so an Auto Project can use Cursor. There is no Manual, and there is no interactive approval for shell or file tools.
- **Plans.** A plan arrives as the SDK's `createPlan`, which the app shows as a proposed plan, and the turn ends there, as in T3. Building it is the next message, after the user switches the thread out of Plan.
- **Sessions.** The sidecar keeps a JSONL agent store next to the auth file. A follow-up waits for the running turn. A steer (0048) cancels it and starts the next turn, as T3's interrupt does, and steers that arrive together run in order. Fork stays unsupported, and there is no worker sandbox.
- **Sign-in and sign-out leave running threads alone.** T3 stops sessions that hold the old key. A Parallax run keeps the key it started with until it ends. A login that fails in the browser is reported in `providers/list` as `signInError`, which Settings shows, as T3's "failed" phase.
- **Models** come from `Cursor.models.list` when the account is signed in. Omitting a model uses `auto`.
- **Usage** in Settings still reads Cursor's desktop database. This record does not change that.

## Consequences

- A host without Node.js 22.13 or newer can list Cursor and is told what it needs; it cannot install the SDK, sign in, or run a thread until Node is there. Installing needs npm and the network; a failure is shown on Install.
- A new SDK pin means one npm install after the update, which `providers/list` waits for.
- Windows arm64 may still lack the SDK's native package. The sidecar reports that as a failed start rather than pretending the CLI is there.
- ACP stays the driver for OpenCode, Pi, Hermes, Grok Build, Antigravity, and other ACP agents. Only Cursor leaves it.
