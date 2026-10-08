# 0037: Parallax accounts live in Supabase Auth

- Status: accepted
- Date: 2026-10-01
- Issue: PLX-273

## Context

Ryan wants a Parallax account, so the later mobile and web apps share one identity with the desktop app. An account is created with GitHub, Google, Apple, or an email and password. The plan listed a hosted cloud service as a non-goal, and an account that several devices share needs one.

The vendor sign-ins of 0004 are unrelated: plxd still never handles consumer credentials, and "accounts" in the protocol still means a host's CLI and API-key accounts (0012).

## Decision

- **Supabase Auth holds accounts.** It runs the four sign-in methods, email confirmation, and refresh tokens, and its SDK works the same later on mobile and web. Ryan chose it over our own server, which would mean writing and hosting OAuth, password hashing, and sessions. The hosted-service non-goal now excepts accounts.
- **No tables of our own.** `auth.users` is the account. The name and picture live in its user metadata: `first_name` and `last_name` from email sign-up, `full_name` and `avatar_url` or `picture` from a provider. A `profiles` table waits until one user needs to read another's profile.
- **The main process owns the session.** `@supabase/auth-js` runs in Electron's main process. Its storage is one file in userData, encrypted with `safeStorage`; without an OS keychain the session lives in memory only. The renderer sees a `Profile` (name, first and last name, email, picture as a data: URL), never a token. The CSP stays as it is.
- **Sign-in happens in the browser, on a page the app serves.** Sign in and Create an account open `http://127.0.0.1:<port>/` in the system browser, on a port the OS picks, where the user picks GitHub, Google, Apple, or email (PLX-315). The page is plain HTML from the main process, not a hosted site: there is nothing to deploy, it works under `pnpm dev`, and every step runs in main, so the browser never holds a token. A provider button goes through main, which starts the OAuth sign-in with PKCE and redirects to the provider. Providers and the email confirmation link redirect back to the page's `/callback` (RFC 8252), where main trades the `code` for a session. A custom URL scheme would need per-OS registration and doesn't reach a `pnpm dev` app on macOS. Once signed in, the app's window comes forward and the page says so. The page waits an hour, as long as Supabase's email links last by default; a later click still confirms the account, and the user then signs in with the password. It answers only requests to its own address. The URL the app opens carries a one-time secret, which the first visit trades for an `HttpOnly`, `SameSite=Strict` cookie that starting a sign-in requires, so no other browser or local program can sign the app into another account; `/callback` needs none, since PKCE ties its code to the app. Every redirect carries its PKCE flow id (auth-js's experimental `appendPkceFlowIdToRedirects`, the only way to name a sign-up's flow), so a sign-up and an OAuth sign-in on one page each use their own verifier. The redirect allow list's `**` accepts that query string.
- **Config.** The project URL and publishable key are public and live in `apps/desktop/src/main/account.ts`. `PLX_SUPABASE_URL` and `PLX_SUPABASE_KEY` override them for development. Unset, the app uses that built-in project.
- **UI.** Settings > Account, signed out, has Sign in and Create an account. The sidebar footer is Profile, Settings, Usage, then Update on the right. Profile shows the picture, or first and last initials, and opens Settings > Account (PLX-421): the account, Share, what every host's agents add up to, and the account's settings. The first and last name save to `first_name` and `last_name`, which a provider's sign-in leaves alone.

## Consequences

- The Supabase project needs `http://127.0.0.1:*/**` in its redirect URLs, and each provider's OAuth app needs Supabase's callback URL. Apple needs a paid developer account.
- Signing out is local: other devices stay signed in.
- Password reset, account deletion, changing the email, and choosing a picture aren't built yet.
- The app works signed out. Nothing else depends on an account yet.
