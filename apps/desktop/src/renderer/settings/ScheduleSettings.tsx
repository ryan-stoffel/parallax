import { useCallback, useEffect, useState } from "react";

import type { Schedule, ScheduledTask } from "../../protocol/generated/protocol";
import { useConnection } from "../ConnectionStatus";
import { describeError } from "../errors";
import { localId, useHosts } from "../hosts";
import { HostPicker, PageTitle, quietButton, Row, Section, Switch } from "./parts";

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A trigger in a few words, as T3 Code's `scheduleLabel`: "Every 60 min", "Weekdays at 09:00". */
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => weekdayNames[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/** When a task runs next, from `now`: "in 5m", "in 3h", "in 2d". */
export function nextLabel(at: string, now = Date.now()): string {
  const minutes = Math.ceil((new Date(at).getTime() - now) / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

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
    if ("error" in answer) setError(describeError(answer.error));
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
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">{empty}</p>
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
                    <span className="block text-[11.5px]">
                      {scheduleLabel(task.schedule)} · {when}
                      {last}
                    </span>
                    {task.webhook && (
                      <span
                        className="block truncate font-mono text-[11.5px]"
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
          <p role="alert" className="px-4 py-3 text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </Section>
    </>
  );
}
