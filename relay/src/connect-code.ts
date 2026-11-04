/**
 * `GET /connect/code` (0091): where Clerk sends the browser after a `plx connect` sign-in that
 * couldn't open a browser on its own computer. The page shows the authorization code from the
 * query for the user to paste into plx, which redeems it with the PKCE verifier only it holds.
 * It's the redirect URI the desktop app's OAuth application registers for this. It looks like the
 * app's onboarding (Onboarding.tsx).
 *
 * Nothing here logs or keeps the code: it goes from the query into the page and nowhere else. The
 * page's one script copies the code to the clipboard. Script and style run only with the
 * response's nonce, the policy allows no requests, it's never cached, and it sends no referrer.
 * Without script the copy button stays hidden and a click still selects the whole code.
 *
 * A failed sign-in shows a fixed message and the command to try again. What Clerk sent isn't shown.
 * plx is still waiting for a code then, so the page says to stop it first.
 */
export function connectCode(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const code = new URL(request.url).searchParams.get("code");
  const nonce = crypto.randomUUID();
  const value = code || "plx connect";
  const body = code
    ? `<div class="hero"><span class="glow blue"></span><span class="glow coral"></span><svg viewBox="0 0 24 24" aria-hidden="true"><clipPath id="overlap"><circle class="meet-blue" cx="9.5" cy="9.5" r="7"/></clipPath><circle class="meet-blue" cx="9.5" cy="9.5" r="7" fill="#2b5cff"/><circle class="meet-coral" cx="14.5" cy="14.5" r="7" fill="#ff4a1f"/><circle class="meet-coral" cx="14.5" cy="14.5" r="7" clip-path="url(#overlap)" fill="var(--overlap)"/></svg></div>
<h1>Finish signing in</h1>
<p>Copy this code and paste it into the terminal running <code>plx connect</code>.</p>
${copyable(value, "Copy code", "Now paste it in your terminal. You can close this tab after.", "It works once, for a few minutes, and only in that terminal.", nonce)}`
    : `<div class="hero"><span class="glow blue"></span><span class="glow coral"></span><svg viewBox="0 0 24 24" aria-hidden="true"><circle class="part-blue" cx="6.5" cy="6.5" r="5.5" fill="#2b5cff"/><circle class="part-coral" cx="17.5" cy="17.5" r="5.5" fill="#ff4a1f"/></svg></div>
<h1>That didn't line up</h1>
<p>Your sign-in slipped out of view. Press Ctrl+C in your terminal, then run this to try again from a better angle.</p>
${copyable(value, "Copy command", "Now press Ctrl+C in your terminal and run it.", "This computer isn't signed in yet.", nonce)}`;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax Connect</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3CclipPath id='c'%3E%3Ccircle cx='9.5' cy='9.5' r='7'/%3E%3C/clipPath%3E%3Ccircle cx='9.5' cy='9.5' r='7' fill='%232b5cff'/%3E%3Ccircle cx='14.5' cy='14.5' r='7' fill='%23ff4a1f'/%3E%3Ccircle cx='14.5' cy='14.5' r='7' clip-path='url(%23c)' fill='%23e4e4e7'/%3E%3C/svg%3E">
<style nonce="${nonce}">
  /* The desktop app's tokens (index.css). */
  :root { color-scheme: light dark; --bg: #fff; --surface: #fff; --fg: #1e1b4b; --muted: #4a4868; --faint: #64627e; --line: rgb(30 27 75 / 10%);
    --primary: #1e1b4b; --on-primary: #fff; --accent: #2b5cff; --overlap: #1e1b4b; --shadow: 0 10px 30px -16px rgb(30 27 75 / 22%); }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --surface: #0e0e0e; --fg: #e8e8e8; --muted: #a3a3a3; --faint: #8a8a8a; --line: rgb(255 255 255 / 10%);
    --primary: #e8e8e8; --on-primary: #000; --accent: #5b80ff; --overlap: #e4e4e7; --shadow: 0 14px 36px -18px rgb(0 0 0 / 80%); } }
  @font-face { font-family: "Parallax Mono"; src: url(data:font/woff2;base64,${MONO_FONT}) format("woff2"); }
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
  .code { align-self: stretch; margin-top: 36px; padding: 14px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); }
  .fit { container-type: inline-size; }
  /* Sized so the whole value fits on one line. A monospace character is about .6em wide. */
  output { display: block; overflow-x: auto; scrollbar-width: none; white-space: nowrap; user-select: all; -webkit-user-select: all;
    font: clamp(9px, calc(100cqw / (${value.length} * .61)), 15px)/1.5 "Parallax Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 100%; margin-top: 12px; padding: 8px 16px; border: 0; border-radius: 8px;
    background: var(--primary); color: var(--on-primary); font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; cursor: pointer; }
  button[hidden] { display: none; }
  button:hover { opacity: .9; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .check, .copied .copy { display: none; }
  .copied .check { display: block; animation: pop .45s cubic-bezier(.34, 1.56, .64, 1) both; }
  @keyframes pop { from { opacity: 0; scale: .5; } }
  [role="status"] { min-height: 40px; margin-top: 12px; color: var(--muted); font-size: 13px; }
  @media (max-width: 480px) { .code { padding: 14px 12px; } }
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
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

/** `value` on one line, a button that copies it, and a status line that says what to do next. */
function copyable(value: string, label: string, after: string, status: string, nonce: string) {
  return `<div class="code"><div class="fit"><output>${escapeHtml(value)}</output></div></div>
<button type="button" hidden>
<svg viewBox="0 0 24 24" aria-hidden="true" class="copy"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2"/></svg>
<svg viewBox="0 0 24 24" aria-hidden="true" class="check"><path d="M20 6 9 17l-5-5"/></svg>
<span>${label}</span>
</button>
<p role="status">${status}</p>
<script nonce="${nonce}">
  const output = document.querySelector("output"), button = document.querySelector("button"), text = button.querySelector("span"), note = document.querySelector("[role=status]");
  let timer;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(output.textContent);
      button.classList.add("copied");
      text.textContent = "Copied";
      note.textContent = "${after}";
      clearTimeout(timer);
      timer = setTimeout(() => { button.classList.remove("copied"); text.textContent = "${label}"; }, 2000);
    } catch {
      getSelection().selectAllChildren(output);
      note.textContent = "Press Ctrl+C or ⌘C to copy.";
    }
  });
</script>`;
}

/** JetBrains Mono, the app's code font, cut down to what a code uses. Its OFL notice is in its name table. */
const MONO_FONT = "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";

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
