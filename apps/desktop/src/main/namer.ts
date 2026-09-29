import type { ChatHistoryItem, LlamaChatSession as Session } from "node-llama-cpp";

import type { ThreadName } from "../preload/bridge";
import { cleanTitle, fallbackName, slugify } from "./naming";

// 0.5B parameters, 4-bit: about 490 MB, and a name in roughly 100 ms once loaded.
const model = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";
// A reply this slow isn't worth holding up a thread for.
const timeoutMs = 2000;

const history: ChatHistoryItem[] = [
  {
    type: "system",
    text:
      "You write short titles for coding tasks. Given a request, reply with only a title of " +
      "2 to 5 words that names the task. Do not answer the request.",
  },
  ...(
    [
      ["fix the login page crashing when the password field is empty", "Fix empty password crash"],
      ["can you add dark mode to the settings screen", "Add settings dark mode"],
      ["why is the build so slow on CI? look into caching", "Speed up CI build"],
    ] as const
  ).flatMap(([user, reply]): ChatHistoryItem[] => [
    { type: "user", text: user },
    { type: "model", response: [reply] },
  ]),
];

type Complete = (prompt: string, signal: AbortSignal) => Promise<string>;

/**
 * Names threads with a small model that runs on this computer. `warm` downloads it (once, into
 * `modelDir`) and loads it in the background. Until it's ready, or when it fails, `name` answers
 * from the prompt's words at once, so a start never waits on the model's download or load.
 */
export function createNamer(modelDir: string) {
  let complete: Complete | undefined;
  let busy = false;
  let started = false;

  // ponytail: a failed download or load stays failed until the app restarts.
  async function load() {
    const { getLlama, LlamaChatSession, resolveModelFile } = await import("node-llama-cpp");
    const llama = await getLlama({ progressLogs: false });
    const loaded = await llama.loadModel({
      modelPath: await resolveModelFile(model, { directory: modelDir, cli: false }),
    });
    const context = await loaded.createContext({ contextSize: 1024 });
    complete = async (prompt, signal) => {
      const sequence = context.getSequence();
      const session: Session = new LlamaChatSession({ contextSequence: sequence });
      try {
        session.setChatHistory(history);
        return await session.prompt(prompt, { maxTokens: 16, temperature: 0, signal });
      } finally {
        session.dispose();
        await sequence.dispose();
      }
    };
  }

  return {
    warm() {
      if (started) return;
      started = true;
      load().catch((error: unknown) => console.warn("thread namer unavailable:", error));
    },

    async name(prompt: string): Promise<ThreadName> {
      const fallback = fallbackName(prompt);
      // One name at a time: the context has one sequence.
      if (!complete || busy) return fallback;
      busy = true;
      try {
        const abort = AbortSignal.timeout(timeoutMs);
        const title = cleanTitle(await complete(prompt.trim().slice(0, 500), abort));
        return title ? { title, slug: slugify(title) ?? fallback.slug } : fallback;
      } catch {
        return fallback;
      } finally {
        busy = false;
      }
    },
  };
}
