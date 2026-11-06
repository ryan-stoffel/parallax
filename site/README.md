# parallax.codes

The home page and privacy policy at `https://parallax.codes`, which Google needs to publish the sign-in app and the App Store needs to list the iPhone app (PLX-1454). It's a Cloudflare Worker with static assets only: no script, framework, or build step.

- `public/index.html` is `/`, and `public/privacy.html` is `/privacy`.
- `public/_headers` sets a content security policy that allows no scripts and no requests to other servers, and sends no referrer.
- `wrangler.toml` routes `parallax.codes` to the Worker as a custom domain, with no `workers.dev` URL.

The privacy policy's contact email is a placeholder for Ryan to fill in. Once it's in, turn off Email Address Obfuscation on the `parallax.codes` zone: it hides each address behind a script it injects, which the content security policy blocks, so the page would show no address.

The privacy policy states what the code does. Update it in the same PR as a change to what the apps, `plxd`, or the relay keep or send.

## Local

```sh
npx wrangler@4 dev
```

It serves the pages at http://localhost:8787.

## Deploy

No workflow deploys it. From `site/`, with the API token from [`relay/README.md`](../relay/README.md#deploy), which already has Workers Scripts, Workers Routes, and DNS on `parallax.codes`:

```sh
export CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id>
npx wrangler@4 deploy
curl -s -o /dev/null -w '%{http_code}\n' https://parallax.codes/privacy
```

The last line should print `200`. The deploy creates the Worker `parallax-site`, and for its custom domain, the apex DNS record and certificate on the `parallax.codes` zone. It doesn't touch `relay.parallax.codes` or Clerk's records.

`www.parallax.codes` isn't routed. Sending it to the apex needs a Redirect Rule on the zone or a script in the Worker.
