import { t } from "i18next";
import { AppWindowMac, Eye, LoaderCircle, MousePointerClick, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentType, type SVGProps } from "react";
import { Trans } from "react-i18next";

import type { ComputerStatus } from "../../protocol/generated/protocol";
import { statusLabel, useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId } from "../hosts";
import { notify } from "../notifications";
import { PageTitle, primaryButton, quietButton, Section, settingRow, StatusDot } from "./parts";

/** How often the permissions are read while macOS's settings may be changing them. */
const POLL_MS = 2000;

/**
 * Settings > Computer use (PLX-897): whether plxd on this Mac has the Accessibility and Screen
 * Recording permissions that agents' `computer_*` tools need, a button that asks macOS for them,
 * and the apps every thread may use without asking, each with Remove. Only a plxd on macOS has
 * `computerUse`.
 */
export function ComputerSettings() {
  const connection = useShownConnection(localId);
  const connected = connection?.status === "connected";
  const supported = connected && "computerUse" in connection.capabilities;
  const connectedNow = useConnectedNow(localId);
  const [status, setStatus] = useState<ComputerStatus>();
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);

  const load = useCallback(async (request = false) => {
    const answer = await window.parallax.request(localId, "computer/status", { request });
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setStatus(answer.result);
      setError(undefined);
    }
  }, []);
  useEffect(() => {
    if (supported && connectedNow) void load();
  }, [supported, connectedNow, load]);
  // Turned on in System Settings, a permission shows here without a refresh.
  const missing = !!status && !(status.accessibility && status.screenRecording);
  useEffect(() => {
    if (!missing) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [missing, load]);

  const grant = async () => {
    setAsking(true);
    await load(true);
    setAsking(false);
  };
  const remove = async (app: string) => {
    const answer = await window.parallax.request(localId, "computer/forget", { app });
    if ("error" in answer)
      notify({
        tone: "error",
        title: t("Couldn't remove {{name}}", { name: app }),
        body: describeError(answer.error),
      });
    else setStatus(answer.result);
  };

  const unavailable = !connected
    ? connection
      ? statusLabel(connection)
      : t("Connecting…")
    : !supported
      ? t("Computer use needs plxd on macOS. Update Parallax, or use a Mac, to turn it on.")
      : undefined;

  return (
    <>
      <PageTitle title={t("Computer use")}>
        {t(
          "Agents can see and operate the apps on this Mac: read a window, click, type, scroll, and press keys, while your pointer and keyboard stay yours. A thread asks before it first uses each app.",
        )}
      </PageTitle>
      {unavailable ? (
        <Section title={t("Permissions")}>
          <div className={settingRow}>
            <span className="text-body text-muted-foreground">{unavailable}</span>
          </div>
        </Section>
      ) : (
        <>
          <Section
            title={t("Permissions")}
            action={
              missing && (
                <button
                  type="button"
                  className={`${primaryButton} flex items-center gap-1.5 [&_svg]:size-3.5`}
                  disabled={asking}
                  onClick={() => void grant()}
                >
                  {asking && <LoaderCircle aria-hidden className="animate-spin" />}
                  {t("Grant access")}
                </button>
              )
            }
          >
            <Permission
              Icon={MousePointerClick}
              title={t("Accessibility")}
              description={t("Reads app windows, and clicks, types, and scrolls in them.")}
              granted={status?.accessibility}
            />
            <Permission
              Icon={Eye}
              title={t("Screen Recording")}
              description={t("Takes a screenshot of the window an agent works in.")}
              granted={status?.screenRecording}
            />
            {error && (
              <div className={settingRow}>
                <span role="alert" className="text-body text-danger">
                  {error}
                </span>
              </div>
            )}
          </Section>
          {missing && status && (
            <p className="-mt-6 mb-8 px-1 text-meta leading-relaxed text-faint-foreground">
              <Trans values={{ program: status.program }}>
                macOS lists Parallax's background service as{" "}
                <span className="font-mono text-muted-foreground">{"{{program}}"}</span> under
                Privacy & Security. Turn it on there for each permission.
              </Trans>
            </p>
          )}
          <Section title={t("Always allowed")}>
            {!status ? (
              <div className={settingRow}>
                <span className="text-body text-muted-foreground">{t("Checking…")}</span>
              </div>
            ) : status.apps.length === 0 ? (
              <div className={settingRow}>
                <span className="text-body text-muted-foreground">
                  {t(
                    "No apps yet. When a thread asks to use an app, choose Always allow to add it here.",
                  )}
                </span>
              </div>
            ) : (
              status.apps.map((app) => (
                <div key={app} className={settingRow}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <AppWindowMac aria-hidden className="size-4 shrink-0 text-faint-foreground" />
                    <span className="truncate text-body">{app}</span>
                  </span>
                  <button
                    type="button"
                    className={quietButton}
                    aria-label={t("Remove {{name}}", { name: app })}
                    onClick={() => void remove(app)}
                  >
                    {t("Remove")}
                  </button>
                </div>
              ))
            )}
          </Section>
          <p className="flex items-start gap-2 px-1 text-meta leading-relaxed text-faint-foreground">
            <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {t(
              "Computer use never controls terminals, script runners, Parallax itself, or Keychain Access, and agents are told not to type passwords, pay, or send messages unless you ask.",
            )}
          </p>
        </>
      )}
    </>
  );
}

function Permission({
  Icon,
  title,
  description,
  granted,
}: {
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  granted?: boolean;
}) {
  return (
    <div className={settingRow}>
      <div className="flex min-w-0 items-start gap-3">
        <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-faint-foreground" />
        <div className="min-w-0">
          <span className="block text-body font-medium">{title}</span>
          <span className="block text-meta text-muted-foreground">{description}</span>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 text-body text-muted-foreground">
        {granted === undefined ? (
          t("Checking…")
        ) : (
          <>
            <StatusDot tone={granted ? "on" : "off"} />
            {granted ? t("On") : t("Off")}
          </>
        )}
      </span>
    </div>
  );
}
