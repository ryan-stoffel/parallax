import { useState } from "react";

import { icons } from "../icons";
import { useSticky } from "../sticky";
import { Badge, Button, IconButton } from "../ui";
import { GithubMarkdown } from "./GithubMarkdown";
import type { ThreadView } from "./model";
import { ago } from "./parts";

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
}) {
  const [reply, setReply] = useSticky(`prReply/${thread.id ?? thread.url}`, "");
  const [sending, setSending] = useState<"reply" | "resolve">();
  const send = async (what: "reply" | "resolve") => {
    setSending(what);
    const ok = what === "reply" ? await onReply!(reply.trim()) : await onResolve!();
    setSending(undefined);
    if (ok && what === "reply") setReply("");
  };
  const lines = thread.startLine ? `${thread.startLine}-${thread.line}` : thread.line;
  const where = thread.path && `${thread.path}${lines ? `:${lines}` : ""}`;
  const span = thread.startLine && `Lines ${thread.startLine} to ${thread.line}`;
  return (
    <article
      aria-label={where ? `Thread on ${where}` : "Review thread"}
      className="overflow-hidden rounded-xl border border-border bg-surface font-sans"
    >
      {(!bare || span || thread.outdated || thread.resolved) && (
        <header className="flex h-9 items-center gap-2 border-b border-border pr-1.5 pl-3">
          <icons.comment aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">
            {bare ? span : (where ?? "Conversation")}
          </span>
          {thread.outdated && <Badge tone="warning">Outdated</Badge>}
          {thread.resolved && <Badge tone="success">Resolved</Badge>}
          {thread.url && !thread.pending && !bare && (
            <IconButton size="sm" label="Open on GitHub" onClick={() => onOpen(thread.url!)}>
              <icons.external aria-hidden />
            </IconButton>
          )}
        </header>
      )}
      <ol className="flex flex-col gap-3 px-3 py-3">
        {thread.comments.map((c, i) => (
          <ThreadComment
            key={c.id ?? i}
            comment={c}
            repo={repo}
            onOpen={onOpen}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </ol>
      {(onReply || onResolve) && !thread.resolved && !thread.pending && thread.id && (
        <form
          className="flex flex-col gap-2 border-t border-border px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim() && onReply) void send("reply");
          }}
        >
          {onReply && (
            <textarea
              aria-label="Reply"
              placeholder="Reply…"
              rows={1}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                  e.currentTarget.form?.requestSubmit();
              }}
              className="field-sizing-content max-h-40 min-h-8 w-full resize-none rounded-md border border-border bg-transparent px-2.5 py-1.5 text-body placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          )}
          <div className="flex justify-end gap-1.5">
            {onResolve && (
              <Button size="sm" disabled={!!sending} onClick={() => void send("resolve")}>
                <icons.done aria-hidden />
                {sending === "resolve" ? "Resolving…" : "Resolve"}
              </Button>
            )}
            {onReply && (
              <Button
                size="sm"
                variant="outline"
                type="submit"
                disabled={!reply.trim() || !!sending}
              >
                {sending === "reply" ? "Replying…" : "Reply"}
              </Button>
            )}
          </div>
        </form>
      )}
    </article>
  );
}

/** One comment of a thread, editable in place while it's pending. */
function ThreadComment({
  comment: c,
  repo,
  onOpen,
  onEdit,
  onDelete,
}: {
  comment: ThreadView["comments"][number];
  repo: string;
  onOpen: (url: string) => void;
  onEdit?: (commentId: string, body: string) => Promise<boolean>;
  onDelete?: (commentId: string) => Promise<boolean>;
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
  return (
    <li>
      <div className="flex min-h-6 items-center gap-1.5 text-meta">
        <span className="font-medium text-foreground">{c.author ?? "Someone"}</span>
        {c.pending ? (
          <Badge tone="warning">Pending</Badge>
        ) : (
          c.createdAt && <span className="text-faint-foreground">· {ago(c.createdAt)}</span>
        )}
        <span className="flex-1" />
        {c.url && !c.pending && (
          <IconButton size="sm" label="Open on GitHub" onClick={() => onOpen(c.url!)}>
            <icons.external aria-hidden />
          </IconButton>
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
          className="mt-1 flex flex-col gap-2"
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
        <div className="mt-1 text-body [&_.markdown]:text-body">
          <GithubMarkdown text={c.body} repo={repo} onOpen={onOpen} />
        </div>
      )}
    </li>
  );
}
