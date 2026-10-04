// The browser preview of the renderer (README.md): the app's own Vite plugins, rooted here, with
// no Content Security Policy, and everything inlined so inline.mjs can make one HTML file.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite-plus";

const root = fileURLToPath(new URL(".", import.meta.url));
const desktop = fileURLToPath(new URL("..", import.meta.url));

// Tailwind finds class names under Vite's root, which here holds only the preview. Its plugins see
// apps/desktop as the root instead, so the renderer's classes are found as in the app's build.
function tailwindFromDesktop(): Plugin[] {
  return tailwindcss().map((plugin) => {
    const hook = plugin.configResolved;
    if (typeof hook !== "function") return plugin;
    return {
      ...plugin,
      configResolved(config) {
        const view = new Proxy(config, {
          get: (target, key, receiver) =>
            key === "root" ? desktop : Reflect.get(target, key, receiver),
        });
        return hook.call(this, view);
      },
    };
  });
}

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), tailwindFromDesktop()],
  server: { port: 5199, fs: { allow: [desktop] } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts and images as data: URLs, and one CSS file, for single.html.
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 10_000,
    // The renderer's lazy imports (the terminal) go in the one script too.
    rolldownOptions: { output: { inlineDynamicImports: true } },
  },
});
