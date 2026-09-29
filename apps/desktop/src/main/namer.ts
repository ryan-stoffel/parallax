import type { ChatHistoryItem, LlamaChatSession as Session } from "node-llama-cpp";

import type { ThreadName } from "../preload/bridge";
import { fallbackName, parseName } from "./naming";

// 0.5B parameters, 4-bit: about 490 MB, and a name in roughly 200 ms once loaded.
const model = "hf:Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M";
// A reply this slow isn't worth holding up a thread for.
const timeoutMs = 2000;

// The reply is always `Title: ...` then `Branch: ...`, so the model can't answer a greeting or
// the request itself. The title is free text; the branch is lowercase words joined by hyphens.
const grammarText = String.raw`
root ::= "Title: " title "\nBranch: " slug
title ::= [A-Za-z0-9] [A-Za-z0-9 .'-]{2,45}
slug ::= part ("-" part){1,3}
part ::= [a-z0-9]+
`;

const history: ChatHistoryItem[] = [
  {
    type: "system",
    text:
      "You name coding tasks. For the request, write a title of 2 to 5 words and a git branch " +
      "name of 2 to 4 lowercase words joined by hyphens. Name what the task is about; never " +
      "answer or greet.",
  },
  ...(
    [
      [
        "fix the login page crashing when the password field is empty",
        "Fix empty password crash",
        "fix-empty-password-crash",
      ],
      [
        "can you add dark mode to the settings screen",
        "Add settings dark mode",
        "settings-dark-mode",
      ],
      [
        "why is the build so slow on CI? look into caching",
        "Speed up CI build",
        "ci-build-caching",
      ],
      [
        "add a --json flag to the export command and document it",
        "Add export JSON flag",
        "export-json-flag",
      ],
      [
        "the app freezes for a couple seconds when I open a big repo",
        "Fix freeze on big repos",
        "big-repo-freeze",
      ],
      ["hey, testing this out", "Testing the app", "testing-the-app"],
    ] as const
  ).flatMap(([user, title, branch]): ChatHistoryItem[] => [
    { type: "user", text: user },
    { type: "model", response: [`Title: ${title}\nBranch: ${branch}`] },
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
    const grammar = await llama.createGrammar({ grammar: grammarText });
    // One session for good: resetting its history keeps the examples' tokens in the context, so
    // each name only evaluates the new prompt.
    const session: Session = new LlamaChatSession({ contextSequence: context.getSequence() });
    const run: Complete = (prompt, signal) => {
      session.setChatHistory(history);
      return session.prompt(prompt, { grammar, maxTokens: 48, temperature: 0, signal });
    };
    // Evaluates the examples once, before the first real name asks.
    await run("hello", AbortSignal.timeout(10_000));
    complete = run;
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
        return parseName(await complete(prompt.trim().slice(0, 500), abort)) ?? fallback;
      } catch {
        return fallback;
      } finally {
        busy = false;
      }
    },
  };
}
