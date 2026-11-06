import { useState } from "react";

import { icons } from "../icons";
import { Badge, Button, IconButton } from "../ui";
import { GithubMarkdown } from "./GithubMarkdown";
import type { ThreadView } from "./model";
import { ago } from "./parts";

/**
 * A review thread: its file and line, Outdated or Resolved, each comment, and, where plxd writes
 * (`pr/write`), a reply box with Reply and Resolve. A write resolves to whether it worked, and the
 * box keeps its text until it does. In the Files tab it sits under its line, `bare` of its file.
 */
export function ReviewThread({
  thread,
  repo,
  bare,
  onOpen,
  onReply,
  onResolve,
}: {
  thread: ThreadView;
  repo: string;
  /** Leaves out its path, as under its line in a diff. */
  bare?: boolean;
  onOpen: (url: string) => void;
  onReply?: (body: string) => Promise<boolean>;
  onResolve?: () => Promise<boolean>;
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState<"reply" | "resolve">();
  const send = async (what: "reply" | "resolve") => {
    setSending(what);
    const ok = what === "reply" ? await onReply!(reply.trim()) : await onResolve!();
    setSending(undefined);
    if (ok && what === "reply") setReply("");
  };
  const where = thread.path && `${thread.path}${thread.line ? `:${thread.line}` : ""}`;
  return (
    <article
      aria-label={where ? `Thread on ${where}` : "Review thread"}
      className="overflow-hidden rounded-xl border border-border bg-surface font-sans"
    >
      {(!bare || thread.outdated || thread.resolved || thread.url) && (
        <header className="flex h-9 items-center gap-2 border-b border-border pr-1.5 pl-3">
          <icons.comment aria-hidden className="size-3.5 shrink-0 text-faint-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground">
            {bare ? "" : (where ?? "Conversation")}
          </span>
          {thread.outdated && <Badge tone="warning">Outdated</Badge>}
          {thread.resolved && <Badge tone="success">Resolved</Badge>}
          {thread.url && (
            <IconButton size="sm" label="Open on GitHub" onClick={() => onOpen(thread.url!)}>
              <icons.external aria-hidden />
            </IconButton>
          )}
        </header>
      )}
      <ol className="flex flex-col gap-3 px-3 py-3">
        {thread.comments.map((c, i) => (
          <li key={i}>
            <p className="text-meta">
              <span className="font-medium text-foreground">{c.author ?? "Someone"}</span>
              {c.createdAt && <span className="text-faint-foreground"> · {ago(c.createdAt)}</span>}
            </p>
            <div className="mt-1 text-body [&_.markdown]:text-body">
              <GithubMarkdown text={c.body} repo={repo} onOpen={onOpen} />
            </div>
          </li>
        ))}
      </ol>
      {(onReply || onResolve) && !thread.resolved && thread.id && (
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
