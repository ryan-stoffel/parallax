import i18next, { t } from "i18next";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The wait for one sign-in: `redirectUri` to send to Clerk, and `done`, which resolves to undefined
 * once signed in, or to why it stopped: an error from Clerk or `signIn`, `close`, or `timeoutMs`.
 */
export type Callback = {
  redirectUri: string;
  done: Promise<string | undefined>;
  close: () => void;
};

/**
 * Waits on 127.0.0.1, on a port the OS picks, for the browser to come back from Clerk's sign-in
 * page to `/callback` (RFC 8252, 0067), then hands its code to `signIn`, which trades it in main,
 * so the browser never holds a token. Only a callback that carries `state` counts: anything else,
 * such as another local program or a page guessing the port, gets a 403 and the wait goes on.
 */
export async function serveCallback(
  state: string,
  signIn: (code: string) => Promise<string | undefined>,
  timeoutMs = 15 * 60_000,
): Promise<Callback> {
  let settle!: (error: string | undefined) => void;
  const done = new Promise<string | undefined>((resolve) => (settle = resolve));

  // A request that breaks off, such as a closed tab, just ends.
  const server = createServer((req, res) => void route(req, res).catch(() => res.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setTimeout(() => stop(t("Sign-in timed out. Try again.")), timeoutMs);
  let answered = false;
  function stop(error: string | undefined) {
    clearTimeout(timer);
    settle(error);
    server.close();
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    // Only this address: a DNS-rebound name pointing here gets nothing.
    if (req.headers.host !== host) return void res.writeHead(403).end();
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method !== "GET" || url.pathname !== "/callback") return void res.writeHead(404).end();
    if (answered || url.searchParams.get("state") !== state)
      return void res.writeHead(403).end(t("Start signing in from the Parallax app."));
    answered = true;
    const code = url.searchParams.get("code");
    const error = code
      ? await signIn(code).catch((e: Error) => e.message)
      : (url.searchParams.get("error_description") ??
        url.searchParams.get("error") ??
        t("Clerk sent no code."));
    page(res, !!error);
    setImmediate(() => stop(error));
  }

  return {
    redirectUri: `http://${host}/callback`,
    done,
    close: () => stop(t("Sign-in was cancelled.")),
  };
}

/**
 * The page the browser ends on, styled as `plx connect`'s pages and the app's onboarding. A failure
 * shows a fixed message: the app gets the reason from `done`. Its style runs only with the
 * response's nonce, and it runs no script.
 */
function page(res: ServerResponse, failed: boolean) {
  const nonce = randomUUID();
  const body = failed
    ? `<div class="hero"><span class="glow blue"></span><span class="glow coral"></span><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="part-blue" cx="6.5" cy="6.5" r="5.5" fill="#2b5cff"/><circle class="part-coral" cx="17.5" cy="17.5" r="5.5" fill="#ff4a1f"/></svg></div>
<h1>${t("That didn't line up")}</h1>
<p>${t("Your sign-in slipped out of view. Go back to Parallax to try again from a better angle.")}</p>`
    : `<div class="hero"><span class="glow blue"></span><span class="glow coral"></span><svg viewBox="0 0 24 24" aria-hidden="true"><clipPath id="overlap"><circle class="meet-blue" cx="9.5" cy="9.5" r="7"/></clipPath><circle class="meet-blue" cx="9.5" cy="9.5" r="7" fill="#2b5cff"/><circle class="meet-coral" cx="14.5" cy="14.5" r="7" fill="#ff4a1f"/><circle class="meet-coral" cx="14.5" cy="14.5" r="7" clip-path="url(#overlap)" fill="var(--overlap)"/></svg></div>
<h1>${t("You're signed in")}</h1>
<p>${t("You can close this tab and go back to Parallax.")}</p>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "cache-control": "no-store",
    connection: "close",
  }).end(`<!doctype html>
<html lang="${i18next.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${failed ? t("Couldn't sign in to Parallax") : t("Signed in to Parallax")}</title>
<style nonce="${nonce}">
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
<footer>${t("Secured by {{name}}", { name: `<b><svg viewBox="0 0 128 128" fill="currentColor" aria-hidden="true"><circle cx="64" cy="64" r="20"/><path fill-opacity=".4" d="M99.572 10.788c1.999 1.34 2.17 4.156.468 5.858L85.424 31.262c-1.32 1.32-3.37 1.53-5.033.678A35.846 35.846 0 0 0 64 28c-19.882 0-36 16.118-36 36a35.846 35.846 0 0 0 3.94 16.391c.851 1.663.643 3.712-.678 5.033L16.646 100.04c-1.702 1.702-4.519 1.531-5.858-.468C3.974 89.399 0 77.163 0 64 0 28.654 28.654 0 64 0c13.163 0 25.399 3.974 35.572 10.788Z"/><path d="M100.04 111.354c1.702 1.702 1.531 4.519-.468 5.858C89.399 124.026 77.164 128 64 128c-13.164 0-25.399-3.974-35.572-10.788-2-1.339-2.17-4.156-.468-5.858l14.615-14.616c1.322-1.32 3.37-1.53 5.033-.678A35.847 35.847 0 0 0 64 100a35.846 35.846 0 0 0 16.392-3.94c1.662-.852 3.712-.643 5.032.678l14.616 14.616Z"/></svg>Clerk</b>` })}</footer>
</body>
</html>`);
}
