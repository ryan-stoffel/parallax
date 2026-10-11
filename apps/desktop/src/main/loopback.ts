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
  const timer = setTimeout(() => stop("Sign-in timed out. Try again."), timeoutMs);
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
      return void res.writeHead(403).end("Start signing in from the Parallax app.");
    answered = true;
    const code = url.searchParams.get("code");
    const error = code
      ? await signIn(code).catch((e: Error) => e.message)
      : (url.searchParams.get("error_description") ??
        url.searchParams.get("error") ??
        "Clerk sent no code.");
    page(res, error);
    setImmediate(() => stop(error));
  }

  return {
    redirectUri: `http://${host}/callback`,
    done,
    close: () => stop("Sign-in was cancelled."),
  };
}

/**
 * The page the browser ends on: signed in, or why not. Its style runs only with the response's
 * nonce, and it runs no script, so nothing from a query string or an error can.
 */
function page(res: ServerResponse, error: string | undefined) {
  const nonce = randomUUID();
  const title = error ? "Couldn't sign in to Parallax" : "Signed in to Parallax";
  const note = error
    ? `<p class="error">${escapeHtml(error)}</p><p>Start again from the Parallax app.</p>`
    : "<p>You can close this tab and go back to Parallax.</p>";
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "cache-control": "no-store",
    connection: "close",
  }).end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg: #f7f7f7; --fg: #181818; --muted: #4f4f4f; --danger: #c42b2b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #ececec; --muted: #a3a3a3; --danger: #f87171; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(400px, 100% - 32px); }
  .brand, p { color: var(--muted); }
  .brand { font-weight: 600; }
  h1 { font-size: 22px; font-weight: 600; }
  .error { color: var(--danger); }
</style>
</head>
<body>
<main>
<p class="brand">Parallax</p>
<h1>${title}</h1>
${note}
</main>
</body>
</html>`);
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
