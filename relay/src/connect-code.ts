/**
 * `GET /connect/code` (0091): where Clerk sends the browser after a `plx connect` sign-in that
 * couldn't open a browser on its own computer. The page shows the authorization code from the
 * query for the user to paste into plx, which redeems it with the PKCE verifier only it holds.
 * It's the redirect URI the desktop app's OAuth application registers for this.
 *
 * Nothing here logs or keeps the code: it goes from the query into the page and nowhere else. The
 * page runs no script, its style runs only with the response's nonce, it's never cached, and it
 * sends no referrer.
 */
export function connectCode(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const query = new URL(request.url).searchParams;
  const code = query.get("code");
  const error = query.get("error_description") ?? query.get("error");
  const body = code
    ? `<h1>Paste this code into plx</h1>
<p>Copy it and paste it where the terminal asks. It works once, for a few minutes, and only in the terminal that started this sign-in.</p>
<output>${escapeHtml(code)}</output>`
    : `<h1>Couldn't sign in</h1>
<p class="error">${escapeHtml(error ?? "Clerk sent no code.")}</p>
<p>Run plx connect again.</p>`;
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallax Connect</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg: #f7f7f7; --fg: #181818; --muted: #4f4f4f; --danger: #c42b2b; --box: #ffffff; --line: #d4d4d4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #ececec; --muted: #a3a3a3; --danger: #f87171; --box: #111; --line: #2a2a2a; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(440px, 100% - 32px); }
  .brand, p { color: var(--muted); }
  .brand { font-weight: 600; }
  h1 { font-size: 22px; font-weight: 600; }
  output { display: block; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--box);
    font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; user-select: all; }
  .error { color: var(--danger); }
</style>
</head>
<body>
<main>
<p class="brand">Parallax</p>
${body}
</main>
</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
