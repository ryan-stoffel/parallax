# Parallax Relay

A Cloudflare Worker with Durable Objects that lets a user's devices reach their plxd from anywhere, gives plxd's webhooks a public URL, and carries push notifications ([0068](../docs/decisions/0068-relay.md)). It passes plxd's own TLS between client and host, so it never reads a thread.

- `src/index.ts` routes requests and checks Clerk tokens (`src/clerk.ts`, on `packages/clerk-verify`).
- `src/host.ts` is one host: its registration, plxd's connection, client streams, and held webhooks.
- `src/user.ts` is one user: their hosts, the hosts that left their account, push devices, and request budget. `src/push.ts` sends pushes through APNs.
- `src/log.ts` writes the log lines that say why a connection closed, and how to read them.
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

1. **The domain.** `parallax.codes` is registered through Cloudflare Registrar, so it is already a zone on the account. `wrangler.toml` routes `relay.parallax.codes` to the Worker as a custom domain, and the deploy creates its DNS record and certificate.
2. **A Cloudflare API token**: My Profile > API Tokens > Create Token > Create Custom Token, not the "Edit Cloudflare Workers" template, which adds KV, R2, Pages, and Tail. Give it exactly these four permissions: Account > Workers Scripts > Edit, Account > Account Settings > Read, Zone > Workers Routes > Edit, and Zone > DNS > Edit. Under Account Resources include only Ryan's account, under Zone Resources only `parallax.codes`, and set an expiry. Durable Objects need the Workers Paid plan.
3. **The account id**, from the Cloudflare dashboard's Workers & Pages overview.
4. **Clerk's production instance** (0067). The top level of `wrangler.toml` sets no Clerk instance, and the development instance is only in `[env.dev]`, so a deploy must pass these with `--var`, or it refuses every token:
   - `CLERK_ISSUER`: the instance's Frontend API URL, such as `https://clerk.parallax.codes`.
   - `CLERK_JWKS_URL`: `<CLERK_ISSUER>/.well-known/jwks.json`.
   - `CLERK_CLIENT_IDS`: the production desktop OAuth application's client id.
   - `CLERK_AUTHORIZED_PARTIES`: the web client's origins, comma-separated, once there is one. Unset, browsers' session tokens are refused. The mobile app's carry no origin and pass.

### When to deploy

Deploy less often, and at a quiet time. A deploy drops every connection: each client stream ends, and so does each plxd's connection to the relay. Under `wrangler dev`, a client was back 1 to 3 s after a code reload, and reloads less than a minute apart took longer as plxd's backoff grew (0091). So batch relay changes into one deploy rather than shipping each as it merges. A relay change the apps depend on still goes out before the app that needs it.

### Commands

From `relay/`, with the values filled in. These have no `#` comments, because zsh doesn't treat a pasted `#` as a comment, and `curl` would take the words after it as more URLs.

```sh
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm exec wrangler deploy --env="" --var CLERK_ISSUER:<issuer> --var CLERK_JWKS_URL:<issuer>/.well-known/jwks.json --var CLERK_CLIENT_IDS:<client id>
curl -s -o /dev/null -w '%{http_code}\n' https://relay.parallax.codes/v1/hosts
```

The last line should print `401`. Add `--var CLERK_AUTHORIZED_PARTIES:<origins>` to the deploy once a web client exists.

A deploy applies any new migration in `wrangler.toml`. A later change to a class's storage adds a migration rather than editing an old one.

Push needs the APNs auth key (`.p8`, Sandbox & Production), its key id, and the team id, as Worker secrets. Without them pushes only log. After the first deploy:

```sh
corepack pnpm exec wrangler secret put APNS_KEY --env="" < AuthKey_<key id>.p8
corepack pnpm exec wrangler secret put APNS_KEY_ID --env=""
corepack pnpm exec wrangler secret put APNS_TEAM_ID --env=""
```

Workers reach APNs over HTTP/2 in production, but not under `wrangler dev` on macOS (cloudflare/workerd#4841), so test a real push against the deployed relay.
