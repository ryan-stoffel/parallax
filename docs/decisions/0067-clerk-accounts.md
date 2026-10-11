# 0067: Parallax accounts live in Clerk, and the desktop app signs in with OAuth and PKCE

- Status: accepted; supersedes [0037](0037-accounts.md), and replaces Supabase in [0065](0065-remote-reach.md)'s relay and mobile app
- Date: 2026-10-11
- Issue: PLX-702, for PLX-652 and PLX-653

## Context

0037 put accounts in Supabase Auth, and nothing but the desktop app's profile uses them yet. On 2026-10-11 Ryan chose Clerk for every Parallax surface: the desktop app, the web client plxd serves, Parallax Relay (PLX-652), and the mobile app (PLX-653). T3 Code signs in with Clerk too. 0037 keeps no tables, so nothing migrates: Supabase users sign in again.

0037's rules still hold. Main owns the session. The renderer never sees a token. Sign-in happens in the system browser and comes back to a loopback address. The session is stored encrypted with `safeStorage`.

Clerk offers three ways in for a desktop app:

- **`@clerk/electron`** (beta, 0.1.0; T3 Code uses it). ClerkJS runs in the renderer, which holds the client token and sends it with every request, and the app needs a custom URL scheme. That breaks the renderer rule, and 0037 already rejected a scheme, which needs per-OS registration and doesn't reach a `pnpm dev` app on macOS.
- **ClerkJS on our loopback page, handing off a sign-in token.** Minting a sign-in token needs the instance's secret key, so it needs a server.
- **Clerk as the OAuth provider.** Clerk documents this flow for CLIs and desktop apps: an OAuth application that is a public client, authorization code with PKCE (S256), and a loopback redirect on any port (RFC 8252). Its access tokens are JWTs signed with the instance's key.

## Decision

- **Clerk holds accounts**, with no tables of our own. GitHub, Google, Apple, and email with a password are enabled. A sign-up asks for first and last name, and the email is confirmed with a code. A Clerk user is the account. The relay and the mobile app use the same instance.
- **The desktop app is an OAuth client of Clerk.** Its OAuth application is public, requires PKCE, has the scopes `profile email offline_access`, and allows the redirect `http://127.0.0.1/callback`. Clerk accepts any port on it at run time. All of the following runs in main (`apps/desktop/src/main/account.ts`), with plain `fetch` and no SDK:
  1. Sign in opens Clerk's `/oauth/authorize` in the system browser, with a new verifier and `state`. The loopback server waits on a port the OS picks (`loopback.ts`).
  2. Clerk's hosted page does the rest: providers, email codes, sign-up, bot checks, and the consent screen.
  3. Only a `/callback` that carries the sign-in's `state` counts. Main trades the code at `/oauth/token` with the verifier and reads `/oauth/userinfo`.
  4. Create an account opens the Account Portal's `/sign-up` with the same authorize URL as its `redirect_url`, the way Clerk's own authorize sends a signed-out browser to `/sign-in`.
  5. The browser never holds a token. The page it ends on runs no script.
- **The session**: the refresh token, which never expires and which Clerk rotates on use, and the last userinfo, in one file in userData encrypted with `safeStorage`. Where the OS has no keychain, the session lives in memory only. On Linux that includes `safeStorage`'s `basic_text` fallback, which encrypts with a hardcoded password. The access token, a JWT that lasts a day, stays in memory and is refreshed a minute before it expires. A refresh token Clerk refuses signs the app out. Sign out revokes this computer's refresh token at `/oauth/token/revoke`, so other devices stay signed in.
- **The profile.** The renderer gets `Profile`: first and last name from `given_name` and `family_name`, email, and the picture as a data: URL. It shows from the saved userinfo at launch, then refreshes from Clerk, and again when a window is focused, at most once a minute. An OAuth token can't change the user, so Settings > Account's name row opens the Account Portal's `/user` page, where the name, picture, email, and password change. This replaces 0037's name fields.
- **Config.** The publishable key, which names the instance's Frontend API, and the OAuth application's client id are public and live in `account.ts`. `PLX_CLERK_PUBLISHABLE_KEY` and `PLX_CLERK_CLIENT_ID` override them for development.
- **Verifying tokens.** `packages/clerk-verify` (`verifyClerkToken`) checks a Clerk JWT against the instance's JWKS with WebCrypto only, so it runs in Workers, Node, and browsers.
  - It accepts a session token from Clerk's web or Expo SDK (`sid`) and an OAuth access token (`client_id`), and returns the user id.
  - The caller must pass both allow lists: `authorizedParties` for a browser session token's `azp`, and `clientIds` for OAuth applications. A session token without `azp`, as native SDKs send, passes.
  - It checks `alg` (RS256 only), the signature, `iss`, `exp`, and `nbf`. It refuses any token with `aud`, which Clerk's session and OAuth tokens don't carry, since one that has it was meant for another service.
  - Keys are cached for the response's `max-age`, or an hour. A token naming an unknown `kid` refetches them at most once a minute, and checks that run at the same time share one fetch. While the JWKS is down, the keys already fetched keep working. The relay imports it, and shared TypeScript for other surfaces goes in `packages/` too.

## Consequences

- Each instance needs the OAuth application above, with JWT access tokens (Clerk's default; opaque ones can't be checked against the JWKS) and the Parallax logo, which its consent screen shows. Production needs its own instance with the same settings, its own provider OAuth apps (Clerk's shared ones are development-only), and Apple's paid developer account. Then the two constants change.
- Clerk shows a consent screen ("Parallax desktop wants access") on every sign-in, even one already granted. It is Clerk's recommended default, and it stays on.
- Clerk's browser session outlives the app's sign-out, and Clerk has neither `prompt=login` nor an end-session endpoint. So signing in as someone else means signing out on Clerk's page first; the next sign-in otherwise goes straight to consent for the same user.
- An access token can't be revoked before it expires (a day). The relay, which must cut off a user sooner, can verify with Clerk's API instead.
- Signing out is local, as in 0037. Password reset, email changes, and pictures now come with Clerk's pages. Account deletion isn't built.
- `@supabase/auth-js` and the app's own sign-in page are gone.
