import { Transform } from "node:stream";

/** Forward ordered bytes then EOF in each direction, preserving the opposite half-connection.
 * Both sockets must use allowHalfOpen. Only errors/abrupt closes abort the peer. */
export function delayDuplex(left, right, delayMs) {
  const delayed = () => new Transform({
    transform(chunk, _encoding, done) {
      setTimeout(() => done(null, chunk), delayMs);
    },
  });
  const forward = delayed(), backward = delayed();
  const abort = error => {
    forward.destroy(); backward.destroy();
    left.destroy(); right.destroy();
  };
  for (const stream of [left, right, forward, backward]) stream.on("error", abort);
  for (const socket of [left, right]) socket.on("close", () => {
    if (!socket.readableEnded) abort();
  });
  left.pipe(forward).pipe(right);
  right.pipe(backward).pipe(left);
}
