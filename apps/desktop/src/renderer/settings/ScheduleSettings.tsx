import { t } from "i18next";
import { useCallback, useEffect, useState } from "react";

import type { ScheduledTask } from "../../protocol/generated/protocol";
import { useConnectedNow, useShownConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { useHosts, type Host } from "../hosts";
import { notify } from "../notifications";
import {
  allHosts,
  HostPicker,
  hostsOf,
  ListHeading,
  PageTitle,
  quietButton,
  Row,
  Section,
  Switch,
} from "./parts";
import { nextLabel, scheduleLabel } from "./shared";

/**
 * Settings > Schedules: every computer's scheduled tasks (0063), or the one picked's, which agents
 * create with `schedule_task`. Each can be paused, run now, or deleted.
 */
export function ScheduleSettings() {
  const hosts = useHosts();
  const [scope, setScope] = useState(allHosts);
  const targets = hostsOf(hosts, scope);
  return (
    <>
      <PageTitle title={t("Schedules")}>
        {t("Prompts that run on a timer or a webhook, in their thread or a new one.")}
      </PageTitle>
      <Section
        title={t("Scheduled tasks")}
        action={<HostPicker hosts={hosts} value={scope} onChange={setScope} all />}
      >
        {targets.map((host) => (
          <HostTasks key={host.id} host={host} named={targets.length > 1} />
        ))}
      </Section>
    </>
  );
}

/** One computer's tasks, under its name where `named`. */
export function HostTasks({ host, named }: { host: Host; named: boolean }) {
  const hostId = host.id;
  const connection = useShownConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "schedules" in connection.capabilities;
  const connectedNow = useConnectedNow(hostId);
  const [tasks, setTasks] = useState<ScheduledTask[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    const answer = await window.parallax.request(hostId, "schedule/list", {});
    if ("error" in answer) setError(describeError(answer.error));
    else {
      setTasks(answer.result.tasks);
      setError(undefined);
    }
  }, [hostId]);
  useEffect(() => {
    setTasks(undefined);
    setError(undefined);
  }, [supported, hostId]);
  useEffect(() => {
    if (supported && connectedNow) void load();
  }, [supported, connectedNow, load]);

  const act = async (task: ScheduledTask, action: "pause" | "run" | "delete") => {
    setBusy(task.id);
    const answer =
      action === "run"
        ? await window.parallax.request(hostId, "schedule/run", { id: task.id })
        : action === "delete"
          ? await window.parallax.request(hostId, "schedule/delete", { id: task.id })
          : await window.parallax.request(hostId, "schedule/save", {
              id: task.id,
              title: task.title,
              prompt: task.prompt,
              enabled: !task.enabled,
              schedule: task.schedule,
              thread: task.thread,
              orchestrator: task.orchestrator,
              repo: task.repo,
              account: task.account,
              model: task.model,
              effort: task.effort,
              permission: task.permission,
            });
    setBusy(undefined);
    if ("error" in answer) {
      const values = { title: task.title };
      notify({
        tone: "error",
        title:
          action === "run"
            ? t("Couldn't run {{title}}", values)
            : action === "delete"
              ? t("Couldn't delete {{title}}", values)
              : task.enabled
                ? t("Couldn't pause {{title}}", values)
                : t("Couldn't resume {{title}}", values),
        body: describeError(answer.error),
      });
    }
    void load();
  };

  const empty = !connected
    ? t("Not connected")
    : !supported
      ? t("This host's plxd can't schedule tasks.")
      : error && !tasks
        ? error
        : tasks === undefined
          ? t("Loading…")
          : tasks.length === 0
            ? t("No scheduled tasks. Ask an agent to schedule one.")
            : undefined;
  return (
    <>
      {named && <ListHeading>{host.name}</ListHeading>}
      {empty ? (
        <p className="px-4 py-3 text-body text-muted-foreground">{empty}</p>
      ) : (
        tasks?.map((task) => {
          const when = !task.enabled
            ? t("Paused")
            : task.schedule.type === "webhook"
              ? t("Listening")
              : task.nextRunAt
                ? t("Next run {{when}}", { when: nextLabel(task.nextRunAt) })
                : t("Not scheduled");
          const lastRun = {
            never: "",
            running: t("Last run running"),
            succeeded: t("Last run succeeded"),
            failed: t("Last run failed"),
          }[task.lastRunStatus];
          const last = lastRun
            ? ` · ${lastRun}${task.lastRunError ? `: ${task.lastRunError}` : ""}`
            : "";
          return (
            <Row
              key={task.id}
              title={task.title}
              description={
                <>
                  <span className="line-clamp-2">{task.prompt}</span>
                  <span className="block text-meta">
                    {scheduleLabel(task.schedule)} · {when}
                    {last}
                  </span>
                  {task.webhook && (
                    <span
                      className="block truncate font-mono text-meta"
                      title={task.webhook.url ?? task.webhook.path}
                    >
                      {task.webhook.url ?? task.webhook.path}
                    </span>
                  )}
                </>
              }
            >
              <Switch
                label={t("Enable {{title}}", { title: task.title })}
                checked={task.enabled}
                disabled={busy === task.id}
                onChange={() => void act(task, "pause")}
              />
              {task.schedule.type !== "webhook" && (
                <button
                  type="button"
                  className={quietButton}
                  disabled={busy === task.id}
                  onClick={() => void act(task, "run")}
                >
                  {t("Run now")}
                </button>
              )}
              <button
                type="button"
                className={quietButton}
                disabled={busy === task.id}
                onClick={() => void act(task, "delete")}
              >
                {t("Delete")}
              </button>
            </Row>
          );
        })
      )}
      {error && tasks && (
        <p role="alert" className="px-4 py-3 text-body text-danger">
          {error}
        </p>
      )}
    </>
  );
}
