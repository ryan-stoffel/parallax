// Pin and verify the offline Whistle model. The JS package pins/verifies its own WASM engine.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const model = new URL("../src/renderer/voice-assets/whistle.cact", import.meta.url);
export const modelSha256 = "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb";
const modelUrl =
  "https://huggingface.co/Cactus-Compute/whistle/resolve/741118687e1f008f06d1351a402a731274789790/whistle.cact";
// Seconds to wait before each retry, so a Hugging Face outage of about a minute doesn't fail CI.
const retryDelays = [5, 15, 40];
// Milliseconds one try may take, body included, so a stalled connection is retried.
const tryTimeout = 60_000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// fetch's errors, such as "fetch failed" or "terminated", keep the reason in their cause.
const describe = (error) =>
  error.cause ? `${error.message}: ${error.cause.message}` : error.message;

// Downloads the model and checks its size and SHA-256. Any failure, from the request, the body,
// the timeout or the check, is retried.
async function downloadModel() {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(modelUrl, { signal: AbortSignal.timeout(tryTimeout) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== 16919407 || hash(bytes) !== modelSha256)
        throw new Error("checksum mismatch");
      return bytes;
    } catch (error) {
      const reason = describe(error);
      if (attempt === retryDelays.length)
        throw new Error(`Whistle download failed after ${attempt + 1} tries: ${reason}`, {
          cause: error,
        });
      console.warn(`Whistle download failed: ${reason}. Retrying in ${retryDelays[attempt]}s.`);
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt] * 1000));
    }
  }
}

export async function prepareVoice() {
  if (!existsSync(model) || hash(readFileSync(model)) !== modelSha256) {
    const bytes = await downloadModel();
    mkdirSync(new URL("../src/renderer/voice-assets/", import.meta.url), { recursive: true });
    writeFileSync(model, bytes);
  }
  if (process.platform === "darwin") {
    const source = new URL("../native/fn-key.mm", import.meta.url);
    const output = new URL("../native/fn-key.node", import.meta.url);
    const stamp = new URL("../native/fn-key.sha256", import.meta.url);
    const fingerprint = hash(readFileSync(source));
    if (!existsSync(output) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== fingerprint) {
      const built = spawnSync(
        "xcrun",
        [
          "clang++",
          "-std=c++17",
          "-bundle",
          "-undefined",
          "dynamic_lookup",
          "-fobjc-arc",
          "-mmacosx-version-min=12.0",
          "-I",
          require("node-api-headers").include_dir,
          "-framework",
          "AppKit",
          fileURLToPath(source),
          "-o",
          fileURLToPath(output),
        ],
        { cwd: root, stdio: "inherit" },
      );
      if (built.status !== 0) throw new Error("Could not build the native Fn key monitor");
      writeFileSync(stamp, fingerprint);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareVoice();
