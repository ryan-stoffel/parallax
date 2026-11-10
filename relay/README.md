# Parallax Relay

A Cloudflare Worker with Durable Objects that lets a user's devices reach their plxd from anywhere, gives plxd's webhooks a public URL, and carries push notifications ([0068](../docs/decisions/0068-relay.md)). It passes plxd's own TLS between client and host, so it never reads a thread.

- `src/index.ts` routes requests and checks Clerk tokens (`src/clerk.ts`, on `packages/clerk-verify`).
- `src/host.ts` is one host: its registration, plxd's connection, client streams, and held webhooks.
- `src/user.ts` is one user: their hosts, the hosts that left their account, push devices, and request budget. `src/push.ts` sends pushes through APNs.
- `src/log.ts` writes the log lines that say why a connection closed, and how to read them.
- `wrangler.toml` is the deploy config: production at the top level, `[env.dev]` for `pnpm dev`, and `[env.staging]` ([Staging](#staging)).

## Local

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check        # type-check
corepack pnpm test         # the Worker's tests, in Miniflare, with a local JWKS
corepack pnpm dev          # wrangler dev --env dev on :8787, against Clerk's production and development instances
node scripts/e2e.mjs       # plxd's relay test (daemon/tests/server/relay.rs) against wrangler dev
```

Point a plxd at a local relay with `PLXD_RELAY_URL=http://127.0.0.1:8787`. Plain HTTP works only to loopback.

## Staging

`https://parallax-relay-staging.stoffel-thomas-ryan.workers.dev` is a second Worker, `parallax-relay-staging`, on the same Cloudflare account (PLX-1495). It is for what only shows on real Cloudflare, such as where objects run and how long one holds messages behind a storage write. It has its own Durable Objects and rate-limit namespace, so it shares no storage with production, and no route on `parallax.codes`.

Agents may deploy to it and measure it without asking. It serves one account: its `ALLOWED_USERS` secret holds the relay probe's test account's Clerk user id, and every other account, Ryan's included, gets `403 user_not_allowed`. `REQUIRE_ALLOWED_USERS` in `[env.staging.vars]` is what makes the relay read that secret. With it, a missing or empty secret refuses everyone, so deleting the secret can't open staging. Without it, as on production, the relay ignores `ALLOWED_USERS`, so the secret landing on production by mistake locks nobody out.

Deploy with this one command, from `relay/`, on a computer where `wrangler` is logged in to the account:

```sh
corepack pnpm deploy:staging
```

Then check it answers, which should print `401`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://parallax-relay-staging.stoffel-thomas-ryan.workers.dev/v1/hosts
```

`scripts/deploy-staging.mjs` takes no arguments and passes none to wrangler. It gives wrangler only a short list of your shell's variables and no `.env` file, since wrangler reads some variables as where to deploy. It stops unless `[env.staging]` is still that Worker with no route and with `REQUIRE_ALLOWED_USERS`, wrangler's own dry run says the deploy goes to `parallax-relay-staging`, `ALLOWED_USERS` is set, and the type-check and tests pass. Then it prints the URL and the version id. Agents deploy with nothing else: never `wrangler deploy` on its own, and never `--env=""`, which are production. A staging deploy drops only staging's connections, so it needs no quiet time.

Measure it with the relay probe, dispatched on your branch with `relay=staging` and a nightly's tag. Check first that no Relay probe run is in progress or waiting: they run one at a time because they share the test account's refresh token, and GitHub keeps only one waiting run, so a new one replaces it.

```sh
gh workflow run relay-probe.yml --ref <branch> -f relay=staging -f tag=<nightly tag>
gh run watch <run id> --interval 300
gh run download <run id> --name relay-probe --dir relay-probe
```

The job summary and `relay-probe.md` have the checks and the medians. A manual run also passes `--timings`, so `relay-probe.json` has `metrics.stages`: one list per timed connect, each entry a stage's `kind`, name, and `ms`. A `connect-timing` stage is plxd's, and its `ms` is the time since the dial started when plxd reached it, so a step's cost is the difference from the stage before. A `connect-server-timing` stage is the relay's own time in one step of the connect request, such as `auth`, `host_open`, and `stream_join`, except `spare`, which is 1 when the connect took a waiting spare stream. The middle value of each stage across the connects:

```sh
jq -r '[.metrics.stages[][]] | group_by(.kind + " " + .stage)[] | "\(.[0].kind) \(.[0].stage) \(map(.ms) | sort | .[length / 2 | floor]) ms"' relay-probe/relay-probe.json
```

Dispatch the same command with `relay=production` for production's stages to compare. The schedule and each nightly's run can't pick a relay, so they test production and keep no stages.

Set once, before the first deploy, and again only if the test account changes. The id goes from the repo variable to the secret without being printed or written anywhere:

```sh
gh variable get PROBE_CLERK_USER_ID --repo ryan-stoffel/parallax | corepack pnpm exec wrangler secret put ALLOWED_USERS --env staging
```

## Deploy

Production is Ryan's to deploy, by hand. No workflow deploys it, and agents don't. He deploys it once these exist:

1. **The domain.** `parallax.codes` is registered through Cloudflare Registrar, so it is already a zone on the account. `wrangler.toml` routes `relay.parallax.codes` to the Worker as a custom domain, and the deploy creates its DNS record and certificate.
2. **A Cloudflare API token**: My Profile > API Tokens > Create Token > Create Custom Token, not the "Edit Cloudflare Workers" template, which adds KV, R2, Pages, and Tail. Give it exactly these four permissions: Account > Workers Scripts > Edit, Account > Account Settings > Read, Zone > Workers Routes > Edit, and Zone > DNS > Edit. Under Account Resources include only Ryan's account, under Zone Resources only `parallax.codes`, and set an expiry. Durable Objects need the Workers Paid plan.
3. **The account id**, from the Cloudflare dashboard's Workers & Pages overview.
4. **Clerk's instances** (0067). The top level of `wrangler.toml` sets both, production first:
   - `CLERK_ISSUER`: `https://clerk.parallax.codes,https://adjusted-mastodon-8705.clerk.accounts.dev`.
   - `CLERK_JWKS_URL`: each issuer's `/.well-known/jwks.json`, in the same order.
   - `CLERK_CLIENT_IDS`: the desktop OAuth application's client id on each, in the same order: `mp9Q72aAbB0LC83O,SXDueyOLOJ2v4Vmq`.
   - `CLERK_AUTHORIZED_PARTIES` isn't set: the web client's origins, comma-separated, once there is one. Unset, browsers' session tokens are refused. The mobile app's carry no origin and pass.

   A token is checked against the instance its `iss` names and only that instance's client ids. Several client ids for one instance are separated by spaces. The apps sign in to the development instance until the account move ships (PLX-1465). Remove it from `wrangler.toml` only once the move has shipped, the probe's account is on production (PLX-1457), and a stable release carries both.

### When to deploy

Deploy less often, and at a quiet time. A deploy drops every connection: each client stream ends, and so does each plxd's connection to the relay. Under `wrangler dev`, a client was back 1 to 3 s after a code reload, and reloads less than a minute apart took longer as plxd's backoff grew (0091). So batch relay changes into one deploy rather than shipping each as it merges. A relay change the apps depend on still goes out before the app that needs it.

### Commands

From `relay/`, with the values filled in. These have no `#` comments, because zsh doesn't treat a pasted `#` as a comment, and `curl` would take the words after it as more URLs.

```sh
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm exec wrangler deploy --env=""
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
