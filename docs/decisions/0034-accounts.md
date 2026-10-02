# 0034: Parallax accounts live in Supabase Auth

- Status: accepted
- Date: 2026-10-01
- Issue: RYA-273

## Context

Ryan wants a Parallax account, so the later mobile and web apps share one identity with the desktop app. An account is created with GitHub, Google, Apple, or an email and password. The plan listed a hosted cloud service as a non-goal, and an account that several devices share needs one.

The vendor sign-ins of 0004 are unrelated: plxd still never handles consumer credentials, and "accounts" in the protocol still means a host's CLI and API-key accounts (0012).

## Decision

- **Supabase Auth holds accounts.** It runs the four sign-in methods, email confirmation, and refresh tokens, and its SDK works the same later on mobile and web. Ryan chose it over our own server, which would mean writing and hosting OAuth, password hashing, and sessions. The hosted-service non-goal now excepts accounts.
- **No tables of our own.** `auth.users` is the account. The name and picture live in its user metadata: `first_name` and `last_name` from email sign-up, `full_name` and `avatar_url` or `picture` from a provider. A `profiles` table waits until one user needs to read another's profile.
- **The main process owns the session.** `@supabase/auth-js` runs in Electron's main process. Its storage is one file in userData, encrypted with `safeStorage`; without an OS keychain the session lives in memory only. The renderer sees a `Profile` (name, email, picture as a data: URL), never a token. The CSP stays as it is.
- **PKCE with a loopback redirect.** OAuth opens the provider in the system browser and redirects to `http://127.0.0.1:<port>/callback`, on a port the OS picks, per RFC 8252. The app trades the `code` for a session. A custom URL scheme would need per-OS registration and doesn't reach a `pnpm dev` app on macOS. The email confirmation link comes back the same way, so clicking it signs the app in.
- **Config.** The project URL and publishable key are public and live in `apps/desktop/src/main/account.ts`. `PLX_SUPABASE_URL` and `PLX_SUPABASE_KEY` override them for development. Unset, sign-in answers that accounts aren't set up.
- **UI.** The sidebar footer is Profile, Settings, Usage, then Update on the right. Profile shows the picture, or first and last initials, and opens Settings > Account.

## Consequences

- The Supabase project needs `http://127.0.0.1:*/**` in its redirect URLs, and each provider's OAuth app needs Supabase's callback URL. Apple needs a paid developer account.
- Signing out is local: other devices stay signed in.
- Password reset, account deletion, and choosing a picture aren't built yet.
- The app works signed out. Nothing else depends on an account yet.
