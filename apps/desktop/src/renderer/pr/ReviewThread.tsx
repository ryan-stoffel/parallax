import { useEffect, useState } from "react";

import { icons } from "../icons";
import { useSticky } from "../sticky";
import { Badge, Button, IconButton } from "../ui";
import { GithubMarkdown } from "./GithubMarkdown";
import type { ThreadView } from "./model";
import { Suggestion, type SuggestionActions, SuggestionButtons } from "./Suggestion";
import { linesUnderThread, splitSuggestions } from "./suggestions";
import { ago, Avatar } from "./parts";

/**
 * A review thread: its file and lines, Outdated or Resolved, each comment, and, where plxd writes
 * (`pr/write`), a reply box with Reply and Resolve. A write resolves to whether it worked, and the
 * box keeps its text until it does. A comment in the viewer's pending review says so, with Edit and
 * Delete, and a thread of only those takes no reply yet. In the Files tab it sits under its line,
 * `bare` of its file.
 */
export function ReviewThread({
  thread,
  repo,
  bare,
  onOpen,
  onReply,
  onResolve,
  onEdit,
  onDelete,
  suggestions,
}: {
  thread: ThreadView;
  repo: string;
  /** Leaves out its path, as under its line in a diff. */
  bare?: boolean;
  onOpen: (url: string) => void;
  onReply?: (body: string) => Promise<boolean>;
  onResolve?: () => Promise<boolean>;
  onEdit?: (commentId: string, body: string) => Promise<boolean>;
  onDelete?: (commentId: string) => Promise<boolean>;
  suggestions?: SuggestionActions;
}) {
  const [reply, setReply] = useSticky(`prReply/${thread.id ?? thread.url}`, "");
  const [replying, setReplying] = useState(false);
  const [open, setOpen] = useState(!thread.resolved);
  useEffect(() => setOpen(!thread.resolved), [thread.resolved]);
  const [sending, setSending] = useState<"reply" | "resolve">();
  const send = async (what: "reply" | "resolve") => {
    setSending(what);
    const ok = what === "reply" ? await onReply!(reply.trim()) : await onResolve!();
    setSending(undefined);
    if (ok && what === "reply") {
      setReply("");
      setReplying(false);
    }
  };
  const lines = thread.startLine ? `${thread.startLine}-${thread.line}` : thread.line;
  const where = thread.path && `${thread.path}${lines ? `:${lines}` : ""}`;
  const span = thread.startLine && `Lines ${thread.startLine} to ${thread.line}`;
  const canAct = (onReply || onResolve) && !thread.resolved && !thread.pending && thread.id;
  const writing = replying || !!reply;
  const first = thread.comments[0];
  return (
    <article
      aria-label={where ? `Thread on ${where}` : "Review thread"}
      className="rounded-xl border border-border bg-surface font-sans shadow-xs"
    >
      {(!bare || span || thread.outdated || thread.resolved) && (
        <header
          className={`flex min-h-8 items-center gap-2 px-3 pt-1.5 text-meta text-faint-foreground ${open ? "" : "pb-1.5"}`}
        >
          {thread.resolved && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide resolved thread" : "Show resolved thread"}
              onClick={() => setOpen(!open)}
              className="grid size-5 shrink-0 place-items-center rounded-md hover:bg-hover"
            >
              <icons.next
                aria-hidden
                className={`size-3.5 transition-transform duration-fast ${open ? "rotate-90" : ""}`}
              />
            </button>
          )}
          <span className="min-w-0 flex-1 truncate">
            {bare ? span : <span className="font-mono">{where ?? "Conversation"}</span>}
            {!open && first && (
              <span className="text-muted-foreground">
                {bare && span ? " · " : !bare ? " · " : ""}
                {first.author}: {first.body.split("\n")[0]}
              </span>
            )}
          </span>
          {thread.outdated && <Badge tone="warning">Outdated</Badge>}
          {thread.resolved && <Badge tone="success">Resolved</Badge>}
        </header>
      )}
      {open && (
        <ol className="flex flex-col gap-3 px-3 py-2.5">
          {thread.comments.map((c, i) => (
            <ThreadComment
              key={c.id ?? i}
              comment={c}
              thread={thread}
              repo={repo}
              onOpen={onOpen}
              onEdit={onEdit}
              onDelete={onDelete}
              suggestions={suggestions}
            />
          ))}
        </ol>
      )}
      {open && canAct && !writing && (
        <div className="flex items-center gap-1 px-2 pb-2 pl-9">
          {onReply && (
            <Button size="sm" onClick={() => setReplying(true)}>
              <icons.reply aria-hidden />
              Reply
            </Button>
          )}
          {onResolve && (
            <Button size="sm" disabled={!!sending} onClick={() => void send("resolve")}>
              <icons.done aria-hidden />
              {sending === "resolve" ? "Resolving…" : "Resolve"}
            </Button>
          )}
        </div>
      )}
      {open && canAct && writing && onReply && (
        <form
          className="flex flex-col gap-2 px-3 pb-2.5 pl-10"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) void send("reply");
          }}
        >
          <textarea
            aria-label="Reply"
            placeholder="Reply…"
            autoFocus
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
              if (e.key === "Escape" && !reply) setReplying(false);
            }}
            className="field-sizing-content max-h-40 min-h-14 w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-body placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              disabled={!!sending}
              onClick={() => {
                setReply("");
                setReplying(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!reply.trim() || !!sending}>
              {sending === "reply" ? "Replying…" : "Reply"}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}

/** One comment of a thread, editable in place while it's pending. */
function ThreadComment({
  comment: c,
  thread,
  repo,
  onOpen,
  onEdit,
  onDelete,
  suggestions,
}: {
  comment: ThreadView["comments"][number];
  thread: ThreadView;
  repo: string;
  onOpen: (url: string) => void;
  onEdit?: (commentId: string, body: string) => Promise<boolean>;
  onDelete?: (commentId: string) => Promise<boolean>;
  suggestions?: SuggestionActions;
}) {
  // `undefined` while not editing. Kept by comment, so a scroll away doesn't lose it.
  const [draft, setDraft] = useSticky<string | undefined>(`prEdit/${c.id}`, undefined);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    return ok;
  };
  const save = async () => {
    const body = draft?.trim();
    if (body && (await act(() => onEdit!(c.id!, body)))) setDraft(undefined);
  };
  const mine = c.pending && c.id;
  const parts = splitSuggestions(c.body);
  // A commit applies a comment's first suggestion, as GitHub's own does.
  const first = parts.findIndex((part) => "suggestion" in part);
  return (
    <li>
      <div className="group/comment flex min-h-5 items-center gap-1.5 text-meta">
        <Avatar login={c.author ?? "?"} />
        <span className="font-medium text-foreground">{c.author ?? "Someone"}</span>
        {c.pending ? (
          <Badge tone="warning">Pending</Badge>
        ) : (
          c.createdAt && <span className="text-faint-foreground">{ago(c.createdAt)}</span>
        )}
        <span className="flex-1" />
        {c.url && !c.pending && (
          <span className="opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
            <IconButton size="sm" label="Open on GitHub" onClick={() => onOpen(c.url!)}>
              <icons.external aria-hidden />
            </IconButton>
          </span>
        )}
        {mine && onEdit && draft === undefined && (
          <IconButton size="sm" label="Edit comment" onClick={() => setDraft(c.body)}>
            <icons.edit aria-hidden />
          </IconButton>
        )}
        {mine && onDelete && draft === undefined && (
          <IconButton
            size="sm"
            label="Delete comment"
            disabled={busy}
            onClick={() => void act(() => onDelete(c.id!))}
          >
            <icons.delete aria-hidden />
          </IconButton>
        )}
      </div>
      {draft !== undefined ? (
        <form
          className="mt-1 flex flex-col gap-2 pl-7"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <textarea
            aria-label="Edit comment"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
            }}
            className="field-sizing-content max-h-64 min-h-16 w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-body focus-visible:outline-2 focus-visible:outline-ring"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!draft.trim() || busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-0.5 flex flex-col gap-2 pl-7 text-body [&_.markdown]:text-body">
          {parts.map((part, i) =>
            "markdown" in part ? (
              <GithubMarkdown key={i} text={part.markdown} repo={repo} onOpen={onOpen} />
            ) : (
              <Suggestion
                key={i}
                before={linesUnderThread(
                  thread.diffHunk,
                  thread.startLine && thread.line ? thread.line - thread.startLine + 1 : 1,
                )}
                after={part.suggestion}
                start={thread.startLine ?? thread.line ?? 1}
                path={thread.path}
              >
                {i === first && suggestions && c.id && !c.pending && (
                  <SuggestionButtons commentId={c.id} thread={thread} actions={suggestions} />
                )}
              </Suggestion>
            ),
          )}
        </div>
      )}
    </li>
  );
}
