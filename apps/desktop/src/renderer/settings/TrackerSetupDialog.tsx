import { t } from "i18next";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { msg } from "../../i18n";
import type { IssueConnectParams, IssueProvider } from "../../protocol/generated/protocol";
import { describeError } from "../errors";
import { icons } from "../icons";
import { providerNames } from "../issues";
import { TrackerLogo } from "../TrackerLogo";
import { Button, Dialog, IconButton } from "../ui";
import { field } from "./parts";

/** What to do, in order, to connect each tracker that takes a token. A step may link to where it's done. */
const steps: Record<"linear" | "jira", { text: string; href?: string }[]> = {
  linear: [
    {
      text: msg("In Linear, open Settings › Security & access."),
      href: "https://linear.app/settings/account/security",
    },
    { text: msg("Create a personal API key.") },
    { text: msg("Paste the key here.") },
  ],
  jira: [
    { text: msg("Enter your Jira site, such as acme.atlassian.net.") },
    {
      text: msg("Create an API token in your Atlassian account."),
      href: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
    { text: msg("Enter the email you sign in to Atlassian with, and the token.") },
  ],
};

const fieldLabel = "block text-body font-medium";

/**
 * A tracker's set-up, a modal open while it's mounted, over Settings. Linear and Jira show their
 * steps, with links to where each is done, then their fields and Connect: plxd checks the account
 * with its tracker (`issue/connect`), and what it refuses shows here, in its words. A token stays
 * in its field, never in state. GitHub has no fields: its header says the computer's GitHub CLI
 * sign-in is used, and its one button opens Source control there. `onConnected` runs once an
 * account is saved, and `onDone` once the dialog has closed.
 */
export function TrackerSetupDialog({
  provider,
  hostId,
  onSourceControl,
  onConnected,
  onDone,
}: {
  provider: IssueProvider;
  hostId: string;
  onSourceControl: () => void;
  onConnected: () => void;
  onDone: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = providerNames[provider];

  // showModal focuses the first control, Close; the first field is where typing goes.
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
  }, []);

  const connect = async (params: IssueConnectParams) => {
    setBusy(true);
    const answer = await window.parallax.request(hostId, "issue/connect", params);
    setBusy(false);
    if ("error" in answer) return setError(describeError(answer.error));
    onConnected();
    dialog.current?.close();
  };

  const header = (
    <header className="flex items-start gap-3">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-hover [&_svg]:size-4"
      >
        <TrackerLogo provider={provider} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={`${id}title`} className="text-reading font-semibold">
          {t("Set up {{name}}", { name })}
        </h2>
        <p className="mt-0.5 text-body text-muted-foreground">
          {provider === "github"
            ? t("Parallax reads your GitHub issues with this computer's GitHub CLI sign-in.")
            : t("Parallax checks the account, then keeps its token in this computer's keychain.")}
        </p>
      </div>
      <IconButton label={t("Close")} onClick={() => dialog.current?.close()}>
        <icons.close aria-hidden />
      </IconButton>
    </header>
  );

  if (provider === "github")
    return (
      <Dialog ref={dialog} width="md" aria-labelledby={`${id}title`} onClose={onDone}>
        <div className="flex flex-col gap-4 px-5 pt-4 pb-4">
          {header}
          <div className="flex justify-end gap-2">
            <Button onClick={() => dialog.current?.close()}>{t("Cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                dialog.current?.close();
                onSourceControl();
              }}
            >
              {t("Open Source control")}
            </Button>
          </div>
        </div>
      </Dialog>
    );

  return (
    <Dialog ref={dialog} width="lg" aria-labelledby={`${id}title`} onClose={onDone}>
      <form
        aria-label={t("Set up {{name}}", { name })}
        className="flex flex-col gap-4 px-5 pt-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          const value = (field: string) =>
            (e.currentTarget.elements.namedItem(field) as HTMLInputElement).value.trim();
          void connect(
            provider === "linear"
              ? { provider, apiKey: value("token") }
              : { provider, site: value("site"), email: value("email"), apiToken: value("token") },
          );
        }}
      >
        {header}
        <ol className="flex flex-col gap-1.5 rounded-lg bg-hover/50 px-3 py-2.5 text-body">
          {steps[provider].map((step, i) => (
            <li key={step.text} className="flex gap-2.5">
              <span aria-hidden className="w-3 shrink-0 text-faint-foreground tabular-nums">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                {t(step.text)}
                {step.href && (
                  <>
                    {" "}
                    <a
                      href={step.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-muted-foreground underline hover:text-foreground"
                    >
                      {new URL(step.href).host}
                      <ArrowUpRight aria-hidden className="size-3" />
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
        {provider === "jira" && (
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={`${id}site`} className={fieldLabel}>
                {t("Site")}
              </label>
              <input
                id={`${id}site`}
                name="site"
                required
                placeholder="acme.atlassian.net"
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                className={field}
              />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor={`${id}email`} className={fieldLabel}>
                {t("Email")}
              </label>
              <input
                id={`${id}email`}
                name="email"
                type="email"
                required
                placeholder="you@example.com"
                spellCheck={false}
                autoComplete="off"
                className={field}
              />
            </div>
          </div>
        )}
        <div>
          <label htmlFor={`${id}token`} className={fieldLabel}>
            {provider === "linear" ? t("API key") : t("API token")}
          </label>
          <input
            id={`${id}token`}
            name="token"
            type="password"
            required
            spellCheck={false}
            autoComplete="off"
            className={`${field} font-mono`}
          />
        </div>
        {error && (
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => dialog.current?.close()}>{t("Cancel")}</Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? t("Connecting…") : t("Connect")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
