import { generateKeyPairSync } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A local Clerk: tests sign session tokens with this key, and the relay checks them against its
// JWKS instead of fetching Clerk's.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "test";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          // Two instances, as while accounts move to production (PLX-1049): tokens are this
          // test's, and the development instance's for the tests of keeping them apart.
          CLERK_ISSUER: "https://clerk.test,https://adjusted-mastodon-8705.clerk.accounts.dev",
          CLERK_CLIENT_IDS: "mp9Q72aAbB0LC83O,SXDueyOLOJ2v4Vmq",
          CLERK_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" }] }),
          TEST_CLERK_KEY: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid }),
          // Production turns spare placement on (PLX-1544). Tests keep it off, and the placement
          // tests turn it on themselves.
          SPARE_PLACEMENT_TRIES: "0",
        },
      },
    }),
  ],
});
