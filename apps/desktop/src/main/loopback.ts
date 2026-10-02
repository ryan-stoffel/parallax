import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { resultPage, signInPage } from "./signInPage";

export type OAuthProvider = "github" | "google" | "apple";
const providers: readonly string[] = ["github", "google", "apple"] satisfies OAuthProvider[];

export type NewAccount = { firstName: string; lastName: string; email: string; password: string };

/** What the page shows after a step: signed in, an error, or a note such as "check your email". */
export type Answer = { signedIn: true } | { error: string } | { note: string };

/** The account steps the sign-in page asks the app for. Tokens stay with these, in main. */
export type Accounts = {
  /** The provider's sign-in page, which sends the browser back to `redirectTo` with a code. */
  oauthUrl(provider: OAuthProvider, redirectTo: string): Promise<string | { error: string }>;
  signIn(email: string, password: string): Promise<Answer>;
  /** The confirmation email's link comes back to `redirectTo` with a code. */
  signUp(account: NewAccount, redirectTo: string): Promise<Answer>;
  /** Trades a code that came back to `redirectTo` for a session, with its PKCE flow's id. */
  exchange(code: string, flowId: string | undefined): Promise<Answer>;
};

/**
 * The open sign-in page: `url` to open in the browser, which carries the page's secret (a
 * `create` parameter opens Create an account), and
 * `done`, which resolves to undefined once signed in, or to why it stopped: on `close`, or after
 * `timeoutMs`.
 */
export type SignInPage = { url: string; done: Promise<string | undefined>; close: () => void };

/**
 * Serves the Parallax sign-in page on 127.0.0.1, on a port the OS picks (0037). The browser signs
 * in or creates an account there with a provider or an email, and providers and email links
 * redirect back to its `/callback` (RFC 8252). Every step runs through `accounts`, so the page
 * never holds a token. A failed step shows on the page, which can try again.
 *
 * Only the browser the app opened may sign in: `url` carries a secret, which the first visit
 * trades for a cookie that starting a sign-in requires. The secret works only that once. `/callback` needs none, since PKCE ties
 * its code to this app.
 */
export async function serveSignIn(
  accounts: Accounts,
  timeoutMs = 60 * 60_000,
): Promise<SignInPage> {
  let settle!: (error: string | undefined) => void;
  const done = new Promise<string | undefined>((resolve) => (settle = resolve));

  // A request that breaks off, such as a closed tab, just ends.
  const server = createServer((req, res) => void route(req, res).catch(() => res.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${host}`;
  const callback = `${origin}/callback`;
  const secret = randomUUID();
  // Cookies ignore ports, so the port keeps two pages' cookies apart.
  const cookie = `parallax-${host.split(":")[1]}=${secret}`;
  // The secret works once, on the first visit: a browser's command line can show its URL.
  let unopened = true;

  const timer = setTimeout(() => stop("Sign-in timed out. Try again."), timeoutMs);
  function stop(error: string | undefined) {
    clearTimeout(timer);
    settle(error);
    server.close();
  }
  // A step's answer, with a thrown error as its error. Signed in ends the page.
  const attempt = async (step: () => Promise<Answer>) => {
    const answer = await step().catch((error: Error) => ({ error: error.message }));
    if ("signedIn" in answer) setImmediate(() => stop(undefined));
    return answer;
  };

  async function route(req: IncomingMessage, res: ServerResponse) {
    // Only this address: a DNS-rebound name pointing here gets nothing.
    if (req.headers.host !== host) return void res.writeHead(403).end();
    const url = new URL(req.url ?? "/", origin);
    const get = req.method === "GET";

    const opened = unopened && get && url.pathname === "/" && url.searchParams.get("s") === secret;
    if (opened) unopened = false;
    const allowed = opened || (req.headers.cookie ?? "").split(/;\s*/).includes(cookie);

    if (get && url.pathname === "/") {
      if (!allowed) return void res.writeHead(403).end("Start signing in from the Parallax app.");
      // The secret leaves the address bar and history.
      if (opened)
        return void res
          .writeHead(302, {
            location: url.searchParams.has("create") ? "/?create" : "/",
            "set-cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/`,
            "cache-control": "no-store",
          })
          .end();
      return page(res, signInPage);
    }

    const provider = url.pathname.match(/^\/oauth\/(\w+)$/)?.[1];
    if (get && provider && providers.includes(provider)) {
      if (!allowed) return void res.writeHead(403).end();
      const target = await accounts
        .oauthUrl(provider as OAuthProvider, callback)
        .catch((error: Error) => ({ error: error.message }));
      if (typeof target !== "string") return page(res, (nonce) => resultPage(target, nonce));
      return void res.writeHead(302, { location: target, "cache-control": "no-store" }).end();
    }

    if (get && url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const answer = code
        ? await attempt(() =>
            accounts.exchange(code, url.searchParams.get("sb_flow_id") ?? undefined),
          )
        : {
            error:
              url.searchParams.get("error_description") ??
              url.searchParams.get("error") ??
              "The sign-in page sent no code.",
          };
      return page(res, (nonce) => resultPage(answer, nonce));
    }

    if (req.method === "POST" && url.pathname === "/email") {
      // Only the page itself: browsers send Origin with every POST.
      if (!allowed || req.headers.origin !== origin) return void res.writeHead(403).end();
      const form = await readJson(req);
      if (!form) return void res.writeHead(400).end();
      const text = (key: string) => (typeof form[key] === "string" ? form[key] : "");
      const [email, password] = [text("email").trim(), text("password")];
      const answer = await attempt(() =>
        form["create"] === true
          ? accounts.signUp(
              { firstName: text("firstName"), lastName: text("lastName"), email, password },
              callback,
            )
          : accounts.signIn(email, password),
      );
      return void res
        .writeHead(200, { "content-type": "application/json", connection: "close" })
        .end(JSON.stringify(answer));
    }

    res.writeHead(404).end();
  }

  return { url: `${origin}/?s=${secret}`, done, close: () => stop("Sign-in was cancelled.") };
}

/**
 * Sends an HTML page with a fresh nonce, the only scripts and styles it may run, so nothing from a
 * query string or an error can.
 */
function page(res: ServerResponse, html: (nonce: string) => string) {
  const nonce = randomUUID();
  res
    .writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "cache-control": "no-store",
      connection: "close",
    })
    .end(html(nonce));
}

/** A small JSON object body, or undefined. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) return undefined;
  }
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
