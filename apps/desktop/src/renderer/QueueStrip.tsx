import {
  ArrowDown,
  ArrowUp,
  CornerUpRight,
  GripVertical,
  Image,
  Link,
  Pencil,
  X,
} from "lucide-react";
import { useState } from "react";

import type { QueuedMessage } from "../protocol/generated/protocol";

const action =
  "grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-40 [&_svg]:size-3.5";

/** The host's next messages, editable until plxd delivers them. Changes arrive through queue.updated. */
export function QueueStrip({
  hostId,
  runId,
  messages,
  running,
  disabledReason,
  loadError,
}: {
  hostId: string;
  runId: string;
  messages: QueuedMessage[];
  running: boolean;
  disabledReason?: string;
  loadError?: string;
}) {
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = busy || !!disabledReason;

  async function change(
    method: "queue/edit" | "queue/cancel" | "queue/steer" | "queue/reorder",
    message?: QueuedMessage,
    ids?: string[],
  ) {
    if (disabled) return;
    setBusy(true);
    setError(undefined);
    const answer =
      method === "queue/reorder"
        ? await window.parallax.request(hostId, method, { runId, ids: ids! })
        : method === "queue/edit"
          ? await window.parallax.request(hostId, method, { runId, id: message!.id, text })
          : await window.parallax.request(hostId, method, { runId, id: message!.id });
    setBusy(false);
    if ("error" in answer) setError(answer.error.message);
    else setEditing(undefined);
  }

  function move(id: string, to: number) {
    const ids = messages.map((m) => m.id);
    const from = ids.indexOf(id);
    if (from < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void change("queue/reorder", undefined, ids);
  }

  if (!messages.length && !loadError && !error) return null;
  return (
    <section
      aria-label="Queued messages"
      className="mb-2 overflow-hidden rounded-xl border border-border bg-surface text-[12.5px]"
    >
      <div className="flex items-center justify-between px-3 py-2 text-faint-foreground">
        <span>
          Queued{" "}
          <span className="ml-1 rounded bg-hover px-1.5 text-foreground">{messages.length}</span>
        </span>
        <span>Next turn</span>
      </div>
      <ol className="max-h-48 overflow-y-auto">
        {messages.map((m, index) => (
          <li
            key={m.id}
            className="border-t border-border px-2 py-1.5"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-parallax-queue")) e.preventDefault();
            }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("application/x-parallax-queue");
              if (id) {
                e.preventDefault();
                move(id, index);
              }
            }}
          >
            {editing === m.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void change("queue/edit", m);
                }}
                className="space-y-1.5 px-1"
              >
                <textarea
                  autoFocus
                  aria-label="Edit queued message"
                  value={text}
                  disabled={disabled}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(undefined);
                    }
                  }}
                  className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-foreground outline-none focus:border-accent"
                  rows={3}
                />
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setEditing(undefined)}
                    className="text-muted-foreground"
                  >
                    Discard edit
                  </button>
                  <button
                    type="submit"
                    disabled={disabled || (!text.trim() && !m.images)}
                    className="font-medium text-foreground disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={`${action} cursor-grab`}
                  disabled={disabled}
                  draggable={!disabled}
                  aria-label={`Drag queued message ${index + 1}`}
                  title="Drag to reorder"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-parallax-queue", m.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <GripVertical aria-hidden />
                </button>
                <span className="min-w-0 flex-1 truncate" title={m.text}>
                  {m.text || "Image message"}
                </span>
                {m.images > 0 && (
                  <span
                    aria-label={`${m.images} images attached`}
                    className="flex items-center gap-1 text-faint-foreground"
                  >
                    <Image aria-hidden className="size-3" />
                    {m.images}
                  </span>
                )}
                {m.threads.length > 0 && (
                  <span
                    aria-label={`${m.threads.length} threads attached`}
                    className="flex items-center gap-1 text-faint-foreground"
                  >
                    <Link aria-hidden className="size-3" />
                    {m.threads.length}
                  </span>
                )}
                <button
                  type="button"
                  className={action}
                  disabled={disabled || index === 0}
                  aria-label={`Move queued message ${index + 1} up`}
                  onClick={() => move(m.id, index - 1)}
                >
                  <ArrowUp aria-hidden />
                </button>
                <button
                  type="button"
                  className={action}
                  disabled={disabled || index === messages.length - 1}
                  aria-label={`Move queued message ${index + 1} down`}
                  onClick={() => move(m.id, index + 1)}
                >
                  <ArrowDown aria-hidden />
                </button>
                <button
                  type="button"
                  className={action}
                  disabled={disabled}
                  aria-label={`Edit queued message ${index + 1}`}
                  onClick={() => {
                    setEditing(m.id);
                    setText(m.text);
                  }}
                >
                  <Pencil aria-hidden />
                </button>
                <button
                  type="button"
                  className={action}
                  disabled={disabled || !running}
                  aria-label={`Steer queued message ${index + 1} now`}
                  title="Steer now"
                  onClick={() => void change("queue/steer", m)}
                >
                  <CornerUpRight aria-hidden />
                </button>
                <button
                  type="button"
                  className={action}
                  disabled={disabled}
                  aria-label={`Cancel queued message ${index + 1}`}
                  onClick={() => void change("queue/cancel", m)}
                >
                  <X aria-hidden />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {(error || loadError) && (
        <p role="alert" className="px-3 py-2 text-danger">
          {error || loadError}
        </p>
      )}
    </section>
  );
}
