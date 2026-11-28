# parallax.codes

The public pages both app stores ask for (PLX-1648): the privacy policy, support, and how to delete an account. A Cloudflare Worker with static assets and no script, apart from the relay's Worker (`relay/`) and the hosted client's (`app.parallax.codes`, [0108](../docs/decisions/0108-hosted-browser-client-guest-links.md)).

| Path | File | Used by |
| --- | --- | --- |
| `/privacy` | `public/privacy.html` | App Store Connect and Play Console's privacy policy URL, the phone app's About page, Clerk's sign-up page |
| `/support` | `public/support.html` | App Store Connect's support URL, the phone app's About page |
| `/delete-account` | `public/delete-account.html` | Play Console's account deletion URL |

- `public/` is everything the site serves. The pages are plain HTML with one stylesheet, `site.css`, in the app's colors (`apps/mobile/src/theme.ts`). They run no script, set no cookie, and load nothing from another origin.
- `public/_headers` sets every response's headers: a CSP of `default-src 'none'` that allows only the site's own stylesheet, images, and font, plus HSTS and the rest.
- `wrangler.toml` is the deploy config: production at the top level and `[env.staging]`.
- `test/pages.test.mjs` checks that no page has script or inline style, that pages load only their own files, and that every local link resolves.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm dev       # http://localhost:8787
```

## The privacy policy is a description of the code

`privacy.html` says what the relay stores, what the phone keeps, and what the desktop app sends. A change to any of those changes the page in the same pull request: `relay/src/user.ts` and `relay/src/host.ts` (what the relay stores), `relay/src/log.ts` (what a log line holds), `relay/src/push.ts` (what a push carries), `apps/desktop/src/main/telemetry.ts` (usage events), and the phone app's permissions in `apps/mobile/app.json`.

Two paragraphs, in `privacy.html` and `delete-account.html`, say the relay keeps a deleted account's computers and push tokens. Each has a comment naming PLX-1612. Rewrite them when that ships.

## TODOs before production

A fact only Ryan can give shows on the page as an orange `TODO (Ryan)` mark, so none goes live unnoticed. List them:

```sh
grep -n 'class="todo"' public/*.html
```

Production isn't ready until that prints nothing.

## Staging

`parallax-site-staging` is a second Worker on its `workers.dev` URL, with no route on `parallax.codes`. Agents may deploy to it. Deploy with this one command, from `site/`, on a computer where `wrangler` is logged in to the account:

```sh
corepack pnpm deploy:staging
```

`scripts/deploy-staging.mjs` takes no arguments and passes none to wrangler. It gives wrangler only a short list of your shell's variables and no `.env` file, and it deploys only when wrangler's own dry run names the staging Worker. Its guards are the relay's (`relay/scripts/staging-target.mjs`).

## Deploy

Production is Ryan's to deploy, by hand. No workflow deploys it, and agents don't.

1. `parallax.codes` is already a zone on the Cloudflare account. `wrangler.toml` routes the apex to the Worker as a custom domain, and the deploy creates its DNS record and certificate. The apex has no DNS record today, so nothing is replaced.
2. Clear the TODOs above.
3. Deploy and check, with the API token `relay/README.md`'s Deploy describes, whose four permissions cover this Worker too:

```sh
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm exec wrangler deploy --env=""
curl -s -o /dev/null -w '%{http_code}\n' https://parallax.codes/privacy
curl -sI https://parallax.codes/privacy | grep -i content-security-policy
```

The first `curl` should print `200`, and the second the CSP from `public/_headers`.

After the first deploy, set Clerk's production instance's privacy policy URL to `https://parallax.codes/privacy`, so the sign-up page shows it, and give the three URLs above to App Store Connect and Play Console.
