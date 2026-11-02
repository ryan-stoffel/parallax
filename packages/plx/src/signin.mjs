// @ts-check
// Signing in to the Parallax account (0067, 0091) with the desktop app's Clerk OAuth application:
// authorization code with PKCE. With a browser here, Clerk redirects to a loopback listener (RFC
// 8252). Without one, the user signs in on any device, the relay's /connect/code page shows the
// code, and the user pastes it here. Either way only this process holds the PKCE verifier, so the
// code is useless anywhere else. The access token is handed to plxd once and never saved.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

// The Clerk instance and OAuth application the desktop app signs in with (account.ts). Both are
// public. PLX_CLERK_PUBLISHABLE_KEY and PLX_CLERK_CLIENT_ID point at another instance, as there.
const PUBLISHABLE_KEY = "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk";
const CLIENT_ID = "SXDueyOLOJ2v4Vmq";
const SCOPES = "profile email";

/**
 * The page the browser lands on after a loopback sign-in, styled as the relay's /connect/code page.
 * @param {string} [error] Why the sign-in failed, from Clerk.
 */
export function signedInPage(error) {
  const body = error
    ? `<h1>Couldn't sign in</h1><p class="error">${escapeHtml(error)}</p><p>Run plx connect again.</p>`
    : `<h1>You're signed in</h1><p>Close this tab and go back to your terminal to finish setting up this computer.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax Connect</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f7; --fg: #181818; --muted: #4f4f4f; --danger: #c42b2b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #ececec; --muted: #a3a3a3; --danger: #f87171; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(440px, 100% - 32px); }
  .brand, p { color: var(--muted); }
  .brand { font-weight: 600; }
  h1 { font-size: 22px; font-weight: 600; }
  .error { color: var(--danger); }
</style>
</head>
<body>
<main>
<p class="brand">Parallax</p>
${body}
</main>
</body>
</html>`;
}

/** @param {string} text */
const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** Parallax Relay, whose /connect/code page is the pasted sign-in's redirect URI. */
const RELAY_URL = "https://relay.parallax.codes";

/**
 * @typedef {object} Clerk
 * @property {string} api The Frontend API, such as `https://clerk.parallax.codes`.
 * @property {string} clientId The OAuth application's client id.
 */

/** The Frontend API a publishable key names: `pk_test_` or `pk_live_`, then base64 of `<host>$`. @param {string} key */
export function frontendApi(key) {
  const encoded = key.replace(/^pk_(test|live)_/, "");
  return `https://${Buffer.from(encoded, "base64").toString().replace(/\$$/, "")}`;
}

/** The Clerk application to sign in with, from `env`. @param {NodeJS.ProcessEnv} env @returns {Clerk} */
export const clerkOf = (env) => ({
  api: frontendApi(env["PLX_CLERK_PUBLISHABLE_KEY"] || PUBLISHABLE_KEY),
  clientId: env["PLX_CLERK_CLIENT_ID"] || CLIENT_ID,
});

/** Where the pasted sign-in's redirect lands: the relay's page that shows the code. @param {NodeJS.ProcessEnv} env */
export const codePage = (env) => `${(env["PLX_RELAY_URL"] || RELAY_URL).replace(/\/+$/, "")}/connect/code`;

/**
 * Whether sign-in can open a browser here: not with `--no-browser`, not over SSH, and on Linux
 * not without a display.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @param {boolean} noBrowser
 */
export function canOpenBrowser(env, platform, noBrowser) {
  if (noBrowser || env["SSH_CONNECTION"]) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return !!(env["DISPLAY"] || env["WAYLAND_DISPLAY"]);
}

/**
 * Clerk's authorize URL for this sign-in.
 * @param {Clerk} clerk
 * @param {{ redirectUri: string, state: string, verifier: string }} request
 */
