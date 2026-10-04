import { GitFork } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type RefObject,
  type ToggleEvent,
} from "react";

import type { RpcError } from "../preload/bridge";
import type { AgentRun } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { useCatalog, type Model } from "./models";
import { kindOf, logoOf } from "./providers";
import type { ForkChoice } from "./threads";
import { isRunning } from "./transcript";
import { menuItem, menuPanel, moveFocus } from "./ui";

/** plxd's refusal of `thread/fork` (0050), for people. `running` is whether the thread runs now. */
export function forkError(error: RpcError, running: boolean): string {
  switch (error.data?.kind) {
    case "threadNotFound":
      return "This thread isn't on this host anymore.";
    case "idConflict":
      return "That fork's id was already taken. Try again.";
  }
  // invalidParams: a turn that hasn't ended, or one a fork copied from the thread it forked.
  if (error.code === -32602)
    return running
      ? "This turn is still running. Fork it once it finishes."
      : "This turn was copied from another thread. Fork it from that thread.";
  return describeError(error);
}

/** What fork's menu sends to run on `m`: its model, and its instance when that isn't the run's. */
function choiceOf(m: Model, run: AgentRun): ForkChoice {
  return {
    ...(m.id && { model: m.id }),
    ...(m.provider !== run.backend && {
      account: { kind: "subscription", backend: m.provider } as const,
    }),
  };
}

/**
 * Fork's menu (0050): keep the thread's model, or pick another of the host's, which may be another
 * provider's. Choosing one calls `onFork`, which opens the fork, and the menu shows plxd's refusal
 * if it has one. A native popover with `id`, opened by a button naming it or by `showPopover`.
 */
export function ForkMenu({
  id,
  hostId,
  run,
  onFork,
  align = "start",
  ref,
}: {
  id: string;
  hostId: string;
  run: AgentRun;
  onFork: (choice: ForkChoice) => Promise<RpcError | undefined>;
  align?: "start" | "end";
  ref?: RefObject<HTMLDivElement | null>;
}) {
  const catalog = useCatalog(hostId);
  const own = useRef<HTMLDivElement>(null);
  const menu = ref ?? own;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const instance = (p: string) => catalog.instances.find((i) => i.id === p);
  const logo = (p: string) => {
    const found = instance(p);
    return found ? logoOf(found) : kindOf(p).Logo;
  };
  const kept = catalog.models.find((m) => m.provider === run.backend && m.id === (run.model ?? ""));
  const keptName = kept?.name ?? run.model ?? "the current model";
  const others = catalog.models.filter((m) => m !== kept && instance(m.provider)?.enabled);
  const KeptLogo = logo(run.backend);

  const pick = async (choice: ForkChoice) => {
    setBusy(true);
    setError(undefined);
    const failed = await onFork(choice);
    setBusy(false);
    if (failed) setError(forkError(failed, isRunning(run.status)));
    else menu.current?.hidePopover();
  };

  return (
    <div
      ref={menu}
      id={id}
      popover="auto"
      role="menu"
      aria-label="Fork"
      onToggle={(e: ToggleEvent<HTMLDivElement>) => {
        if (e.newState === "open")
          e.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        else setError(undefined);
      }}
      onKeyDown={moveFocus}
      className={`${menuPanel(align)} w-64 p-1 text-[13px]`}
    >
      <p className="px-2 pt-1 pb-1.5 text-[11.5px] font-medium text-faint-foreground">
        Fork into a new thread
      </p>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => void pick({})}
        className={`${menuItem} disabled:opacity-50`}
      >
        <KeptLogo aria-hidden />
        <span className="truncate">Keep {keptName}</span>
      </button>
      {others.length > 0 && (
        <>
          <div className="my-1 h-px bg-border" />
          <p className="px-2 pt-0.5 pb-1 text-[11.5px] font-medium text-faint-foreground">
            Or pick another model
          </p>
          <div className="max-h-56 overflow-y-auto">
            {others.map((m) => {
              const Logo = logo(m.provider);
              // Two providers can offer a model of the same name.
              const where = instance(m.provider)?.name ?? m.provider;
              return (
                <button
                  key={`${m.provider}/${m.id}`}
                  type="button"
                  role="menuitem"
                  aria-label={`${m.name} (${where})`}
                  disabled={busy}
                  onClick={() => void pick(choiceOf(m, run))}
                  className={`${menuItem} disabled:opacity-50`}
                >
                  <Logo aria-hidden />
                  <span className="truncate">{m.name}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-faint-foreground">
                    {where}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** The run a transcript's Fork buttons fork, on its host, and what forks it at a turn. */
export interface ForkTarget {
  hostId: string;
  run: AgentRun;
  onFork: (turnId: string, choice: ForkChoice) => Promise<RpcError | undefined>;
}

/** Set by a thread's chat, so its messages offer Fork; a Project's chats leave it unset. */
export const ForkContext = createContext<ForkTarget | undefined>(undefined);

/**
 * Fork in a message's hover row, beside Copy: forks at that message's turn, `turnId`, or with
 * none, the run's prompt's turn, which plxd names by the run's id (0050).
 */
export function ForkButton({ turnId }: { turnId?: string }) {
  const target = useContext(ForkContext);
  const id = useId();
  if (!target) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Fork from here"
        title="Fork from here"
        popoverTarget={id}
        className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
      >
        <GitFork />
      </button>
      <ForkMenu
        id={id}
        hostId={target.hostId}
        run={target.run}
        onFork={(choice) => target.onFork(turnId ?? target.run.id, choice)}
        align="end"
      />
    </>
  );
}
