// The transcript's diffs' pure pieces: an edit call's lines, as the desktop's permission request
// draws them (diffLines.ts), one file's numbered lines out of a turn's unified diff (diffRows), and
// how many lines they add and remove. Pure, for the test.
import type { JsonValue } from "../../desktop/src/protocol/generated/protocol";
import { diffLines } from "../../desktop/src/renderer/diffLines";
import { field, isObject } from "../../desktop/src/renderer/transcript";
import { diffRows } from "./pullRequestLogic";

/** A line the diff view draws: a changed or unchanged one, numbered when known, or a band across it. */
export type DiffViewRow =
  | { kind: "add" | "del" | "context"; text: string; line?: number }
  | { kind: "band"; text: string };

const kinds = { "+": "add", "-": "del", " ": "context" } as const;

/** The lines from `before` to `after`, a run of far unchanged lines as one band. */
function lines(before: string, after: string): DiffViewRow[] {
  return diffLines(before, after).map((l) =>
    l.op === "gap"
      ? { kind: "band", text: `⋯ ${l.count} unchanged ${l.count === 1 ? "line" : "lines"}` }
      : { kind: kinds[l.op], text: l.text },
  );
}

/**
 * An Edit, MultiEdit, or Write call's change as diff lines, as the desktop's RequestPreview shows
 * it: a Write's content all added. Undefined for any other tool, or input cut for size.
 */
export function editRows(name: string | null, input?: JsonValue): DiffViewRow[] | undefined {
  if (!isObject(input) || input["truncated"] === true) return undefined;
  const change = (edit: JsonValue) => lines(field(edit, "old_string") ?? "", field(edit, "new_string") ?? "");
  switch (name) {
    case "Edit":
      return change(input);
    case "MultiEdit": {
      const edits = Array.isArray(input["edits"]) ? input["edits"] : [];
      return edits.flatMap((edit, i) => [...(i > 0 ? [{ kind: "band" as const, text: "⋯" }] : []), ...change(edit)]);
    }
    case "Write":
      return lines("", field(input, "content") ?? "");
  }
  return undefined;
}

/** File `path`'s lines in a unified diff, numbered, with its hunks' `@@` lines as bands. */
export function fileRows(diff: string, path: string): DiffViewRow[] {
  const out: DiffViewRow[] = [];
  let mine = false;
  for (const row of diffRows(diff))
    if (row.kind === "file") mine = row.path === path;
    else if (mine) out.push(row.kind === "hunk" ? { kind: "band", text: row.text } : row);
  return out;
}

/** How many lines `rows` add and remove. */
export const counts = (rows: readonly DiffViewRow[]) => ({
  added: rows.filter((r) => r.kind === "add").length,
  removed: rows.filter((r) => r.kind === "del").length,
});
