import { t } from "i18next";
import { useEffect, useId, useRef, useState } from "react";

import { msg } from "../i18n";
import type { IssueContainer, IssueProvider } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { icons } from "./icons";
import { connectionName } from "./IssueParts";
import type { ConnectionEntry } from "./issues";
import { TrackerLogo } from "./TrackerLogo";
import { Button, Dialog, IconButton, Picker } from "./ui";

/** What each tracker files issues in. */
const containerNames: Record<IssueProvider, { label: string; choose: string }> = {
  github: { label: msg("Repository"), choose: msg("Choose a repository") },
  linear: { label: msg("Team"), choose: msg("Choose a team") },
  jira: { label: msg("Project"), choose: msg("Choose a project") },
};

const keyOf = (a: ConnectionEntry) => `${a.hostId} ${a.connection.id}`;
const fieldLabel = "block text-body font-medium";
const textField =
  "mt-1 block w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-body placeholder:text-faint-foreground";

/**
 * New issue, a modal open while it's mounted: the tracker account to file it with, then its
 * repository, team, or project from `issue/containers`, its title, and a Markdown description.
 * Create issue files it with `issue/create`, assigned to you, tells `onCreated` which computer
 * filed it, and closes. `onDone` runs once it's closed.
 */
export function NewIssueDialog({
  accounts,
  hosts,
  onCreated,
  onDone,
}: {
  accounts: ConnectionEntry[];
  hosts: Host[];
  onCreated: (hostId: string) => void;
  onDone: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const id = useId();
  const [accountKey, setAccountKey] = useState(accounts[0] ? keyOf(accounts[0]) : "");
  const account = accounts.find((a) => keyOf(a) === accountKey);
  // The chosen account's containers, once read.
  const [containers, setContainers] = useState<{ for: string; list: IssueContainer[] }>();
  const [containerId, setContainerId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // showModal focuses the first control, Close; the title is where typing goes.
  useEffect(() => {
    dialog.current?.showModal();
    titleField.current?.focus();
  }, []);

  const hostId = account?.hostId;
  const connectionId = account?.connection.id;
  useEffect(() => {
    if (!hostId || !connectionId) return;
    let live = true;
    setContainerId("");
    void window.parallax.request(hostId, "issue/containers", { connectionId }).then((answer) => {
      if (!live) return;
      if ("error" in answer) return setError(describeError(answer.error));
      setError(undefined);
      setContainers({ for: `${hostId} ${connectionId}`, list: answer.result.containers });
      // The only place it can go needs no choosing.
      if (answer.result.containers.length === 1) setContainerId(answer.result.containers[0]!.id);
    });
    return () => {
      live = false;
    };
  }, [hostId, connectionId]);
  const list = containers?.for === accountKey ? containers.list : undefined;

  const create = async () => {
    if (!account || !containerId || !title.trim()) return;
    setSaving(true);
    const answer = await window.parallax.request(account.hostId, "issue/create", {
      connectionId: account.connection.id,
      containerId,
      title: title.trim(),
      body: body.trim(),
    });
    setSaving(false);
    if ("error" in answer) return setError(describeError(answer.error));
    onCreated(account.hostId);
    dialog.current?.close();
  };

  const names = account && containerNames[account.connection.provider];
  const severalHosts = new Set(accounts.map((a) => a.hostId)).size > 1;
  return (
    <Dialog ref={dialog} width="lg" aria-labelledby={`${id}title`} onClose={onDone}>
      <form
        aria-label={t("New issue")}
        className="flex flex-col gap-4 px-5 pt-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <header className="flex items-start gap-3">
          <div className="flex-1">
            <h2 id={`${id}title`} className="text-reading font-semibold">
              {t("New issue")}
            </h2>
            <p className="mt-0.5 text-body text-muted-foreground">
              {t("Filed on its tracker and assigned to you.")}
            </p>
          </div>
          <IconButton label={t("Close")} onClick={() => dialog.current?.close()}>
            <icons.close aria-hidden />
          </IconButton>
        </header>

        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <span className={fieldLabel}>{t("Tracker")}</span>
            <Picker
              field
              label={t("Tracker")}
              value={accountKey}
              onChange={setAccountKey}
              options={accounts.map((a) => ({
                value: keyOf(a),
                label: connectionName(a.connection),
                icon: <TrackerLogo provider={a.connection.provider} />,
                group: severalHosts ? hosts.find((h) => h.id === a.hostId)?.name : undefined,
              }))}
              className="mt-1 w-full"
            />
          </div>
          <div className="min-w-0 flex-1">
            <span className={fieldLabel}>{names ? t(names.label) : t("Repository")}</span>
            <Picker
              field
              label={names ? t(names.label) : t("Repository")}
              disabled={!list}
              value={containerId}
              onChange={setContainerId}
              placeholder={!list && !error ? t("Loading…") : names && t(names.choose)}
              options={(list ?? []).map((c) => ({ value: c.id, label: c.name }))}
              search={list && list.length > 8 ? t("Search") : undefined}
              className="mt-1 w-full"
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${id}name`} className={fieldLabel}>
            {t("Title")}
          </label>
          <input
            id={`${id}name`}
            ref={titleField}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
            className={textField}
          />
        </div>

        <div>
          <label htmlFor={`${id}body`} className={fieldLabel}>
            {t("Description")}
          </label>
          <textarea
            id={`${id}body`}
            rows={6}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
            }}
            placeholder={t("Markdown, optional")}
            className={`${textField} field-sizing-content max-h-72 min-h-32 resize-none`}
          />
        </div>

        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button onClick={() => dialog.current?.close()}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving || !containerId || !title.trim()}
          >
            {saving ? t("Creating…") : t("Create issue")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
