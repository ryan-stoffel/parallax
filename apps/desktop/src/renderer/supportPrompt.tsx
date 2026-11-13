import { t } from "i18next";

import { GitHubLogo, GitHubStarIcon, KoFiLogo } from "./logos";
import { notify } from "./notifications";

/** The sent prompt that brings up the ask to star and support Parallax. */
export const PROMPTS_BEFORE_ASK = 5;

// This key is new with the ask (PLX-1233), so the count starts at 0 on the first build that has it,
// whatever anyone sent before. It's read each time so that every window adds to the same count.
const KEY = "parallax.promptsBeforeSupportAsk";

/**
 * Call for each prompt sent. localStorage can forget the count: a second running copy, such as
 * Stable beside Nightly, gets an empty one it can't save, and a kill loses the last few seconds.
 * So the count only says when, and the claim in main says whether, which shows the ask once on a
 * computer (PLX-1243). Prompts past the ask claim too, for whoever saw it before the claim existed.
 */
export async function countSentPrompt() {
  const count = Number(localStorage.getItem(KEY)) || 0;
  if (count < PROMPTS_BEFORE_ASK) localStorage.setItem(KEY, String(count + 1));
  if (count + 1 < PROMPTS_BEFORE_ASK) return;
  const first = await window.parallax.claimSupportAsk();
  if (!first || count + 1 > PROMPTS_BEFORE_ASK) return;
  notify({
    tone: "info",
    title: t("Enjoying Parallax?"),
    body: t("A GitHub star helps people find it, and Ko-fi helps fund the work."),
    action: {
      label: t("Star on GitHub"),
      href: "https://github.com/ryan-stoffel/parallax",
      icon: (
        <>
          <GitHubLogo className="mr-0.5 size-3.5" />
          <GitHubStarIcon className="mr-0.5 size-3.5" />
        </>
      ),
    },
    secondLink: {
      label: t("Support on Ko-fi"),
      href: "https://ko-fi.com/parallax_team",
      icon: <KoFiLogo className="mr-0.5 size-3.5" />,
    },
    // It shows only once, so it stays until closed.
    sticky: true,
  });
}
