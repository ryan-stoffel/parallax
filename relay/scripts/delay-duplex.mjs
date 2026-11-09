/** Forward each chunk `delayMs` after it arrives, in order, then EOF `delayMs` after the end, in
 * each direction, preserving the opposite half-connection. Chunks don't queue behind each other's
 * delay, so the delay is added latency, not a per-chunk cost. Both sockets must use allowHalfOpen.
 * Only errors/abrupt closes abort the peer. */
export function delayDuplex(left, right, delayMs) {
  const abort = () => {
    left.destroy(); right.destroy();
  };
  // Timers of one duration fire in the order they were set, so bytes keep their order.
  const forward = (from, to) => {
    from.on("data", chunk => setTimeout(() => to.write(chunk), delayMs));
    from.on("end", () => setTimeout(() => to.end(), delayMs));
  };
  forward(left, right);
  forward(right, left);
  for (const socket of [left, right]) {
    socket.on("error", abort);
    socket.on("close", () => {
      if (!socket.readableEnded) abort();
    });
  }
}
