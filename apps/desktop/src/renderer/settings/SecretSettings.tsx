import { t } from "i18next";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { SavedSecret } from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { notify } from "../notifications";
import { msg } from "../../i18n";
import { Picker } from "../ui";
import {
  allHosts,
  field,
  HostPicker,
  hostsOf,
  ListHeading,
  PageTitle,
  primaryButton,
  quietButton,
  Row,
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

/** When an expiry choice ends, as `secret/save` takes it: the end of a picked day, local time. */
export function expiresAt(choice: string, date: string, now = Date.now()): string | undefined {
  if (choice === "never") return undefined;
  if (choice === "date") return new Date(`${date}T23:59:59`).toISOString();
  return new Date(now + Number(choice) * 86_400_000).toISOString();
}

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
  const [adding, setAdding] = useState(false);
  const [expiry, setExpiry] = useState("never");

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
    if ("error" in answer)
      notify({
        tone: "error",
        title: t("Couldn't delete {{title}}", { title: secret.name }),
        body: describeError(answer.error),
      });
    void load();
  };

  const add = async (form: HTMLFormElement) => {
    const value = (name: string) =>
      (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";
    setBusy(true);
    const answer = await window.parallax.request(hostId, "secret/save", {
      name: value("name"),
      value: value("value"),
      expiresAt: expiresAt(expiry, value("date")),
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
    setAdding(false);
    setExpiry("never");
    void load();
  };

  const empty = !connected
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
      {empty ? (
        <p className="px-4 py-3 text-body text-muted-foreground">{empty}</p>
      ) : (
        <>
          {secrets?.map((secret) => (
            <Row
              key={secret.id}
              title={secret.name}
              description={
                secret.expiresAt
                  ? t("Expires {{when}}", { when: nextLabel(secret.expiresAt) })
                  : t("Never expires")
              }
            >
              <button
                type="button"
                className={quietButton}
                disabled={busy}
                onClick={() => void remove(secret)}
              >
                {t("Delete")}
              </button>
            </Row>
          ))}
          {adding ? (
            <form
              aria-label={t("Add secret")}
              onSubmit={(e) => {
                e.preventDefault();
                void add(e.currentTarget);
              }}
              className="flex flex-col gap-3 border-border px-4 py-3.5 not-last:border-b"
            >
              <label className="text-body text-muted-foreground">
                {t("Name")}
                <input
                  name="name"
                  required
                  maxLength={100}
                  placeholder={t("sudo password")}
                  spellCheck={false}
                  autoComplete="off"
                  className={field}
                />
              </label>
              <label className="text-body text-muted-foreground">
                {t("Value")}
                {/* Masked as a password field is, but keeps a pasted .env's newlines. */}
                <textarea
                  name="value"
                  required
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("A password, an API key, or a whole .env file")}
                  className={`${field} resize-y font-mono [-webkit-text-security:disc]`}
                />
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <span className="text-body text-muted-foreground">
                  {t("Expires")}
                  <Picker
                    field
                    label={t("Expires")}
                    value={expiry}
                    onChange={setExpiry}
                    options={expiries.map((e) => ({ value: e.value, label: t(e.label) }))}
                    className="mt-1 w-40"
                  />
                </span>
                {expiry === "date" && (
                  <input
                    name="date"
                    type="date"
                    required
                    aria-label={t("Expiry date")}
                    // Today in local time, as `expiresAt` reads the picked day.
                    min={new Date().toLocaleDateString("en-CA")}
                    className={field}
                  />
                )}
              </div>
              <p className="text-body text-muted-foreground">
                {t(
                  "Kept in this computer's keychain and never shown again. Agents get it in a private file their commands can read.",
                )}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setExpiry("never");
                  }}
                  className={quietButton}
                >
                  {t("Cancel")}
                </button>
                <button type="submit" disabled={busy} className={primaryButton}>
                  {t("Save secret")}
                </button>
              </div>
            </form>
          ) : (
            <Row
              title={secrets?.length ? t("Add another") : t("No saved secrets")}
              description={t("Save one here, or agents ask with a card when they need one.")}
            >
              <button
                type="button"
                onClick={() => setAdding(true)}
                className={`${quietButton} flex items-center gap-1 border border-border [&_svg]:size-3.5`}
              >
                <Plus aria-hidden />
                {t("Add secret")}
              </button>
            </Row>
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
