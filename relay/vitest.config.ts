import { generateKeyPairSync } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A local Clerk: tests sign session tokens with this key, and the relay checks them against its
// JWKS instead of fetching Clerk's.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "test";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          CLERK_ISSUER: "https://clerk.test",
          CLERK_CLIENT_IDS: "SXDueyOLOJ2v4Vmq",
          CLERK_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" }] }),
          TEST_CLERK_KEY: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }),
        },
      },
    }),
  ],
});
