import {
  ArrowUp,
  File,
  FilePen,
  ListChecks,
  LoaderCircle,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import type { AgentEffort, AgentPermission, AgentRun } from "../protocol/generated/protocol";
import { EffortMenu } from "./EffortMenu";
import { ModelMenu } from "./ModelMenu";
import { backends, models, type Model, type RunOptions } from "./models";
import { Picker, type PickerOption } from "./ui";

// The permissions wispd takes (RYA-97), all inside the worker sandbox (0013). Asking first and
// leaving the sandbox wait on RYA-125. Plan isn't read-only: its commands can still write.
const accessOptions: Record<AgentPermission, PickerOption> = {
  edit: {
    value: "edit",
    label: "Edit",
    icon: <FilePen />,
    description: "Edits files and runs commands in its sandbox without stopping to ask.",
  },
  plan: {
    value: "plan",
    label: "Plan",
    icon: <ListChecks />,
    description:
      "Writes a plan instead of editing. Its file tools can't change files, but its commands still can.",
  },
};

const divider = <span aria-hidden className="mx-1 h-5 w-px bg-border" />;

/** A plain item in the composer's tab, sized like the pickers that can sit beside it. */
export const tabItem =
  "flex min-w-0 items-center gap-1.5 px-2 py-1 text-[13.5px] text-muted-foreground [&_svg]:size-4 [&_svg]:shrink-0";

export interface ComposerProps {
  /** Whether it starts a new thread, which only changes its hint. */
  newThread?: boolean;
  /**
   * Sends the text, with the chosen run options (empty without `backend`). Resolves to an error
   * message, which puts the text back; `""` puts it back with no message. Absent: Send stays off.
   */
  onSend?: (text: string, options: RunOptions) => Promise<string | undefined>;
  /**
   * While set, an empty box shows Stop instead of Send. Resolves to an error message.
   * Stop stays pending until the caller drops `onStop`, when the run stops.
   */
  onStop?: () => Promise<string | undefined>;
  /** Why sending is off right now, shown in place of the box's hint. */
  disabledReason?: string;
  /** The tab tucked under the box: where the thread runs, or an open run's status. */
  tab?: ReactNode;
  /** What goes under the tab, such as a new thread's account chooser. */
  footer?: ReactNode;
  /**
   * The backend the thread runs on: shows the model, effort, and access choices it can honor. A
   * new thread passes it only when wispd takes run options. Absent (or unknown): no choices, and
   * none are sent.
   */
  backend?: string;
  /**
   * An open run's model, effort, and access (an unset one is the CLI's default). They start from
   * the run's, and only one that differs from it is sent. Its model can change only within its
   * provider, since a session can't move to another CLI.
   */
  started?: Pick<AgentRun, "model" | "effort" | "permission">;
  /** A no-write run, such as a Project's coordinator (0024): its access is fixed, so none is offered or sent. */
  noWrite?: boolean;
  /** Why the model, effort, and access can't change right now, which turns them off. */
  optionsDisabled?: string;
}

/** The prompt box, the same on every screen. Enter sends and Shift+Enter starts a new line. */
export function Composer({
  newThread,
  onSend,
  onStop,
  disabledReason,
  tab,
  footer,
  backend,
  started,
  noWrite,
  optionsDisabled,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  // Files picked with the paperclip. Shown as chips; wispd doesn't take attachments yet.
  const [files, setFiles] = useState<File[]>([]);
  const filePicker = useRef<HTMLInputElement>(null);
  const [pickedModel, setModel] = useState<Model>();
  const [pickedEffort, setEffort] = useState<AgentEffort>();
  const [pickedPermission, setPermission] = useState<AgentPermission>();
  // What `backend` can honor: another backend's pick falls back to its first model and `edit`.
  const run = backend === undefined ? undefined : backends[backend];
  const permissions = noWrite ? [] : (run?.permissions ?? []);
  const runModels = models.filter((m) => m.provider === run?.provider);
  // An open run's model, which may be one this list doesn't know, or the CLI's default.
  const startedModel =
    started &&
    run &&
    (runModels.find((m) => m.id === started.model) ?? {
      id: started.model ?? "",
      name: started.model ?? "Default model",
      provider: run.provider,
    });
  const model = runModels.find((m) => m === pickedModel) ?? startedModel ?? runModels[0];
  const startedEffort = started?.effort ?? "high";
  const startedPermission = started?.permission ?? "edit";
  const effort = pickedEffort ?? startedEffort;
  const wanted = pickedPermission ?? startedPermission;
  const permission = permissions.includes(wanted) ? wanted : "edit";
  let options: RunOptions = {};
  if (run && started)
    options = {
      ...(model && model !== startedModel && { model: model.id }),
      ...(effort !== startedEffort && { effort }),
      ...(permission !== startedPermission && { permission }),
    };
  else if (run)
    options = { ...(model && { model: model.id }), effort, ...(!noWrite && { permission }) };
  // The run stopped (or never ran), so a later run's Stop starts fresh.
  if (stopping && !onStop) setStopping(false);
  const canSend = !!onSend && !disabledReason && text.trim() !== "";
  const showStop = !!onStop && !disabledReason && text.trim() === "";

  const submit = async () => {
    if (!canSend) return;
    setText("");
    setError(undefined);
    const failed = await onSend(text, options);
    if (failed === undefined) setFiles([]);
    else {
      // Put it back ahead of anything typed while it was in flight.
      setText((typed) => (typed ? `${text}\n\n${typed}` : text));
      setError(failed);
    }
  };

  const stop = async () => {
    setStopping(true);
    setError(undefined);
    const failed = await onStop?.();
    if (failed) {
      setStopping(false);
      setError(failed);
    }
  };

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="relative z-10 rounded-3xl border border-border bg-surface shadow-composer focus-within:border-ring"
      >
        <label htmlFor="composer-input" className="sr-only">
          Message
        </label>
        <textarea
          id="composer-input"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void submit();
          }}
          placeholder={
            disabledReason ??
            (newThread
              ? "Describe a change, paste an error, or drop in a plan"
              : "Reply, add detail, or steer what it does next")
          }
          className="block w-full resize-none bg-transparent px-5 pt-4.5 text-[15px] leading-relaxed placeholder:text-faint-foreground focus-visible:outline-none"
        />
        {files.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
            {files.map((f, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 rounded-lg bg-selected py-1 pr-1 pl-2 text-[12.5px]"
              >
                <File aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="max-w-48 truncate">{f.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}
                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-hover hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <span className="text-[12px] text-faint-foreground">Not sent to the agent yet</span>
          </div>
        )}
        <div className="flex items-center gap-0.5 px-3 pt-1 pb-3">
          {run && (
            <>
              {/* A disabled fieldset turns off every control in it, and its title says why. */}
              <fieldset
                disabled={!!optionsDisabled}
                title={optionsDisabled}
                className="flex min-w-0 items-center gap-0.5"
              >
                {model && (
                  <>
                    {/* An open run lists every provider, and can pick only its own. */}
                    <ModelMenu
                      key={backend}
                      models={started ? models : runModels}
                      provider={started && run.provider}
                      value={model}
                      onChange={setModel}
                    />
                    {divider}
                  </>
                )}
                <EffortMenu value={effort} onChange={setEffort} />
                {/* One permission is no choice, so there's nothing to show. */}
                {permissions.length > 1 && (
                  <>
                    {divider}
                    <Picker
                      label="Access"
                      value={permission}
                      onChange={(value) => setPermission(value as AgentPermission)}
                      options={permissions.map((p) => accessOptions[p])}
                      panelClassName="w-[25rem]"
                    />
                  </>
                )}
              </fieldset>
            </>
          )}
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              setFiles((all) => [...all, ...picked]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => filePicker.current?.click()}
            className="mr-1.5 ml-auto grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4.5"
          >
            <Paperclip />
          </button>
          {showStop ? (
            <button
              type="button"
              aria-label={stopping ? "Stopping" : "Stop"}
              disabled={stopping}
              onClick={() => void stop()}
              className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
            >
              {stopping ? (
                <LoaderCircle className="size-4.5 animate-spin" />
              ) : (
                <Square className="size-3.5 fill-current" />
              )}
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              disabled={!canSend}
              className="grid size-9 place-items-center rounded-full bg-send text-send-foreground disabled:opacity-25"
            >
              <ArrowUp className="size-4.5" />
            </button>
          )}
        </div>
      </form>
      {tab && (
        // Tucked under the box, so what it shows reads as part of it.
        <div className="mx-5 -mt-4 flex min-w-0 items-center justify-between gap-2 rounded-b-3xl border border-t-0 border-border bg-surface px-3 pt-5 pb-1.5">
          {tab}
        </div>
      )}
      {error && (
        <p role="alert" className="px-2 pt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      {footer}
    </div>
  );
}
