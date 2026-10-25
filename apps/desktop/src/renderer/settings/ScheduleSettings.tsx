import { useCallback, useEffect, useState } from "react";

import type { ScheduledTask } from "../../protocol/generated/protocol";
import { useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts } from "../hosts";
import { notify } from "../notifications";
import { HostPicker, PageTitle, quietButton, Row, Section, Switch } from "./parts";
import { nextLabel, scheduleLabel } from "./shared";

export { nextLabel, scheduleLabel };

/**
 * Settings > Schedules: a host's scheduled tasks (0063), which agents create with
 * `schedule_task`. Each can be paused, run now, or deleted.
 */
export function ScheduleSettings() {
  const hosts = useHosts();
  const [hostId, setHostId] = useState(localId);
  const connection = useConnection(hostId);
  const connected = connection?.status === "connected";
  const supported = connected && "schedules" in connection.capabilities;
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
    if (supported) void load();
  }, [supported, load]);

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
              project: task.project,
              repo: task.repo,
              account: task.account,
              model: task.model,
              effort: task.effort,
              permission: task.permission,
            });
    setBusy(undefined);
    if ("error" in answer) {
      const verb = action === "pause" ? (task.enabled ? "pause" : "resume") : action;
      notify({
        tone: "error",
        title: `Couldn't ${verb} ${task.title}`,
        body: describeError(answer.error),
      });
    }
    void load();
  };

  const empty = !connected
    ? "Not connected"
    : !supported
      ? "This host's plxd can't schedule tasks."
      : error && !tasks
        ? error
        : tasks === undefined
          ? "Loading…"
          : tasks.length === 0
            ? "No scheduled tasks. Ask an agent to schedule one."
            : undefined;
  return (
    <>
      <PageTitle title="Schedules">
        Prompts that run on a timer or a webhook, in their thread or a new one.
      </PageTitle>
      <Section
        title="Scheduled tasks"
        action={<HostPicker hosts={hosts} value={hostId} onChange={setHostId} />}
      >
        {empty ? (
          <p className="px-4 py-3 text-body text-muted-foreground">{empty}</p>
        ) : (
          tasks?.map((task) => {
            const when = !task.enabled
              ? "Paused"
              : task.schedule.type === "webhook"
                ? "Listening"
                : task.nextRunAt
                  ? `Next run ${nextLabel(task.nextRunAt)}`
                  : "Not scheduled";
            const last =
              task.lastRunStatus === "never"
                ? ""
                : ` · Last run ${task.lastRunStatus}${task.lastRunError ? `: ${task.lastRunError}` : ""}`;
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
                  label={`Enable ${task.title}`}
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
                    Run now
                  </button>
                )}
                <button
                  type="button"
                  className={quietButton}
                  disabled={busy === task.id}
                  onClick={() => void act(task, "delete")}
                >
                  Delete
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
      </Section>
    </>
  );
}
