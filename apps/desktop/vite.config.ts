import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";
import type { PackUserConfig } from "vite-plus/pack";

// The renderer's Content Security Policy, set as a <meta> tag because the
// built app loads from file://, where response headers can't carry one.
// Inline styles are allowed: xterm.js (SignInTerminal) sizes and colors its
// rows with <style> tags it writes, as Vite's dev server does. Scripts stay
// 'self', except for React Refresh's inline preamble in dev. The dev server's
// HMR websocket is same-origin, so 'self'.
const csp = (dev: boolean) =>
  [
    "default-src 'self'",
    dev && "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
  ]
    .filter(Boolean)
    .join("; ");

const cspMeta: Plugin = {
  name: "wisp-csp",
  transformIndexHtml: (_html, ctx) => [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: csp(ctx.server !== undefined) },
      injectTo: "head-prepend",
    },
  ],
};

// Main and preload are separate CommonJS bundles: a sandboxed preload must be
// one self-contained file. Every dependency is inlined except Electron itself,
// node-pty, and node-llama-cpp, whose native binaries can't be, so the packaged
// app needs only their folders from node_modules (RYA-66, RYA-152).
const external = ["electron", "node-pty", "node-llama-cpp"];
const electronBundle = (name: "main" | "preload"): PackUserConfig => ({
  entry: { [name]: `src/${name}/${name}.ts` },
  outDir: `dist/${name}`,
  format: "cjs",
  platform: "node",
  sourcemap: true,
  deps: {
    neverBundle: external,
    alwaysBundle: (id) => !external.includes(id) && !id.startsWith("node:"),
  },
});

export default defineConfig({
  // Renderer (`vp dev`, `vp build`).
  root: "src/renderer",
  base: "./",
  plugins: [react(), tailwindcss(), cspMeta],
  build: { outDir: "../../dist/renderer", emptyOutDir: true },

  // Main process and preload (`vp pack`).
  pack: [electronBundle("main"), electronBundle("preload")],

  // `vp check`. Oxlint and Oxfmt skip what .gitignore lists. The generated
  // protocol types keep the generator's formatting, but are still linted and
  // type-checked.
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: { ignorePatterns: ["src/protocol/generated/**"] },
  test: {
    root: ".",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
});
