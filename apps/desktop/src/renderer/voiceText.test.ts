import { expect, test, vi } from "vite-plus/test";
import type { ParallaxBridge } from "../preload/bridge";
import { setBehaviorPrefs } from "./prefs";
import { cleanDictation, voiceText } from "./voiceText";
test("dictation separates adjacent draft words and preserves whitespace", () => {
  expect(voiceText("world", "o", "")).toBe(" world");
  expect(voiceText("new", " ", " ")).toBe("new");
  expect(voiceText("new", "a", "b")).toBe(" new ");
  expect(voiceText("world", "\n", "")).toBe("world");
  expect(voiceText("**literal**", "", "")).toBe("**literal**");
});
test("dictation is cleaned up only when that's on, and goes in raw when plxd can't", async () => {
  const where = { backend: "claude", repo: "r", runId: "run" };
  const request = vi.fn(async () => ({ logId: "l", result: { text: "Hello." } }));
  vi.stubGlobal("window", { parallax: { request } as unknown as ParallaxBridge });
  expect(await cleanDictation("um hello", "local", where)).toBe("Hello.");
  expect(request).toHaveBeenCalledWith("local", "voice/clean", {
    text: "um hello",
    backend: "claude",
    runId: "run",
  });
  request.mockResolvedValueOnce({ error: { code: -32601, message: "no method" } } as never);
  expect(await cleanDictation("um hello", "local", where)).toBe("um hello");
  request.mockClear();
  setBehaviorPrefs({ cleanDictation: false });
  expect(await cleanDictation("um hello", "local", where)).toBe("um hello");
  expect(request).not.toHaveBeenCalled();
  setBehaviorPrefs({ cleanDictation: true });
  vi.unstubAllGlobals();
});
