import { t } from "i18next";
import { CircleCheck, CircleX, MonitorUp, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { RendererMethod } from "../preload/bridge";
import type { ParallaxRequests, Repo } from "../protocol/generated/protocol";
import { statusLabel, useShownConnections } from "./ConnectionStatus";
import { DeviceIcon } from "./DeviceIcon";
import { describeError } from "./errors";
import { type Host, useHosts } from "./hosts";
import { Footer, Working } from "./MoveRemoteControl";
import { primaryButton, quietButton } from "./settings/parts";
import { IconButton } from "./ui";

type Step =
  | { kind: "pick" }
  | { kind: "moving"; where: string; what: string }
  | { kind: "done"; hostId: string; threadId: string; where: string }
  | { kind: "failed"; why: string };

/** A plxd call's result, or its error described, thrown. */
async function call<M extends RendererMethod>(
  hostId: string,
  method: M,
  params: ParallaxRequests[M]["params"],
): Promise<ParallaxRequests[M]["result"]> {
  const answer = await window.parallax.request(hostId, method, params);
  if ("error" in answer) throw new Error(describeError(answer.error));
  return answer.result;
}

/**
 * Moves a thread to another of the user's computers (PLX-1538), a modal dialog open while it's
 * mounted. It lists the other connected computers whose plxd takes a moved thread (`threadMove`).
 * Moving one exports the thread here. For a thread in a repository, the other computer finds its
 * own copy of the repository by `origin`, then this one pushes its branch, which the other fetches. The other
 * computer then receives the thread, in a new worktree from that branch, and this one is archived.
 * Its first message there tells a new session the conversation (0014).
 */
export function MoveThread({
  hostId,
  runId,
  title,
  repo,
  onClose,
  onOpen,
}: {
  /** The thread's host and run. */
  hostId: string;
  runId: string;
  title: string;
  /** Its repo entry, absent or scratch for a thread with no repo. */
  repo?: Repo;
  onClose: () => void;
  /** Opens the moved thread. */
  onOpen: (hostId: string, threadId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const live = useRef(true);
  const hosts = useHosts().filter((h) => h.id !== hostId);
  const states = useShownConnections(hosts.map((h) => h.id));

  useEffect(() => {
    live.current = true;
    dialog.current?.showModal();
    return () => {
      live.current = false;
    };
  }, []);

  const close = () => dialog.current?.close();
  const show = (next: Step) => {
    if (live.current) setStep(next);
  };

  const move = async (target: Host) => {
    const where = target.name;
    const doing = (what: string) => show({ kind: "moving", where, what });
    try {
      doing(t("Reading the thread"));
      const thread = await call(hostId, "thread/export", { runId });
      let place: { repo: string; base: string } | undefined;
      if (repo && !repo.scratch) {
        const status = await call(hostId, "agent/gitStatus", { runId });
        if (status.changes)
          throw new Error(t("It has uncommitted changes. Commit or discard them, then move it."));
        if (!status.branch) throw new Error(t("Its folder has no branch checked out to move."));
        const { url } = await call(hostId, "repo/remote", { repo: repo.id });
        if (!url)
          throw new Error(t("{{repo}} has no origin to move through.", { repo: repo.name }));
        // Found before anything is pushed, so a refusal leaves nothing behind.
        doing(t("Finding the repository on {{computer}}", { computer: where }));
        const found = (await call(target.id, "repo/match", { origin: url })).repo;
        if (!found)
          throw new Error(
            t("{{computer}} doesn't have this repository. Clone it there, then move it.", {
              computer: where,
            }),
          );
        doing(t("Pushing its branch"));
        await call(hostId, "agent/push", { runId });
        // The commit it pushed, to check the other computer fetched it and not an older one.
        const { commit } = await call(hostId, "repo/fetchBase", {
          repo: repo.id,
          base: `refs/heads/${status.branch}`,
        });
        const base = `origin/${status.branch}`;
        const fetched = await call(target.id, "repo/fetchBase", { repo: found.id, base });
        if (fetched.commit !== commit)
          throw new Error(
            t("{{computer}} couldn't fetch {{branch}}. Check it's online, then try again.", {
              computer: where,
              branch: status.branch,
            }),
          );
        place = { repo: found.id, base };
      }
      doing(t("Moving the conversation"));
      const moved = await call(target.id, "thread/receive", { thread, ...place });
      doing(t("Archiving it here"));
      await call(hostId, "thread/archive", { runId, archived: true });
      show({ kind: "done", hostId: target.id, threadId: moved.thread.id, where });
    } catch (error) {
      show({ kind: "failed", why: error instanceof Error ? error.message : String(error) });
    }
  };

  const heading: Record<Step["kind"], [string, string]> = {
    pick: [
      t("Move to another computer"),
      t("{{title}} continues on the computer you pick.", { title }),
    ],
    moving: [
      step.kind === "moving" ? t("Moving to {{computer}}", { computer: step.where }) : "",
      t("Then it continues there."),
    ],
    done: [
      step.kind === "done" ? t("Moved to {{computer}}", { computer: step.where }) : "",
      t("It's archived here."),
    ],
    failed: [t("Couldn't move it"), t("Try again picks up where it stopped.")],
  };
  const [heading1, line] = heading[step.kind];

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[90vh] w-[34rem] max-w-[94vw] rounded-xl border border-border bg-background text-foreground shadow-composer backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[90vh] flex-col">
        <header className="flex items-start gap-3 px-6 pt-5 pb-4">
          <span
            className={`grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-surface [&_svg]:size-4.5 ${step.kind === "done" ? "text-added" : "text-muted-foreground"}`}
          >
            {step.kind === "done" ? <CircleCheck aria-hidden /> : <MonitorUp aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-heading font-semibold tracking-tight">
              {heading1}
            </h2>
            <p className="mt-0.5 truncate text-body text-muted-foreground">{line}</p>
          </div>
          <IconButton label={t("Close")} onClick={close}>
            <X aria-hidden />
          </IconButton>
        </header>

        {step.kind === "pick" &&
          (hosts.length ? (
            <ul
              aria-label={t("Your computers")}
              className="mx-6 mb-5 min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-1"
            >
              {hosts.map((host, i) => {
                const state = states[i];
                const ready = state?.status === "connected" && "threadMove" in state.capabilities;
                const status =
                  state?.status === "connected"
                    ? ready
                      ? t("Connected")
                      : t("Update Parallax there to move threads to it")
                    : state
                      ? statusLabel(state)
                      : t("Connecting…");
                return (
                  <li key={host.id} className="flex items-center gap-3 rounded-lg px-2.5 py-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-background">
                      <DeviceIcon
                        icon={host.icon ?? "laptop"}
                        className="size-4 text-muted-foreground"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium">{host.name}</span>
                      <span className="block truncate text-meta text-faint-foreground">
                        {status}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={!ready}
                      className={primaryButton}
                      onClick={() => void move(host)}
                    >
                      {t("Move here")}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mx-6 mb-5 rounded-xl border border-border bg-surface px-4 py-3 text-body text-muted-foreground">
              {t("No other computers yet. Add one in Settings > Computers.")}
            </p>
          ))}

        {step.kind === "moving" && <Working>{step.what}</Working>}

        {step.kind === "done" && (
          <Footer>
            <button
              type="button"
              className={primaryButton}
              onClick={() => {
                onOpen(step.hostId, step.threadId);
                close();
              }}
            >
              {t("Open thread")}
            </button>
          </Footer>
        )}

        {step.kind === "failed" && (
          <>
            <p
              role="alert"
              className="mx-6 mb-5 flex items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-body [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0"
            >
              <CircleX aria-hidden className="text-danger" />
              {step.why}
            </p>
            <Footer>
              <button type="button" className={quietButton} onClick={close}>
                {t("Close")}
              </button>
              <button
                type="button"
                className={primaryButton}
                onClick={() => show({ kind: "pick" })}
              >
                {t("Try again")}
              </button>
            </Footer>
          </>
        )}
      </div>
    </dialog>
  );
}
