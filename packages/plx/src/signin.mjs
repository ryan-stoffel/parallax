// @ts-check
// Signing in to the Parallax account (0067, 0091) with the desktop app's Clerk OAuth application.
// With a browser here: authorization code with PKCE, redirected to a loopback listener (RFC 8252).
// Without one: Clerk's device authorization grant (RFC 8628), where the user approves a short code
// on any device and this process polls for the token. While the grant isn't enabled on the OAuth
// application: PKCE again, with the code shown by the relay's /connect/code page and pasted here.
// In every flow only this process holds what redeems the code (the PKCE verifier or the device
// code), so a code seen elsewhere is useless. The access token is handed to plxd once and never
// saved.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as wait } from "node:timers/promises";

// The Clerk instance and OAuth application the desktop app signs in with (account.ts): the
// development instance's until the move to production's ships (PLX-1465). Both are public.
// PLX_CLERK_PUBLISHABLE_KEY and PLX_CLERK_CLIENT_ID point at another instance, as there.
const PUBLISHABLE_KEY = "pk_test_YWRqdXN0ZWQtbWFzdG9kb24tODcwNS5jbGVyay5hY2NvdW50cy5kZXYk";
const CLIENT_ID = "SXDueyOLOJ2v4Vmq";
const SCOPES = "profile email";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The page the browser lands on after a loopback sign-in, styled as the relay's /connect/code page
 * and the app's onboarding. A failure shows a fixed message: plx connect prints the reason.
 * @param {boolean} [failed]
 */
