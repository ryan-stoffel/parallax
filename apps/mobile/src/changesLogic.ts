// A thread's Changes sheet's pure pieces (0062): the turns it can show, as the desktop's
// ChangesPanel lists them, and a diff's files as the list's rows. Pure, for the test.
import { t } from "i18next";

import type { ThreadRun } from "../../desktop/src/protocol/generated/protocol";
import type { DiffFile, DiffLine } from "../../desktop/src/renderer/parseDiff";
import type { Choice } from "./Choices";
import type { DiffRow } from "./pullRequestLogic";

/** The longest a turn's line runs in its choice, so one long prompt doesn't fill the sheet. */
const longestTitle = 120;

/** The longest a diff's line runs, as one minified line can stall the phone's text layout. */
const longestLine = 2000;

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}…` : text);

/**
 * The turns a thread's changes can show, oldest first: those that started, weren't undone, and
 * have a ready checkpoint. `value` is the turn's ordinal, and `description` its message's first
 * line, `prompt` for the first turn, whose message plxd keeps with the thread.
 */
export function turnChoices(runs: readonly ThreadRun[], prompt: string): (Choice<string> & { ordinal: number })[] {
  const started = runs.filter((r) => r.ordinal !== undefined && r.status !== "rolledBack");
  return started
    .filter((r) => r.checkpoint?.status === "ready")
    .map((r) => {
      const line = (r.text ?? (r === started[0] ? prompt : "")).trim().split("\n")[0] ?? "";
      return {
        ordinal: r.ordinal!,
        value: String(r.ordinal),
        label: t("Turn {{ordinal}}", { ordinal: r.ordinal }),
        description: cut(line, longestTitle) || t("(no text)"),
      };
    });
}

/** A row of the changes list: a file's header, a line of its diff, or why it has no lines. */
export type ChangeRow = { key: string } & (
  | { kind: "file"; file: DiffFile; open: boolean }
  | { kind: "line"; row: DiffRow }
  | { kind: "note"; text: string }
);

const kinds = { "+": "add", "-": "del", " ": "context" } as const;

/** A parsed line as a row `DiffLine` draws, numbered on the new side, or the old for a removed one. */
function lineRow(line: DiffLine): DiffRow {
  const text = cut(line.text, longestLine);
  return line.op === "@"
    ? { kind: "hunk", text }
    : { kind: kinds[line.op], text, line: (line.op === "-" ? line.old : line.new)! };
}

/** `files` as the list's rows: every file's header, and its lines unless it's in `folded`. */
export function changeRows(files: readonly DiffFile[], folded: ReadonlySet<string>): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const file of files) {
    const open = !folded.has(file.path);
    rows.push({ key: file.path, kind: "file", file, open });
    if (!open) continue;
    if (file.lines.length === 0)
      rows.push({ key: `${file.path}\nnote`, kind: "note", text: file.binary ? t("Binary file not shown") : t("No text changes") });
    file.lines.forEach((line, i) => rows.push({ key: `${file.path}\n${i}`, kind: "line", row: lineRow(line) }));
  }
  return rows;
}
