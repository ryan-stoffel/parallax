// Fails when the browser's TLS module passes 200 KB gzipped (0108 measured 186 KB). A page
// downloads it before it can reach any computer.

import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const LIMIT = 200_000;

const wasm = readFileSync(path.join(import.meta.dirname, "../pkg/parallax_browser_tls_bg.wasm"));
const gzipped = gzipSync(wasm, { level: 9 }).length;
console.log(`parallax_browser_tls_bg.wasm: ${wasm.length} bytes, ${gzipped} gzipped (limit ${LIMIT})`);
if (gzipped > LIMIT) {
  console.error(`The module is ${gzipped - LIMIT} bytes over the ${LIMIT} byte gzipped limit.`);
  process.exit(1);
}
