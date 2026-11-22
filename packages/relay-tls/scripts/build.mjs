// Builds crates/parallax-browser-tls for wasm32-unknown-unknown and runs wasm-bindgen into pkg/.
// ring's C needs clang with the wasm32 target and llvm-ar, which rustup's llvm-tools has (0108).
// WASM_BINDGEN names the wasm-bindgen CLI, which must match the crate's pinned version.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "../../..");
const sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: root, encoding: "utf8" }).trim();
const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { cwd: root, encoding: "utf8" }))[1];
const ar = path.join(sysroot, "lib/rustlib", host, "bin/llvm-ar");
if (!existsSync(ar)) throw new Error(`no llvm-ar at ${ar}: run rustup component add llvm-tools`);

execFileSync(
  "cargo",
  ["build", "-p", "parallax-browser-tls", "--target", "wasm32-unknown-unknown", "--profile", "wasm", "--locked"],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? "clang",
      AR_wasm32_unknown_unknown: ar,
    },
  },
);

const target = process.env.CARGO_TARGET_DIR ?? path.join(root, "target");
execFileSync(
  process.env.WASM_BINDGEN ?? "wasm-bindgen",
  [
    "--target",
    "web",
    "--out-dir",
    path.join(import.meta.dirname, "../pkg"),
    path.join(target, "wasm32-unknown-unknown/wasm/parallax_browser_tls.wasm"),
  ],
  { stdio: "inherit" },
);
