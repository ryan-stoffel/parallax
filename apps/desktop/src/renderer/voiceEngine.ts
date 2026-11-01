import { createWhistle, type Whistle } from "cactus-needle/browser";

/** Bundled, checksum-verified weights and a local WASM worker. No runtime download or API key. */
export async function loadVoiceEngine(signal: AbortSignal): Promise<Whistle> {
  const response = await fetch(new URL("./voice-assets/whistle.cact", import.meta.url), { signal });
  if (!response.ok)
    throw new Error("The bundled voice model could not be loaded. Reinstall Parallax.");
  const model = await response.arrayBuffer();
  signal.throwIfAborted();
  // Byte input avoids the wrapper's HTTP-only URL validation on Electron's secure app:// origin.
  return createWhistle({
    model,
    modelSha256: "b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb",
    cache: false,
    abortSignal: signal,
  });
}
