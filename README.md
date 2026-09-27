# wisp

An open-source host daemon that reproduces the Cursor Projects workflow on machines you own. One coordinator chat plans the work and spawns subagents that share project context. Model calls go through your own AI subscriptions, with raw API keys as a fallback.

wisp is currently `wispd` only, a Rust daemon that runs the coordinator, agents, and project state on the host. It has no UI; the earlier VS Code fork was dropped ([0020](docs/decisions/0020-drop-the-editor-fork.md)). [daemon/README.md](daemon/README.md) covers its commands and how to set up a Mac as a host over SSH.

Status: early development. See [docs/PLAN.md](docs/PLAN.md) for the plan.

## Build

```sh
cargo build --release -p wispd
```

`scripts/ci/check-rust` runs the same lint, build, and tests as CI.

## Desktop app

The Electron app lives in [apps/desktop](apps/desktop) ([0022](docs/decisions/0022-desktop-app.md)). It needs Node 24 and pnpm through corepack (`corepack enable`). Run pnpm inside `apps/desktop`, where corepack finds the pinned version.

```sh
cd apps/desktop
pnpm install
pnpm dev       # window with hot reload
```

`pnpm check` (format, lint, type-check), `pnpm fmt`, `pnpm test`, and `pnpm build` run the rest.

## License

[Apache-2.0](LICENSE)
