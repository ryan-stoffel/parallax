import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A one-shot redirect target for sign-in: `url` to redirect to, and `done`, which resolves to an
 * error for people, or undefined once signed in.
 */
export type Loopback = { url: string; done: Promise<string | undefined>; close: () => void };

/**
 * Listens on 127.0.0.1, on a port the OS picks, for one redirect to `/callback` (RFC 8252), as
 * Supabase sends after an OAuth sign-in or an email link (0034). Its `code` goes to `onCode`,
 * which trades it for a session and resolves to an error for people, or undefined.
 * The browser gets the outcome once `onCode` settles. `done` resolves to that outcome, the
 * provider's error, or why it stopped waiting: after `timeoutMs`, or on `close`.
 */
export async function listenForCode(
  onCode: (code: string) => Promise<string | undefined>,
  timeoutMs = 10 * 60_000,
): Promise<Loopback> {
  let settle!: (error: string | undefined) => void;
  const done = new Promise<string | undefined>((resolve) => (settle = resolve));
  let answered = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Browsers also ask for /favicon.ico. Only the first redirect counts.
    if (url.pathname !== "/callback" || answered) return void res.writeHead(404).end();
    answered = true;
    clearTimeout(timer);
    const code = url.searchParams.get("code");
    const error = code
      ? await onCode(code)
      : (url.searchParams.get("error_description") ??
        url.searchParams.get("error") ??
        "The sign-in page sent no code.");
    // Plain text, so nothing from the query string can run as HTML.
    res
      .writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" })
      .end(
        error
          ? `Parallax couldn't sign you in: ${error}`
          : "Signed in to Parallax. You can close this tab.",
      );
    stop(error);
  });
  const timer = setTimeout(() => stop("Sign-in timed out. Try again."), timeoutMs);
  function stop(error: string | undefined) {
    clearTimeout(timer);
    settle(error);
    server.close();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/callback`,
    done,
    close: () => stop("Sign-in was cancelled."),
  };
}
