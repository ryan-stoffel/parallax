// plxd runs this with the device hub's options (PLX-886). It starts Expo's hub as its own CLI
// would, and exits once its stdin ends: plxd holds that pipe open, so its end means plxd is gone,
// even if it was killed before it could stop the hub.

import { fileURLToPath } from "node:url";

const cli = new URL("../node_modules/expo-device-hub/dist/server/cli.mjs", import.meta.url);

process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
process.argv = [process.argv[0], fileURLToPath(cli), ...process.argv.slice(2)];
await import(cli.href);
