/**
 * The relay's log lines, one JSON object each, so Workers Logs can query them by field (PLX-1349).
 * Ids are cut to 8 characters, and no line holds a user id, token, or payload.
 *
 * How a lost control socket reads:
 * - `socket_closed` with `by: "peer"`, `clean: false`: the relay saw the connection die.
 * - `socket_closed` with `by: "relay"`: the relay ended it, and a `socket_closing` line before it
 *   says why.
 * - `host_connected` with `open_before: 1` and no `socket_closed` before it: plxd is back and the
 *   relay never heard that its old connection died, so it died outside the object.
 * - `host_connected` with `open_before: 0` and no `socket_closed` before it: the object lost its
 *   sockets with no handler run, as a reset or a deploy does.
 */

/** Writes one line. Callers pass only ids from [`short`] and text from [`scrub`]. */
export function logEvent(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

/** The first 8 characters of a host, stream, or object id. */
export const short = (id: string) => id.slice(0, 8);

/** `text` without anything shaped like a token or an id, cut to a length that fits a log line. */
export const scrub = (text: string) => text.replace(/[\w-]{20,}/g, "[cut]").slice(0, 200);

/**
 * Logs an exception: where it happened, `context`, and what Cloudflare says about it, as
 * `durableObjectReset` when it was the object's reset. A `SyntaxError` loses its message, since
 * `JSON.parse` quotes its input there. The stack keeps only its frames, since its first line
 * repeats the message.
 */
export function logError(where: string, context: Record<string, unknown>, error: unknown) {
  const { name, message, stack, remote, retryable, overloaded, durableObjectReset } = (error ??
    {}) as Partial<Error> & Record<"remote" | "retryable" | "overloaded" | "durableObjectReset", unknown>;
  console.error(
    JSON.stringify({
      event: "exception",
      where,
      ...context,
      name,
      message: name === "SyntaxError" ? undefined : scrub(message ?? String(error)),
      frames: stack
        ?.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("at "))
        .slice(0, 6),
      remote,
      retryable,
      overloaded,
      durableObjectReset,
    }),
  );
}

/** Runs a handler and logs what it throws before throwing it on, so its outcome doesn't change.
 *  `context` runs only then, since a stream's handler runs for every frame. */
export async function logged<T>(
  where: string,
  context: () => Record<string, unknown>,
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logError(where, context(), error);
    throw error;
  }
}
