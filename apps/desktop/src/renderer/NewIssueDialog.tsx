import { t } from "i18next";
import { useEffect, useId, useRef, useState } from "react";

import { msg } from "../i18n";
import type { IssueContainer, IssueProvider } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import type { Host } from "./hosts";
import { icons } from "./icons";
import {
  accountKey,
  containerChoices,
  pickedContainer,
  pickedProvider,
  providerNames,
  providers,
  type ConnectionEntry,
  type IssuePick,
} from "./issues";
import { TrackerSetupDialog } from "./settings/TrackerSetupDialog";
import { stored } from "./stored";
import { TrackerLogo } from "./TrackerLogo";
import { Button, Dialog, IconButton, Picker } from "./ui";

/** What each tracker files issues in. */
const containerNames: Record<IssueProvider, { label: string; choose: string }> = {
  github: { label: msg("Repository"), choose: msg("Choose a repository") },
  linear: { label: msg("Team"), choose: msg("Choose a team") },
  jira: { label: msg("Project"), choose: msg("Choose a project") },
};

/** The tracker and the place the last issue was filed in, kept on this computer. */
const lastPick = stored<IssuePick>("parallax.newIssue", {}, (raw) => {
  const { provider, container } = (raw ?? {}) as Record<string, unknown>;
  return {
    provider: (providers as readonly unknown[]).includes(provider)
      ? (provider as IssueProvider)
      : undefined,
    container: typeof container === "string" ? container : undefined,
  };
});

const fieldLabel = "block text-body font-medium";
const textField =
  "mt-1 block w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-body placeholder:text-faint-foreground";

/**
 * New issue, a modal open while it's mounted. Its first dropdown picks the tracker: GitHub, Linear,
 * or Jira. One with no account reads Set up…, which opens that tracker's set-up over this dialog
 * and, once it connects, comes back with it picked. Its second lists that tracker's repositories,
 * teams, or projects from `issue/containers`, under each account's site or workspace when it has
 * several. Then a title and a Markdown description. It opens on the tracker and place last filed
 * in. Create issue files it with `issue/create`, assigned to you, tells `onCreated` which computer
 * filed it, and closes. `onDone` runs once it's closed.
 */
export function NewIssueDialog({
  accounts,
  hosts,
  setUpOn,
  onCreated,
  onConnected,
  onSourceControl,
  onDone,
}: {
  accounts: ConnectionEntry[];
  hosts: Host[];
  /** The computer a tracker with no account is set up on. */
  setUpOn?: string;
  onCreated: (hostId: string) => void;
  /** Told a computer has a new account, to read its accounts again. */
  onConnected: (hostId: string) => void;
  /** Opens Settings > Source control on a computer, where GitHub signs in. */
  onSourceControl: (hostId: string) => void;
  onDone: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const id = useId();
  const connected = providers.filter((p) => accounts.some((a) => a.connection.provider === p));
  const [provider, setProvider] = useState(() => pickedProvider(lastPick.get(), connected));
  // The tracker whose set-up is open over this dialog.
  const [settingUp, setSettingUp] = useState<IssueProvider>();
  // Each account's containers once read, by its key.
  const [containers, setContainers] = useState<Readonly<Record<string, IssueContainer[]>>>({});
  const [container, setContainer] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // showModal focuses the first control, Close; the title is where typing goes.
  useEffect(() => {
    dialog.current?.showModal();
    titleField.current?.focus();
  }, []);

  const mine = accounts.filter((a) => a.connection.provider === provider);
  // Reads each of the tracker's accounts not read yet, as one just set up isn't.
  const unread = mine.filter((a) => !containers[accountKey(a)]);
  const unreadKeys = unread.map(accountKey).join("\t");
  useEffect(() => {
    for (const account of unread)
      void window.parallax
        .request(account.hostId, "issue/containers", { connectionId: account.connection.id })
        .then((answer) => {
          if ("error" in answer) setError(describeError(answer.error));
          setContainers((all) => ({
            ...all,
            [accountKey(account)]: "error" in answer ? [] : answer.result.containers,
          }));
        });
    // `unread` follows `unreadKeys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKeys]);
  const loaded = mine.length > 0 && unread.length === 0;
  const choices = containerChoices(
    mine,
    containers,
    Object.fromEntries(hosts.map((h) => [h.id, h.name])),
  );
  const chosen = choices.find((c) => c.value === container);
  // Once a tracker's places are in, the one last filed in is picked, or the only one.
  const choiceKeys = choices.map((c) => c.value).join("\t");
  useEffect(() => {
    if (loaded && !chosen) setContainer(pickedContainer(lastPick.get(), choices));
    // `choices` follows `choiceKeys`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, choiceKeys]);

  const create = async () => {
    if (!provider || !chosen || !title.trim()) return;
    const { hostId, connection } = chosen.account;
    setSaving(true);
    const answer = await window.parallax.request(hostId, "issue/create", {
      connectionId: connection.id,
      containerId: chosen.containerId,
      title: title.trim(),
      body: body.trim(),
    });
    setSaving(false);
    if ("error" in answer) return setError(describeError(answer.error));
    lastPick.set({ provider, container: chosen.value });
    onCreated(hostId);
    dialog.current?.close();
  };

  const names = provider && containerNames[provider];
  return (
    <>
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
                value={provider ?? ""}
                onChange={(next) => {
                  const picked = next as IssueProvider;
                  if (!connected.includes(picked)) return setSettingUp(picked);
                  setProvider(picked);
                  setContainer("");
                  setError(undefined);
                }}
                options={providers.map((p) => ({
                  value: p,
                  label: providerNames[p],
                  icon: <TrackerLogo provider={p} />,
                  hint: connected.includes(p) || !setUpOn ? undefined : t("Set up…"),
                }))}
                className="mt-1 w-full"
                // As wide as its field: the default minimum would win over the field's width.
                panelClassName=""
              />
            </div>
            <div className="min-w-0 flex-1">
              <span className={fieldLabel}>{names ? t(names.label) : t("Repository")}</span>
              <Picker
                field
                label={names ? t(names.label) : t("Repository")}
                disabled={!loaded}
                value={container}
                onChange={setContainer}
                placeholder={!loaded && !error ? t("Loading…") : names && t(names.choose)}
                options={choices.map((c) => ({ value: c.value, label: c.label, group: c.group }))}
                search={choices.length > 8 ? t("Search") : undefined}
                className="mt-1 w-full"
                // As wide as its field: the default minimum would win over the field's width.
                panelClassName=""
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
            <Button variant="primary" type="submit" disabled={saving || !chosen || !title.trim()}>
              {saving ? t("Creating…") : t("Create issue")}
            </Button>
          </div>
        </form>
      </Dialog>
      {settingUp && setUpOn && (
        <TrackerSetupDialog
          provider={settingUp}
          hostId={setUpOn}
          onSourceControl={() => {
            dialog.current?.close();
            onSourceControl(setUpOn);
          }}
          onConnected={() => {
            // Back here with it picked. Its places list once the page has read its account.
            setProvider(settingUp);
            setContainer("");
            setError(undefined);
            onConnected(setUpOn);
          }}
          onDone={() => setSettingUp(undefined)}
        />
      )}
    </>
  );
}
