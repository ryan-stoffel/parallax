import { t } from "i18next";
import {
  Clock,
  Eye,
  EyeOff,
  FileKey,
  Infinity as InfinityIcon,
  KeyRound,
  Plus,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import type { SavedSecret } from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { locale } from "../locale";
import { notify } from "../notifications";
import { msg } from "../../i18n";
import { IconButton, Segmented } from "../ui";
import {
  allHosts,
  ConfirmRemove,
  field,
  HostPicker,
  hostsOf,
  ListHeading,
  outlineButton,
  PageTitle,
  primaryButton,
  quietButton,
  Section,
} from "./parts";
import { nextLabel } from "./shared";

/**
 * Settings > Secrets (0106): the secrets saved on each computer for every thread there. An agent
 * uses one by name with `use_secret` instead of asking with the secret card. Values go to the
 * computer's keychain and are never shown again.
 */
export function SecretSettings() {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const targets = hostsOf(hosts, scope);
  return (
    <>
      <PageTitle title={t("Secrets")}>
        {t(
          "Passwords, API keys, and .env files every agent on a computer can use without asking, until they expire.",
        )}
      </PageTitle>
      <Section
        title={t("Saved secrets")}
        action={<HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
      >
        {targets.map((host) => (
          <HostSecrets key={host.id} host={host} named={targets.length > 1} />
        ))}
      </Section>
    </>
  );
}

/** The expiry choices, in days, and a date the user picks. */
const expiries = [
  { value: "never", label: msg("Never") },
  { value: "1", label: msg("In 1 day") },
  { value: "7", label: msg("In 7 days") },
  { value: "30", label: msg("In 30 days") },
  { value: "90", label: msg("In 90 days") },
  { value: "date", label: msg("On a date") },
];

/** What an empty list offers to start with: each opens the form named `name`, or its title. */
const starters = [
  {
    icon: Terminal,
    title: msg("sudo password"),
    hint: msg("Agents run sudo without asking you"),
    name: undefined,
  },
  {
    icon: KeyRound,
    title: msg("API key"),
    hint: msg("For a service your agents call"),
    name: "",
  },
  {
    icon: FileKey,
    title: msg(".env file"),
    hint: msg("Paste the whole file, line breaks kept"),
    name: ".env",
  },
];

/** When an expiry choice ends, as `secret/save` takes it: the end of a picked day, local time. */
export function expiresAt(choice: string, date: string, now = Date.now()): string | undefined {
  if (choice === "never") return undefined;
  if (choice === "date") return new Date(`${date}T23:59:59`).toISOString();
  return new Date(now + Number(choice) * 86_400_000).toISOString();
}

/** How urgent a secret's expiry is: `soon` within three days, `expired` once it has passed. */
export function expiryTone(
  at: string | undefined,
  now = Date.now(),
): "never" | "later" | "soon" | "expired" {
  if (!at) return "never";
  const left = new Date(at).getTime() - now;
  return left <= 0 ? "expired" : left < 3 * 86_400_000 ? "soon" : "later";
}

const longDate = (at: string) =>
  new Date(at).toLocaleDateString(locale(), { month: "long", day: "numeric", year: "numeric" });

const chipTones = {
  never: "border-border/60 text-muted-foreground",
  later: "border-border/60 text-muted-foreground",
  soon: "border-warning/30 text-warning",
  expired: "border-danger/30 text-danger",
};

/** A secret's expiry as a chip, with the exact day in its tooltip. */
function ExpiryChip({ at }: { at?: string }) {
  const tone = expiryTone(at);
  return (
    <span
      title={at && longDate(at)}
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-meta whitespace-nowrap [&_svg]:size-3 ${chipTones[tone]}`}
    >
      {tone === "never" ? <InfinityIcon aria-hidden /> : <Clock aria-hidden />}
      {!at
        ? t("Never expires")
        : tone === "expired"
          ? t("Expired")
          : t("Expires {{when}}", { when: nextLabel(at) })}
    </span>
  );
}

const iconTile =
  "grid size-8 shrink-0 place-items-center rounded-lg bg-hover text-muted-foreground [&_svg]:size-4";

/** One computer's saved secrets, under its name where `named`, with a form to add one. */
function HostSecrets({ host, named }: { host: Host; named: boolean }) {
  const hostId = host.id;
  const connection = useShownConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "savedSecrets" in connection.capabilities;
  const connectedNow = useConnectedNow(hostId);
  const [secrets, setSecrets] = useState<SavedSecret[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The open form's starting name: empty for a new secret, a saved one's to replace it.
  const [adding, setAdding] = useState<string>();
  // The id of the secret whose delete is waiting to be confirmed.
  const [removing, setRemoving] = useState<string>();

  const load = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "secret/list", {});
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setSecrets(answer.result.secrets);
      setError(undefined);
    }
  }, [hostId]);
  useEffect(() => {
    setSecrets(undefined);
    setError(undefined);
  }, [supported, hostId]);
  useEffect(() => {
    if (supported && connectedNow) void load();
  }, [supported, connectedNow, load]);

  const remove = async (secret: SavedSecret) => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "secret/delete", { id: secret.id });
    setBusy(false);
    setRemoving(undefined);
    if ("error" in answer)
      notify({
        tone: "error",
        title: t("Couldn't delete {{title}}", { title: secret.name }),
        body: describeError(answer.error),
      });
    void load();
  };

  const save = async (name: string, value: string, expires: string | undefined) => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "secret/save", {
      name,
      value,
      expiresAt: expires,
    });
    setBusy(false);
    if ("error" in answer) {
      notify({
        tone: "error",
        title: t("Couldn't save the secret"),
        body: describeError(answer.error),
      });
      return;
    }
    setAdding(undefined);
    void load();
  };

  const status = !connected
    ? t("Not connected")
    : !supported
      ? t("This computer's plxd can't save secrets.")
      : error && !secrets
        ? error
        : secrets === undefined
          ? t("Loading…")
          : undefined;
  return (
    <>
      {named && <ListHeading>{host.name}</ListHeading>}
      {status ? (
        <p className="px-4 py-3 text-body text-muted-foreground">{status}</p>
      ) : (
        <>
          {secrets?.map((secret) => (
            <div
              key={secret.id}
              className="flex min-h-14 items-center gap-3 border-b border-border/40 px-4 py-2.5"
            >
              <span aria-hidden className={iconTile}>
                {/\.env/i.test(secret.name) ? <FileKey /> : <KeyRound />}
              </span>
              <div className="min-w-0 flex-1">
                <span title={secret.name} className="block truncate text-body font-medium">
                  {secret.name}
                </span>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  {t("Added {{date}}", { date: longDate(secret.createdAt) })}
                </span>
              </div>
              {removing === secret.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <ConfirmRemove
                    label={t("Delete")}
                    disabled={busy}
                    onRemove={() => void remove(secret)}
                    onCancel={() => setRemoving(undefined)}
                  />
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  <ExpiryChip at={secret.expiresAt} />
                  <button
                    type="button"
                    className={`${quietButton} ml-1`}
                    aria-label={t("Replace {{name}}", { name: secret.name })}
                    onClick={() => setAdding(secret.name)}
                  >
                    {t("Replace")}
                  </button>
                  <IconButton
                    label={t("Delete {{name}}", { name: secret.name })}
                    onClick={() => setRemoving(secret.id)}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              )}
            </div>
          ))}
          {adding !== undefined ? (
            <SecretForm
              // A new starting name is a new form.
              key={adding}
              startName={adding}
              saved={secrets?.map((s) => s.name) ?? []}
              busy={busy}
              onSave={save}
              onCancel={() => setAdding(undefined)}
            />
          ) : secrets?.length ? (
            <div className="flex min-h-14 items-center justify-between gap-6 px-4 py-3">
              <p className="text-meta text-muted-foreground">
                {t("Agents use a secret by its name, so name it for what it is.")}
              </p>
              <button type="button" onClick={() => setAdding("")} className={outlineButton}>
                <Plus aria-hidden />
                {t("Add secret")}
              </button>
            </div>
          ) : (
            <div className="px-4 py-5">
              <div className="flex items-start gap-3">
                <span aria-hidden className={iconTile}>
                  <KeyRound />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-body font-medium">{t("No saved secrets yet")}</h3>
                  <p className="mt-0.5 max-w-xl text-body text-muted-foreground">
                    {t(
                      "Save a password, key, or file once. Agents on this computer then use it by name instead of asking you each time.",
                    )}
                  </p>
                </div>
                <button type="button" onClick={() => setAdding("")} className={outlineButton}>
                  <Plus aria-hidden />
                  {t("Add secret")}
                </button>
              </div>
              <ul aria-label={t("Suggestions")} className="mt-4 grid gap-2 sm:grid-cols-3">
                {starters.map((starter) => (
                  <li key={starter.title}>
                    <button
                      type="button"
                      onClick={() => setAdding(starter.name ?? t(starter.title))}
                      className="flex h-full w-full flex-col items-start gap-1.5 rounded-lg border border-border/60 px-3 py-2.5 text-left hover:border-border hover:bg-hover"
                    >
                      <starter.icon aria-hidden className="size-4 text-muted-foreground" />
                      <span className="text-body font-medium">{t(starter.title)}</span>
                      <span className="text-meta text-muted-foreground">{t(starter.hint)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {error && secrets && (
        <p role="alert" className="px-4 py-3 text-body text-danger">
          {error}
        </p>
      )}
    </>
  );
}

const fieldLabel = "block text-body font-medium";

/**
 * The form that saves a secret, starting from `startName`. A name in `saved` replaces that secret,
 * and the form says so. The value stays in its field, never in state. Escape cancels, and Mod+Enter
 * in the value saves.
 */
function SecretForm({
  startName,
  saved,
  busy,
  onSave,
  onCancel,
}: {
  startName: string;
  saved: string[];
  busy: boolean;
  onSave: (name: string, value: string, expiresAt: string | undefined) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(startName);
  const [shown, setShown] = useState(false);
  const [expiry, setExpiry] = useState("never");
  const [date, setDate] = useState("");
  const replaces = saved.includes(name.trim());
  const until = expiry === "date" && !date ? undefined : expiresAt(expiry, date);
  return (
    <form
      aria-label={replaces ? t("Replace secret") : t("Add secret")}
      onSubmit={(e) => {
        e.preventDefault();
        const value = (e.currentTarget.elements.namedItem("value") as HTMLTextAreaElement).value;
        onSave(name, value, expiresAt(expiry, date));
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Not Settings' too.
        e.preventDefault();
        onCancel();
      }}
      className="flex flex-col gap-4 px-4 py-4"
    >
      <div>
        <label htmlFor={`${id}name`} className={fieldLabel}>
          {t("Name")}
        </label>
        <input
          id={`${id}name`}
          name="name"
          required
          maxLength={100}
          autoFocus={!startName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sudo password")}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${id}name-hint`}
          className={field}
        />
        <p id={`${id}name-hint`} className="mt-1 text-meta text-muted-foreground">
          {replaces
            ? t("A secret with this name is saved. Saving replaces its value and expiry.")
            : t("Agents ask for it by this name.")}
        </p>
      </div>
      <div>
        <div className="flex items-end justify-between">
          <label htmlFor={`${id}value`} className={fieldLabel}>
            {t("Value")}
          </label>
          <IconButton
            size="sm"
            label={t("Show value")}
            aria-pressed={shown}
            onClick={() => setShown(!shown)}
          >
            {shown ? <EyeOff /> : <Eye />}
          </IconButton>
        </div>
        {/* Masked as a password field is, but keeps a pasted .env's newlines. */}
        <textarea
          id={`${id}value`}
          name="value"
          required
          rows={3}
          autoFocus={!!startName}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
          placeholder={t("A password, an API key, or a whole .env file")}
          className={`${field} max-h-64 min-h-20 resize-y font-mono placeholder:font-sans ${shown ? "" : "[-webkit-text-security:disc]"}`}
        />
      </div>
      <div>
        <span className={fieldLabel}>{t("Expires")}</span>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Segmented
            wrap
            label={t("Expires")}
            value={expiry}
            onChange={setExpiry}
            options={expiries.map((e) => ({ value: e.value, name: t(e.label) }))}
          />
          {expiry === "date" && (
            <input
              name="date"
              type="date"
              required
              autoFocus
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label={t("Expiry date")}
              // Today in local time, as `expiresAt` reads the picked day.
              min={new Date().toLocaleDateString("en-CA")}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-body"
            />
          )}
        </div>
        <p aria-live="polite" className="mt-1 text-meta text-muted-foreground empty:hidden">
          {expiry === "never"
            ? t("Agents can use it until you delete it.")
            : until && t("Agents can use it until {{date}}.", { date: longDate(until) })}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2 border-t border-border/40 pt-3">
        <p className="mr-auto flex min-w-0 items-start gap-1.5 text-meta text-muted-foreground">
          <ShieldCheck aria-hidden className="mt-px size-3.5 shrink-0" />
          {t(
            "Kept in this computer's keychain and never shown again. Agents get it in a private file their commands can read.",
          )}
        </p>
        <button type="button" onClick={onCancel} className={quietButton}>
          {t("Cancel")}
        </button>
        <button type="submit" disabled={busy} className={primaryButton}>
          {replaces ? t("Replace secret") : t("Save secret")}
        </button>
      </div>
    </form>
  );
}
