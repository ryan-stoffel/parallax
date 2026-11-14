import { createRequire } from "node:module";

import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    // English, so tests read the strings as the code writes them (apps/desktop/src/i18n).
    setupFiles: ["./src/i18nTestSetup.ts"],
  },
  resolve: {
    // One i18next for the phone's files and the desktop's it shares, as Metro resolves them.
    alias: { i18next: require.resolve("i18next"), "react-i18next": require.resolve("react-i18next") },
  },
});