export function authorizeUrl(clerk, { redirectUri, state, verifier }) {
  const url = new URL(`${clerk.api}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clerk.clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

/**
 * Trades an authorization code for an access token at Clerk's token endpoint, as the public
 * client, with the PKCE verifier.
 * @param {Clerk} clerk
 * @param {{ code: string, verifier: string, redirectUri: string }} grant
 * @returns {Promise<string>}
 */
export async function redeem(clerk, { code, verifier, redirectUri }) {
  const res = await fetch(`${clerk.api}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clerk.clientId,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = /** @type {Record<string, unknown>} */ (await res.json().catch(() => ({})));
  if (res.ok && typeof body["access_token"] === "string") return body["access_token"];
  const why = [body["error_description"], body["error"]].find((v) => typeof v === "string");
  throw new Error(`Clerk didn't accept the code: ${why ?? `it answered ${res.status}`}.`);
}

/**
 * @typedef {object} SignInOptions
 * @property {Clerk} clerk
 * @property {boolean} browser Whether to open a browser here, from `canOpenBrowser`.
 * @property {string} codePage The pasted sign-in's redirect URI.
 * @property {(url: string) => Promise<boolean>} open Opens `url` in a browser here.
 * @property {(question: string) => Promise<string>} prompt Asks the user for a line.
 * @property {number} [timeoutMs] How long the loopback sign-in waits.
 */

/**
 * Signs in and resolves to the access token, or rejects with why not, for people.
 * @param {SignInOptions} options
 * @returns {Promise<string>}
 */
export function signIn(options) {
  return options.browser ? signInHere(options) : signInElsewhere(options);
}

/**
 * The paste flow: prints the link, reads the code the relay's page shows, and redeems it. A code
 * Clerk refuses can be pasted again, up to 3 times, since a mistyped one doesn't use up the real
 * one.
 * @param {SignInOptions} options
 */
async function signInElsewhere({ clerk, codePage, prompt }) {
  const verifier = randomBytes(32).toString("base64url");
  const url = authorizeUrl(clerk, { redirectUri: codePage, state: randomBytes(16).toString("base64url"), verifier });
  console.log(`Open this link in a browser on any device, sign in, and allow this computer:\n\n  ${url}\n`);
  for (let tries = 1; ; tries++) {
    const code = (await prompt("Paste the code it shows: ")).trim();
    if (!code) throw new Error("No code was pasted.");
    try {
      return await redeem(clerk, { code, verifier, redirectUri: codePage });
    } catch (error) {
      if (tries === 3) throw error;
      console.log(`✗ ${error instanceof Error ? error.message : String(error)} Try again.`);
    }
  }
}

/**
 * The loopback flow: waits on 127.0.0.1, on a port the OS picks, for Clerk to send the browser
 * back to `/callback` with `state`, then redeems its code here. Any other request, such as a page
 * guessing the port, gets a 403 and the wait goes on.
 * @param {SignInOptions} options
 * @returns {Promise<string>}
 */
async function signInHere({ clerk, open, timeoutMs = 10 * 60_000 }) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  /** @type {(result: { token?: string, error?: string }) => void} */
  let settle = () => {};
  const done = new Promise((resolve) => (settle = resolve));
  let answered = false;
  const server = createServer((req, res) => {
    // Only this address: a DNS-rebound name pointing here gets nothing.
    if (req.headers.host !== host) return void res.writeHead(403).end();
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method !== "GET" || url.pathname !== "/callback") return void res.writeHead(404).end();
    if (answered || url.searchParams.get("state") !== state) return void res.writeHead(403).end("Start signing in from plx connect.");
    answered = true;
    const code = url.searchParams.get("code");
    /** @type {Promise<{ token?: string, error?: string }>} */
    const redeemed = code
      ? redeem(clerk, { code, verifier, redirectUri }).then((token) => ({ token }), (error) => ({ error: String(error.message) }))
      : Promise.resolve({ error: url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "Clerk sent no code." });
    void redeemed.then((result) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }).end(signedInPage(result.error));
      settle(result);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const host = `127.0.0.1:${address.port}`;
  const redirectUri = `http://${host}/callback`;
  const timer = setTimeout(() => settle({ error: "Sign-in timed out. Run it again." }), timeoutMs);
  try {
    const url = authorizeUrl(clerk, { redirectUri, state, verifier });
    const opened = await open(url);
    console.log(`${opened ? "Opened your browser to sign in. If it didn't open, go" : "Go"} to:\n\n  ${url}\n`);
    const result = /** @type {{ token?: string, error?: string }} */ (await done);
    if (!result.token) throw new Error(result.error);
    return result.token;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/**
 * Opens `url` in the default browser and resolves to whether the opener started.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export function openBrowser(url) {
  const [file, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore", detached: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
