# Parallax Relay

A Cloudflare Worker with Durable Objects that lets a user's devices reach their plxd from anywhere, gives plxd's webhooks a public URL, and carries push notifications ([0068](../docs/decisions/0068-relay.md)). It passes plxd's own TLS between client and host, so it never reads a thread.

- `src/index.ts` routes requests and checks Clerk tokens (`src/clerk.ts`, on `packages/clerk-verify`).
- `src/host.ts` is one host: its registration, plxd's connection, client streams, and held webhooks.
- `src/user.ts` is one user: their hosts, push devices, and request budget. `src/push.ts` is the APNs stub.
- `wrangler.toml` is the deploy config.

## Local

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check        # type-check
corepack pnpm test         # the Worker's tests, in Miniflare, with a local JWKS
corepack pnpm dev          # wrangler dev --env dev on :8787, against Clerk's development instance
node scripts/e2e.mjs       # plxd's relay test (daemon/tests/server/relay.rs) against wrangler dev
```

Point a plxd at a local relay with `PLXD_RELAY_URL=http://127.0.0.1:8787`. Plain HTTP works only to loopback.

## Deploy

No workflow deploys the relay. Ryan deploys it by hand once these exist:

1. **The domain.** Register `parallx.dev` and add it to the Cloudflare account as a zone (Cloudflare's nameservers at the registrar). `wrangler.toml` routes `relay.parallx.dev` to the Worker as a custom domain, and the deploy creates its DNS record and certificate.
2. **A Cloudflare API token**: My Profile > API Tokens > Create Token > Create Custom Token, not the "Edit Cloudflare Workers" template, which adds KV, R2, Pages, and Tail. Give it exactly these four permissions: Account > Workers Scripts > Edit, Account > Account Settings > Read, Zone > Workers Routes > Edit, and Zone > DNS > Edit. Under Account Resources include only Ryan's account, under Zone Resources only `parallx.dev`, and set an expiry. Durable Objects need the Workers Paid plan.
3. **The account id**, from the Cloudflare dashboard's Workers & Pages overview.
4. **Clerk's production instance** (0067). The top level of `wrangler.toml` sets no Clerk instance, so a deploy without it refuses every token; the development instance is only in `[env.dev]`. Add a `[vars]` table at the top level with:
   - `CLERK_ISSUER`: the instance's Frontend API URL, such as `https://clerk.parallx.dev`.
   - `CLERK_JWKS_URL`: `<CLERK_ISSUER>/.well-known/jwks.json`.
   - `CLERK_CLIENT_IDS`: the production desktop OAuth application's client id.
   - `CLERK_AUTHORIZED_PARTIES`: the web client's origins, comma-separated, once there is one. Unset, browsers' session tokens are refused. The mobile app's carry no origin and pass.

Then, from `relay/`:

```sh
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm exec wrangler deploy --env=""
curl -s -o /dev/null -w '%{http_code}\n' https://relay.parallx.dev/v1/hosts   # 401
```

The first deploy creates both Durable Object classes from the `v1` migration. A later change to a class's storage adds a migration rather than editing `v1`.

Push needs an APNs key (`.p8`), its key id, and the team id (PLX-653). They will be Worker secrets (`wrangler secret put`), and `src/push.ts`'s stub gets replaced with a real send.
