import { GitCompare, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ThreadRun } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { DiffFileView, parseDiff } from "./PullRequests";
import { ConfirmDialog } from "./ui";

/** A diff as plxd sent it, or why it couldn't. */
type Shown = { diff: string; truncated?: boolean } | { error: string };

/** The turns the view lists: those that started and weren't undone, oldest first. */
const turnsOf = (runs: ThreadRun[]) =>
  runs.filter((r) => r.ordinal !== undefined && r.status !== "rolledBack");

const ready = (r: ThreadRun) => r.checkpoint?.status === "ready";

/**
 * The side panel's Changes view (0062): the open thread's diff across every turn, or one turn's,
 * from the checkpoints plxd captures as each turn ends. A turn's Edit from here reverts the thread
 * to before it, as T3 Code's does, keeping or restoring its files, and puts its message back in
 * the composer through `onCompose`. `prompt` is the first turn's message, which plxd keeps with
 * the thread. `version` changes when a checkpoint is captured or the thread reverted, which reloads
 * the turns. `unavailable` says why it can't load, such as a plxd without `checkpoints`.
 */
export function ChangesPanel({
  hostId,
  runId,
  prompt,
  version,
  unavailable,
  onCompose,
}: {
  hostId: string;
  runId: string;
  prompt: string;
  version?: number;
  unavailable?: string;
  onCompose: (text: string) => void;
}) {
  const [runs, setRuns] = useState<ThreadRun[] | { error: string }>();
  // The turn shown by its ordinal, or every turn.
  const [shownTurn, setShownTurn] = useState<number | "all">("all");
  const [shown, setShown] = useState<Shown>();
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);

  const load = async () => {
    const answer = await window.parallax.request(hostId, "orchestration/threadRuns", {
      threadId: runId,
    });
    setRuns("error" in answer ? { error: describeError(answer.error) } : answer.result.runs);
  };
  useEffect(() => {
    if (!unavailable) void load();
    // `load` reads only these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, runId, version, unavailable]);

  const turns = Array.isArray(runs) ? turnsOf(runs) : [];
  const latest = turns.findLast(ready)?.ordinal;
  const turn = shownTurn === "all" ? undefined : turns.find((t) => t.ordinal === shownTurn);
  // A turn a revert undid falls back to every turn.
  const ordinal = turn && ready(turn) ? turn.ordinal! : undefined;

  useEffect(() => {
    if (latest === undefined) return setShown(undefined);
    let stale = false;
    const answer =
      ordinal === undefined
        ? window.parallax.request(hostId, "orchestration/getFullThreadDiff", {
            threadId: runId,
            to: latest,
          })
        : window.parallax.request(hostId, "orchestration/getTurnDiff", {
            threadId: runId,
            from: ordinal - 1,
            to: ordinal,
          });
    void answer.then((a) => {
      if (!stale) setShown("error" in a ? { error: describeError(a.error) } : a.result);
    });
    return () => {
      stale = true;
    };
  }, [hostId, runId, latest, ordinal]);

  if (unavailable) return <Empty title="Changes aren't available" hint={unavailable} />;
  if (runs && "error" in runs) return <Empty title="Couldn't load the changes" hint={runs.error} />;
  if (runs && latest === undefined)
    return <Empty title="No changes yet" hint="Edits from this thread show up here for review." />;

  // Edit from here goes back to the turn before this one, or the thread's start.
  const editFromHere = async (restoreFiles: boolean) => {
    if (!turn) return;
    const before = turns[turns.indexOf(turn) - 1]?.ordinal ?? 0;
    setReverting(true);
    setRevertError(undefined);
    const answer = await window.parallax.request(hostId, "orchestration/dispatch", {
      type: "checkpoint.rollback",
      threadId: runId,
      ordinal: before,
      ...(restoreFiles && { restoreFiles }),
    });
    setReverting(false);
    if ("error" in answer) return setRevertError(describeError(answer.error));
    dialog.current?.close();
    setShownTurn("all");
    onCompose(turn.text ?? (turns.indexOf(turn) === 0 ? prompt : ""));
    void load();
  };

  const files = shown && "diff" in shown ? parseDiff(shown.diff) : [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <select
          aria-label="Turn"
          value={ordinal ?? "all"}
          onChange={(e) => setShownTurn(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="min-w-0 flex-1 truncate rounded-md bg-transparent py-1 text-[13px] hover:bg-hover"
        >
          <option value="all">All turns</option>
          {turns.filter(ready).map((t, i) => (
            <option key={t.id} value={t.ordinal}>
              Turn {i + 1}: {firstLine(t.text ?? (t === turns[0] ? prompt : "")) || "(no text)"}
            </option>
          ))}
        </select>
        {turn && (
          <button
            type="button"
            onClick={() => {
              setRevertError(undefined);
              dialog.current?.showModal();
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            <Undo2 aria-hidden className="size-3.5" />
            Edit from here
          </button>
        )}
      </div>
      {shown && "error" in shown && (
        <p role="alert" className="px-3 py-2 text-[12.5px] text-danger">
          {shown.error}
        </p>
      )}
      {shown && "diff" in shown && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="px-3 py-2 text-[12.5px] text-muted-foreground">
            {files.length === 0 ? (
              "No files changed."
            ) : (
              <>
                {files.length} {files.length === 1 ? "file" : "files"} changed{" "}
                <span className="font-mono text-added">+{added}</span>{" "}
                <span className="font-mono text-danger">−{removed}</span>
              </>
            )}
            {shown.truncated && " · cut at 10 MB"}
          </p>
          <ul className="border-t border-border">
            {files.map((file) => (
              <DiffFileView key={file.path} file={file} />
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        ref={dialog}
        title="Edit from here?"
        action="Revert files too"
        busy={reverting ? "Reverting…" : undefined}
        error={revertError}
        onConfirm={() => void editFromHere(true)}
        alternate={{ action: "Revert and keep changes", onConfirm: () => void editFromHere(false) }}
      >
        Rewind chat to before this message. Your prompt returns to the composer.
      </ConfirmDialog>
    </div>
  );
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-16 text-center">
      <GitCompare aria-hidden className="mb-1 size-5 text-faint-foreground" />
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="text-[12.5px] text-muted-foreground">{hint}</p>
    </div>
  );
}
