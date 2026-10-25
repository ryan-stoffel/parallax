// plxd runs this with the device hub's options (PLX-886). With `--ios-port <port>`, it first serves
// upstream serve-sim's middleware at /serve-sim on that loopback port for the Mac's simulators
// (PLX-988). It then starts Expo's hub as its own CLI would, and exits once its stdin ends: plxd
// holds that pipe open, so its end means plxd is gone, even if it was killed before it could stop
// the hub.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const cli = new URL("../node_modules/expo-device-hub/dist/server/cli.mjs", import.meta.url);

process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();

const at = process.argv.indexOf("--ios-port");
if (at !== -1) {
  const port = Number(process.argv[at + 1]);
  process.argv.splice(at, 2);
  const { simMiddleware } = await import("serve-sim/middleware");
  const sim = simMiddleware({ basePath: "/serve-sim" });
  const server = createServer(async (req, res) => {
    try {
      await sim(req, res, () => {
        res.writeHead(404);
        res.end();
      });
    } catch {
      // A failed request answers 500 rather than stopping the sidecar, Android's streams with it.
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => sim.handleUpgrade(req, socket, head));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  sim.setServerPort(port);
}

process.argv = [process.argv[0], fileURLToPath(cli), ...process.argv.slice(2)];
await import(cli.href);