export function signedInPage(failed) {
  const body = failed
    ? `<div class="hero"><span class="glow blue"></span><span class="glow coral"></span><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="part-blue" cx="6.5" cy="6.5" r="5.5" fill="#2b5cff"/><circle class="part-coral" cx="17.5" cy="17.5" r="5.5" fill="#ff4a1f"/></svg></div>
<h1>That didn't line up</h1>
<p>Your sign-in slipped out of view. Run <code>plx connect</code> in your terminal to try again from a better angle.</p>`
    : `<div class="hero"><span class="glow blue"></span><span class="glow coral"></span><svg viewBox="0 0 24 24" aria-hidden="true"><clipPath id="overlap"><circle class="meet-blue" cx="9.5" cy="9.5" r="7"/></clipPath><circle class="meet-blue" cx="9.5" cy="9.5" r="7" fill="#2b5cff"/><circle class="meet-coral" cx="14.5" cy="14.5" r="7" fill="#ff4a1f"/><circle class="meet-coral" cx="14.5" cy="14.5" r="7" clip-path="url(#overlap)" fill="var(--overlap)"/></svg></div>
<h1>You're signed in</h1>
<p>Close this tab and go back to your terminal to finish setting up this computer.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax Connect</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --surface: #fff; --fg: #1e1b4b; --muted: #4a4868; --faint: #64627e; --line: rgb(30 27 75 / 10%);
    --primary: #1e1b4b; --on-primary: #fff; --accent: #2b5cff; --overlap: #1e1b4b; --shadow: 0 10px 30px -16px rgb(30 27 75 / 22%); }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --surface: #0e0e0e; --fg: #e8e8e8; --muted: #a3a3a3; --faint: #8a8a8a; --line: rgb(255 255 255 / 10%);
    --primary: #e8e8e8; --on-primary: #000; --accent: #5b80ff; --overlap: #e4e4e7; --shadow: 0 14px 36px -18px rgb(0 0 0 / 80%); } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; grid-template-rows: auto 1fr auto; background: var(--bg); color: var(--fg);
    font: 14px/1.5 "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  header { display: flex; align-items: center; gap: 6px; padding: 16px 20px; color: var(--muted); }
  header svg:first-child { width: 16px; height: 16px; }
  header svg:last-child { width: auto; height: 10px; overflow: visible; }
  main { display: flex; flex-direction: column; align-items: center; justify-content: center; width: min(520px, 100%); margin: auto; padding: 16px; text-align: center; animation: rise .45s cubic-bezier(.22, 1, .36, 1) both; }
  footer { display: flex; align-items: center; justify-content: center; gap: 4px; padding: 16px; color: var(--faint); font-size: 12px; }
  footer b { display: flex; align-items: center; gap: 2px; color: var(--muted); font-weight: 600; }
  footer svg { width: 14px; height: 14px; }
  .hero { position: relative; display: grid; place-items: center; width: 112px; height: 112px; margin-bottom: 24px; }
  .hero svg { position: relative; width: 96px; height: 96px; }
  .glow { position: absolute; width: 64px; height: 64px; border-radius: 50%; filter: blur(40px); animation: glow 6s ease-in-out infinite alternate; }
  .glow.blue { top: 8px; left: 8px; background: rgb(43 92 255 / 40%); }
  .glow.coral { right: 8px; bottom: 8px; background: rgb(255 74 31 / 40%); animation-delay: -3s; }
  .meet-blue, .meet-coral, .part-blue, .part-coral { animation: 1.1s cubic-bezier(.34, 1.3, .64, 1) both; }
  .meet-blue { animation-name: meet-blue; }
  .meet-coral { animation-name: meet-coral; }
  .part-blue { animation-name: part-blue; }
  .part-coral { animation-name: part-coral; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
  @keyframes glow { to { opacity: .5; scale: 1.25; } }
  @keyframes meet-blue { from { opacity: 0; translate: -6px -6px; } }
  @keyframes meet-coral { from { opacity: 0; translate: 6px 6px; } }
  /* On a failed sign-in the circles drift apart instead of meeting. */
  @keyframes part-blue { from { translate: 4px 4px; } }
  @keyframes part-coral { from { translate: -4px -4px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  h1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.25; letter-spacing: -.02em; }
  p { margin: 8px 0 0; max-width: 448px; color: var(--muted); text-wrap: balance; }
  p code { color: var(--fg); font: .93em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
</style>
</head>
<body>
<header>
<svg viewBox="0 0 24 24" aria-hidden="true"><clipPath id="brand-overlap"><circle cx="9.5" cy="9.5" r="7"/></clipPath><circle cx="9.5" cy="9.5" r="7" fill="#2b5cff"/><circle cx="14.5" cy="14.5" r="7" fill="#ff4a1f"/><circle cx="14.5" cy="14.5" r="7" clip-path="url(#brand-overlap)" fill="var(--overlap)"/></svg>
<svg viewBox="0 0 4036 730" fill="currentColor" role="img" aria-label="Parallax"><path d="M212 506V383H354Q396 383 426 366Q456 349 471 319Q487 289 487 250Q487 211 471 181Q456 151 426 134Q396 118 354 118H212V-5H342Q434 -5 498 25Q563 55 597 110Q631 166 631 242V258Q631 334 597 390Q563 446 498 476Q434 506 342 506ZM90 730V-5H232V730ZM1066 730V569H1042V390Q1042 344 1020 320Q996 297 949 297Q924 297 889 298Q854 299 818 300Q783 302 755 304V186Q778 184 807 182Q836 180 866 180Q897 179 924 179Q1008 179 1063 201Q1119 224 1147 270Q1176 318 1176 394V730ZM890 744Q832 744 787 723Q743 702 718 663Q694 624 694 569Q694 510 723 471Q752 433 806 414Q860 396 932 396H1058V478H930Q882 478 856 502Q831 525 831 562Q831 600 856 622Q882 645 930 645Q958 645 983 634Q1008 624 1024 599Q1040 574 1042 529L1076 568Q1072 625 1049 664Q1026 703 987 724Q948 744 890 744ZM1325 730V187H1435V417H1432Q1432 300 1482 240Q1532 180 1629 180H1649V301H1611Q1540 301 1502 339Q1464 376 1464 448V730ZM2070 730V569H2048V390Q2048 344 2024 320Q2002 297 1954 297Q1929 297 1894 298Q1859 299 1824 300Q1788 302 1760 304V186Q1783 184 1812 182Q1840 180 1871 180Q1902 179 1929 179Q2012 179 2068 201Q2124 224 2152 270Q2180 318 2180 394V730ZM1896 744Q1836 744 1792 723Q1748 702 1724 663Q1699 624 1699 569Q1699 510 1728 471Q1758 433 1811 414Q1864 396 1936 396H2062V478H1934Q1887 478 1862 502Q1836 525 1836 562Q1836 600 1862 622Q1887 645 1934 645Q1964 645 1988 634Q2013 624 2029 599Q2046 574 2048 529L2082 568Q2076 625 2054 664Q2032 703 1992 724Q1952 744 1896 744ZM2337 730V0H2476V730ZM2269 104V0H2476V104ZM2642 730V0H2781V730ZM2574 104V0H2781V104ZM3268 730V569H3246V390Q3246 344 3222 320Q3200 297 3152 297Q3127 297 3092 298Q3057 299 3022 300Q2986 302 2958 304V186Q2981 184 3010 182Q3038 180 3069 180Q3100 179 3127 179Q3210 179 3266 201Q3322 224 3350 270Q3378 318 3378 394V730ZM3094 744Q3034 744 2990 723Q2946 702 2922 663Q2897 624 2897 569Q2897 510 2926 471Q2956 433 3009 414Q3062 396 3134 396H3260V478H3132Q3085 478 3060 502Q3034 525 3034 562Q3034 600 3060 622Q3085 645 3132 645Q3162 645 3186 634Q3211 624 3227 599Q3244 574 3246 529L3280 568Q3274 625 3252 664Q3230 703 3190 724Q3150 744 3094 744ZM3466 730 3643 440 3640 464 3473 187H3624L3733 378H3748L3851 187H3992L3834 462L3838 442L4024 730H3874L3744 525H3730L3608 730Z"/></svg>
</header>
<main>
${body}
</main>
<footer>Secured by <b><svg viewBox="0 0 128 128" fill="currentColor" aria-hidden="true"><circle cx="64" cy="64" r="20"/><path fill-opacity=".4" d="M99.572 10.788c1.999 1.34 2.17 4.156.468 5.858L85.424 31.262c-1.32 1.32-3.37 1.53-5.033.678A35.846 35.846 0 0 0 64 28c-19.882 0-36 16.118-36 36a35.846 35.846 0 0 0 3.94 16.391c.851 1.663.643 3.712-.678 5.033L16.646 100.04c-1.702 1.702-4.519 1.531-5.858-.468C3.974 89.399 0 77.163 0 64 0 28.654 28.654 0 64 0c13.163 0 25.399 3.974 35.572 10.788Z"/><path d="M100.04 111.354c1.702 1.702 1.531 4.519-.468 5.858C89.399 124.026 77.164 128 64 128c-13.164 0-25.399-3.974-35.572-10.788-2-1.339-2.17-4.156-.468-5.858l14.615-14.616c1.322-1.32 3.37-1.53 5.033-.678A35.847 35.847 0 0 0 64 100a35.846 35.846 0 0 0 16.392-3.94c1.662-.852 3.712-.643 5.032.678l14.616 14.616Z"/></svg>Clerk</b></footer>
</body>
</html>`;
}

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
 * @param {{ redirectUri: string, state: string, verifier: string, scope?: string }} request `scope`
 *   replaces plx's own, for a caller that needs more, such as a refresh token.
 */
