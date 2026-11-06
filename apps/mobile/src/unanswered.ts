// The message Edit can take back, by the desktop pencil's rule (AgentChat.tsx's `unanswered`): the
// latest message, the user's own, while the run goes and nothing from the agent follows it. Pure,
// for the test.
import { withoutImages } from "../../desktop/src/renderer/attachments";
import type { Item } from "../../desktop/src/renderer/transcript";

/** Rows that can follow a message the agent hasn't answered. */
const quiet = ["notice", "end", "session", "modelSwitch"];

/**
 * The latest message's row key and text without its images' paths, when the agent hasn't answered
 * it yet. `sent` has the text of messages sent from here, which older logs hold only by turn id.
 */
export function unansweredOf(
  items: readonly Item[],
  sent: ReadonlyMap<string, { text: string }>,
): { key: string; text: string } | undefined {
  const at = items.findLastIndex((i) => i.kind === "user");
  const row = items[at];
  // Parallax's wake-ups and other threads' messages aren't the user's to edit.
  if (row?.kind !== "user" || row.wake || row.from !== undefined) return undefined;
  if (!items.slice(at + 1).every((i) => quiet.includes(i.kind))) return undefined;
  const said = row.text ?? (row.turnId ? sent.get(row.turnId)?.text : undefined);
  return said == null ? undefined : { key: row.key, text: withoutImages(said) };
}
