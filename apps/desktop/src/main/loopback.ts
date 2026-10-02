import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A one-shot redirect target for sign-in: `url` to redirect to, `code` once the browser gets there. */
export type Loopback = { url: string; code: Promise<string>; close: () => void };

/**
 * Listens on 127.0.0.1, on a port the OS picks, for one redirect to `/callback` (RFC 8252), as
 * Supabase sends after an OAuth sign-in or an email link (0034). `code` resolves to its `code`
 * query parameter, or rejects with the provider's error, after `timeoutMs`, or on `close`.
 */
export async function listenForCode(timeoutMs = 10 * 60_000): Promise<Loopback> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  // Callers that close or time out before awaiting `code` mustn't see an unhandled rejection.
  code.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Browsers also ask for /favicon.ico.
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const found = url.searchParams.get("code");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    // Plain text, so nothing from the query string can run as HTML.
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" })
      .end(
        found
          ? "Signed in to Parallax. You can close this tab."
          : `Parallax couldn't sign you in: ${error ?? "no code came back"}`,
      );
    if (found) settle.resolve(found);
    else settle.reject(new Error(error ?? "The sign-in page sent no code."));
    close();
  });
  const timer = setTimeout(() => {
    settle.reject(new Error("Sign-in timed out. Try again."));
    close();
  }, timeoutMs);
  function close() {
    clearTimeout(timer);
    settle.reject(new Error("Sign-in was cancelled."));
    server.close();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/callback`, code, close };
}
