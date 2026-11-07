import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export default defineConfig({ test: { include: ["proof/*.test.ts"] }, plugins: [cloudflareTest({
  wrangler: { configPath: "./proof.toml" }, miniflare: { bindings: {
    CLERK_ISSUER: "https://clerk.test", CLERK_CLIENT_IDS: "mp9Q72aAbB0LC83O",
    CLERK_JWKS: JSON.stringify({keys:[{...publicKey.export({format:"jwk"}),kid:"test",alg:"RS256"}]}),
    TEST_CLERK_KEY: JSON.stringify({...privateKey.export({format:"jwk"}),kid:"test"}),
  } },
})] });
