import { t } from "i18next";
import { useCallback, useEffect, useState } from "react";
import { Trans } from "react-i18next";

import type { IssueDetail } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { icons } from "./icons";
import { StateIcon } from "./IssueParts";
import { providerNames, type IssueEntry } from "./issues";
import { notify } from "./notifications";
import { GithubMarkdown } from "./pr/GithubMarkdown";
import { ago } from "./pr/parts";
import { keyTaken } from "./PullRequestsPage";
import { TrackerLogo } from "./TrackerLogo";
import { Button, EmptyState, IconButton, Picker } from "./ui";

/**
 * One issue on the Issues page, read with `issue/get` through the computer it was listed on: Back
 * to the list, or Escape; its title, where it is filed, and who has it; a picker that moves it to
 * another state; Start thread, which drafts a New thread about it; Open in its tracker; then its
 * description and comments as Markdown, and a box to comment. Each write reads the issue again and
 * tells the page, which reads its list again.
 */
export function IssueView({
  entry,
  onBack,
  onChanged,
  onStartThread,
}: {
  entry: IssueEntry;
  onBack: () => void;
  onChanged: () => void;
  onStartThread: (body: string) => void;
}) {
  const { hostId } = entry;
  const { connectionId, id } = entry.issue;
  const [detail, setDetail] = useState<IssueDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "issue/get", { connectionId, id });
    setBusy(false);
    if ("error" in answer) return setError(describeError(answer.error));
    setDetail(answer.result);
    setError(undefined);
  }, [hostId, connectionId, id]);
  useEffect(() => void load(), [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !keyTaken(e)) onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // What's listed shows until it's read, so the header never jumps.
  const issue = detail?.issue ?? entry.issue;
  const tracker = providerNames[issue.provider];
  const states = detail?.states ?? [];

  const written = () => {
    void load();
    onChanged();
  };
  const setState = async (stateId: string) => {
    // Its own state is listed to show as chosen, and isn't a move.
    if (stateId === issue.state.id) return;
    setBusy(true);
    const answer = await window.parallax.request(hostId, "issue/setState", {
      connectionId,
      id,
      stateId,
    });
    setBusy(false);
    if ("error" in answer)
      return notify({
        tone: "error",
        title: t("Couldn't change {{issue}}'s state", { issue: issue.key }),
        body: describeError(answer.error),
      });
    written();
  };
  const send = async () => {
    const body = comment.trim();
    if (!body || sending) return;
    setSending(true);
    const answer = await window.parallax.request(hostId, "issue/comment", {
      connectionId,
      id,
      body,
    });
    setSending(false);
    if ("error" in answer)
      return notify({
        tone: "error",
        title: t("Couldn't comment on {{issue}}", { issue: issue.key }),
        body: describeError(answer.error),
      });
    setComment("");
    written();
  };

  const repo = issue.provider === "github" ? issue.container.name : "";
  return (
    <>
      <nav
        aria-label={t("Issue")}
        className="mx-auto flex w-full max-w-3xl shrink-0 items-center gap-2 px-4 pt-2"
      >
        <Button size="sm" variant="quiet" onClick={onBack}>
          <icons.back aria-hidden />
          {t("Issues")}
        </Button>
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-border px-4 pt-4 pb-3">
          <div className="mx-auto max-w-3xl">
            <h2
              className="line-clamp-3 text-heading leading-snug font-semibold wrap-break-word"
              title={issue.title}
            >
              {issue.title} <span className="font-normal text-faint-foreground">{issue.key}</span>
            </h2>
            <div className="mt-2 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
              <TrackerLogo provider={issue.provider} className="size-4 shrink-0" />
              <span className="truncate font-medium text-foreground">{issue.container.name}</span>
              {issue.assignee && <span className="shrink-0">· {issue.assignee}</span>}
              <span className="shrink-0">
                · {t("Updated {{when}}", { when: ago(issue.updatedAt) })}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Picker
                field
                label={t("State")}
                disabled={busy || states.length === 0}
                value={issue.state.id}
                placeholder={issue.state.name}
                onChange={(stateId) => void setState(stateId)}
                options={states.map((s) => ({
                  value: s.id,
                  label: s.name,
                  icon: <StateIcon state={s} />,
                }))}
                className="h-7! max-w-56"
              />
              <span className="flex-1" />
              <Button
                size="sm"
                variant="primary"
                disabled={!detail}
                onClick={() => detail && onStartThread(detail.body)}
              >
                <icons.newThread aria-hidden />
                {t("Start thread")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                aria-label={t("Open {{issue}} in {{tracker}}", { issue: issue.key, tracker })}
                title={t("Open {{issue}} in {{tracker}}", { issue: issue.key, tracker })}
                onClick={() => window.open(issue.url, "_blank", "noreferrer")}
                className="rounded-full pr-2.5 pl-3"
              >
                <Trans>
                  Open in <TrackerLogo provider={issue.provider} className="size-4" />
                </Trans>
              </Button>
              <IconButton label={t("Refresh")} disabled={busy} onClick={() => void load()}>
                <icons.refresh aria-hidden className={busy ? "motion-safe:animate-spin" : ""} />
              </IconButton>
            </div>
          </div>
        </header>
        {!detail ? (
          error ? (
            <EmptyState
              icon={<icons.error aria-hidden />}
              title={t("Couldn't read {{issue}}", { issue: issue.key })}
              body={error}
              className="flex-1 justify-center"
            />
          ) : (
            <div
              role="status"
              aria-label={t("Loading…")}
              className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 py-5"
            >
              {[100, 92, 96, 60].map((w, i) => (
                <div
                  key={i}
                  className="h-3 animate-pulse rounded-sm bg-hover"
                  style={{ width: `${w}%` }}
                />
              ))}
            </div>
          )
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            <div className="mx-auto flex max-w-3xl flex-col gap-6 pt-4 pb-16">
              <section aria-label={t("Description")} className="min-w-0">
                <h3 className="mb-2 flex h-7 items-center text-reading font-semibold">
                  {t("Description")}
                </h3>
                {detail.body.trim() ? (
                  <GithubMarkdown text={detail.body} repo={repo} />
                ) : (
                  <p className="text-body text-faint-foreground">{t("No description provided.")}</p>
                )}
              </section>
              <section aria-label={t("Comments")} className="min-w-0">
                <h3 className="mb-2 flex h-7 items-center text-reading font-semibold">
                  {t("Comments")}
                </h3>
                {detail.comments.length > 0 && (
                  <ol className="mb-4 flex flex-col gap-4">
                    {detail.comments.map((c) => (
                      <li key={c.id}>
                        <p className="mb-1.5 flex items-baseline gap-2 text-meta text-muted-foreground">
                          <span className="text-body font-medium text-foreground">{c.author}</span>
                          {ago(c.createdAt)}
                        </p>
                        <div className="rounded-xl border border-border bg-surface px-3 py-2.5 shadow-xs">
                          <GithubMarkdown text={c.body} repo={repo} />
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                <form
                  aria-label={t("Comment", { context: "noun" })}
                  className="overflow-hidden rounded-xl border border-border bg-surface focus-within:border-faint-foreground/60"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <textarea
                    aria-label={t("Comment", { context: "noun" })}
                    placeholder={t("Leave a comment")}
                    rows={3}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                        e.currentTarget.form?.requestSubmit();
                    }}
                    className="field-sizing-content block max-h-64 min-h-20 w-full resize-none bg-transparent px-3 py-2.5 text-body placeholder:text-faint-foreground focus-visible:outline-none"
                  />
                  <div className="flex justify-end border-t border-border px-2 py-2">
                    <Button
                      size="sm"
                      variant="primary"
                      type="submit"
                      disabled={!comment.trim() || sending}
                    >
                      {sending ? t("Sending…") : t("Comment", { context: "verb" })}
                    </Button>
                  </div>
                </form>
              </section>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