export function authorizeUrl(clerk, { redirectUri, state, verifier, scope = SCOPES }) {
  const url = new URL(`${clerk.api}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clerk.clientId,
    redirect_uri: redirectUri,
    scope,
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
 * @property {(question: string) => Promise<string>} prompt Asks the user for a line, and rejects
 *   when input ends first.
 * @property {number} [timeoutMs] How long the loopback sign-in waits.
 * @property {(ms: number) => Promise<unknown>} [sleep] Waits between device grant polls. Unlike connect's unref'd sleep, this one keeps plx running.
 */

/**
 * Signs in and resolves to the access token, or rejects with why not, for people.
 * @param {SignInOptions} options
 * @returns {Promise<string>}
 */
export async function signIn(options) {
  if (options.browser) return signInHere(options);
  const device = await startDeviceGrant(options.clerk);
  return device ? finishDeviceGrant(device, options) : signInElsewhere(options);
}

/**
 * @typedef {object} DeviceGrant
 * @property {string} tokenEndpoint
 * @property {string} clientId
 * @property {string} deviceCode What redeems the approval. Stays in this process and is never printed.
 * @property {string} userCode The short code the user checks or types.
 * @property {string} verificationUri
 * @property {string} [verificationUriComplete] `verificationUri` with the user code already filled in.
 * @property {number} expiresIn Seconds.
 * @property {number} interval Seconds between polls.
 */

/**
 * Asks Clerk for a device code, or resolves to undefined when the grant isn't available, so this
 * sign-in has to use the paste flow: discovery doesn't list it, or the device endpoint answers 400
 * `invalid_grant`, as Clerk does for an OAuth application without it, or `unauthorized_client`,
 * RFC 6749's code for that. Discovery only says the instance offers the grant, so it can't settle
 * this alone. Any other failure rejects, since it would most likely stop the paste flow too.
 * @param {Clerk} clerk
 * @returns {Promise<DeviceGrant | undefined>}
 */
async function startDeviceGrant(clerk) {
  /** @param {string} url @param {RequestInit} [init] */
  const request = (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }).catch(() => {
      throw new Error("Couldn't reach Clerk to sign in. Check this computer's network and run it again.");
    });
  const found = await request(`${clerk.api}/.well-known/oauth-authorization-server`);
  if (!found.ok) throw new Error(`Clerk didn't start the sign-in: its discovery document answered ${found.status}.`);
  const metadata = /** @type {Record<string, unknown> | null | undefined} */ (await found.json().catch(() => undefined));
  const { device_authorization_endpoint: endpoint, token_endpoint: tokenEndpoint, grant_types_supported: grants } = metadata ?? {};
  // A device field left out means the grant isn't offered (RFC 8414). A wrong type is a broken document, and so is no token endpoint.
  if (typeof tokenEndpoint !== "string" || (endpoint !== undefined && typeof endpoint !== "string") || (grants !== undefined && !Array.isArray(grants))) {
    throw new Error("Clerk didn't start the sign-in: its discovery document is malformed.");
  }
  if (typeof endpoint !== "string" || !Array.isArray(grants) || !grants.includes(DEVICE_GRANT)) return undefined;
  const res = await request(endpoint, { method: "POST", body: new URLSearchParams({ client_id: clerk.clientId, scope: SCOPES }) });
  const body = /** @type {Record<string, unknown>} */ (await res.json().catch(() => ({})));
  if (res.status === 400 && (body["error"] === "invalid_grant" || body["error"] === "unauthorized_client")) return undefined;
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, verification_uri_complete: complete, expires_in: expiresIn, interval } = body;
  if (!res.ok || typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string" || typeof expiresIn !== "number") {
    const why = [body["error_description"], body["error"]].find((v) => typeof v === "string");
    throw new Error(`Clerk didn't start the sign-in: ${why ?? `it answered ${res.status}`}.`);
  }
  return {
    tokenEndpoint,
    clientId: clerk.clientId,
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof complete === "string" ? { verificationUriComplete: complete } : {}),
    expiresIn,
    // RFC 8628 3.2: 5 seconds when the server names none.
    interval: typeof interval === "number" && interval > 0 ? interval : 5,
  };
}

