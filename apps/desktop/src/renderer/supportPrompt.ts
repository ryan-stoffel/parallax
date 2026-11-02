import { notify } from "./notifications";

/** The sent prompt that brings up the ask to star and support Parallax. */
export const PROMPTS_BEFORE_ASK = 5;

// This key is new with the ask (PLX-1233), so the count starts at 0 on the first build that has it,
// whatever anyone sent before. It's read each time so that every window adds to the same count.
const KEY = "parallax.promptsBeforeSupportAsk";

/** Call for each prompt sent. The count stops at the ask, so the ask shows once on a computer. */
export function countSentPrompt() {
  const count = Number(localStorage.getItem(KEY)) || 0;
  if (count >= PROMPTS_BEFORE_ASK) return;
  localStorage.setItem(KEY, String(count + 1));
  if (count + 1 < PROMPTS_BEFORE_ASK) return;
  notify({
    tone: "info",
    title: "Enjoying Parallax?",
    body: "A GitHub star helps people find it, and Ko-fi helps fund the work.",
    action: { label: "Star on GitHub", href: "https://github.com/ryan-stoffel/parallax" },
    secondLink: { label: "Support on Ko-fi", href: "https://ko-fi.com/parallax_team" },
    // It shows only once, so it stays until closed.
    sticky: true,
  });
}