/**
 * Prints the link and the short code, then polls Clerk's token endpoint until the user approves,
 * as RFC 8628 3.5 sets out: the first poll waits one interval, `slow_down` adds 5 seconds for good,
 * and a connection failure or a server error doubles the interval. Once the code is on screen a
 * failure is an error for the user, not a fallback, since they may already be approving it.
 * @param {DeviceGrant} device
 * @param {SignInOptions} options
 * @returns {Promise<string>}
 */
async function finishDeviceGrant(device, { sleep = wait }) {
  const { tokenEndpoint, clientId, deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn } = device;
  const ask = verificationUriComplete
    ? `Open this link in a browser on any device, sign in, and allow this computer if it shows this code:\n\n  ${verificationUriComplete}\n\n  Code: ${userCode}\n`
    : `Open this link in a browser on any device, sign in, enter this code, and allow this computer:\n\n  ${verificationUri}\n\n  Code: ${userCode}\n`;
  console.log(ask);
  const expired = new Error("The code expired before it was approved. Run it again.");
  const deadline = Date.now() + expiresIn * 1000;
  let { interval } = device;
  for (;;) {
    // Checked both ways, so no poll goes out for a code already gone: a wait cut short by the
    // deadline can wake a millisecond early, and any wait can wake late, as after a laptop's sleep.
    const left = deadline - Date.now();
    await sleep(Math.max(0, Math.min(interval * 1000, left)));
    if (interval * 1000 >= left || Date.now() >= deadline) throw expired;
    /** @type {Response} */
    let res;
    try {
      res = await fetch(tokenEndpoint, {
        method: "POST",
        body: new URLSearchParams({ client_id: clientId, grant_type: DEVICE_GRANT, device_code: deviceCode }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      interval *= 2;
      continue;
    }
    const body = /** @type {Record<string, unknown>} */ (await res.json().catch(() => ({})));
    if (res.ok && typeof body["access_token"] === "string") return body["access_token"];
    const error = body["error"];
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") throw new Error("The sign-in was denied. Run it again to try once more.");
    if (error === "expired_token") throw expired;
    if (typeof error !== "string" && (res.status >= 500 || res.status === 429)) {
      interval *= 2;
      continue;
    }
    const why = [body["error_description"], error].find((v) => typeof v === "string");
    throw new Error(`Clerk didn't finish the sign-in: ${why ?? `it answered ${res.status}`}.`);
  }
}

/**
 * The paste flow, for when the device grant isn't enabled: prints the link, reads the code the
 * relay's page shows, and redeems it. A code Clerk refuses can be pasted again, up to 3 times, since
 * a mistyped one doesn't use up the real one.
 * @param {SignInOptions} options
 */
async function signInElsewhere({ clerk, codePage, prompt }) {
  const verifier = randomBytes(32).toString("base64url");
  const url = authorizeUrl(clerk, { redirectUri: codePage, state: randomBytes(16).toString("base64url"), verifier });
  console.log(`Open this link in a browser on any device, sign in, and allow this computer:\n\n  ${url}\n`);
  for (let tries = 1; ; ) {
    // It rejects once input ends: nothing more can arrive, so this fails rather than waiting on.
    const answer = await prompt("Paste the code it shows: ").catch(() => {
      throw new Error("No code was entered before input ended. Run it again in a terminal, or send the code on stdin.");
    });
    const code = answer.trim();
    // An empty line isn't an answer: a stray Enter, such as one copied with the command, waits on.
    if (!code) continue;
    tries++;
    try {
      return await redeem(clerk, { code, verifier, redirectUri: codePage });
    } catch (error) {
      if (tries > 3) throw error;
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" }).end(signedInPage(!!result.error));
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
