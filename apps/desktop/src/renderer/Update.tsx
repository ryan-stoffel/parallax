import { Download, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { UpdateState } from "../preload/bridge";
import { IconButton } from "./ui";

/**
 * The sidebar footer's Update button, for an `updatable` app. It shows a download icon with a dot
 * while an update is on offer. In a packaged app that's a newer release: a click opens a popover
 * above the button with its version, notes, and GitHub page, and starts the download, whose
 * progress the popover shows. Once downloaded, a dialog in the middle of the window asks to
 * restart, which installs it; Later leaves it to install on quit, and the button asks again.
 * Under `pnpm dev` it's the commits develop has, and a click takes them, with the answer in the
 * popover. Its label carries the updater's note, such as an error.
 */
export function UpdateButton() {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const restart = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<UpdateState>({});
  useEffect(() => window.parallax.onUpdateState(setState), []);
  // Under `pnpm dev`, "Updating…" while Update runs, then its answer until the next click.
  const [answer, setAnswer] = useState<string>();
  const updating = answer === "Updating…";
  const { available, progress, note } = state;
  // What's on offer is being taken while it updates.
  const ready = updating ? undefined : state.ready;

  // A release that finished downloading asks to restart.
  const downloaded = available !== undefined && ready !== undefined;
  useEffect(() => {
    if (!downloaded) return;
    popover.current?.hidePopover();
    restart.current?.showModal();
  }, [downloaded]);

  const click = async (button: HTMLButtonElement) => {
    if (downloaded) return restart.current?.showModal();
    popover.current?.showPopover({ source: button });
    if (available) return void window.parallax.update();
    setAnswer("Updating…");
    setAnswer(await window.parallax.update());
  };

  const offered = available !== undefined || ready !== undefined;
  const label = ready
    ? `Update ready: ${ready}`
    : available
      ? `Update available: Parallax ${available.version}`
      : (note ?? "Update Parallax");
  return (
    <span className="ml-auto">
      <IconButton
        label={label}
        aria-haspopup="dialog"
        disabled={updating}
        onClick={(e) => void click(e.currentTarget)}
      >
        {offered ? (
          <span className="relative grid">
            <Download />
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent"
            />
          </span>
        ) : (
          <RefreshCw className={updating ? "animate-spin" : undefined} />
        )}
      </IconButton>
      <div
        ref={popover}
        id={id}
        popover="auto"
        aria-label="Update"
        className="inset-auto m-0 mb-2 w-80 rounded-lg border border-border bg-surface p-3 text-foreground shadow-composer [position-area:top_span-left] [position-try-fallbacks:flip-block]"
      >
        {available ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-[13.5px] font-medium">Parallax {available.version}</h2>
              <a href={available.url} className="shrink-0 text-[12px] text-accent hover:underline">
                Full changelog
              </a>
            </div>
            <p className="mt-2 max-h-48 overflow-y-auto text-[12.5px] whitespace-pre-line text-muted-foreground">
              {available.notes || "No notes for this release."}
            </p>
            {progress !== undefined ? (
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-[12px] text-muted-foreground">
                  <span>Downloading…</span>
                  <span>{progress}%</span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Download"
                  aria-valuenow={progress}
                  className="h-1.5 overflow-hidden rounded-full bg-selected"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            ) : (
              note && (
                <p role="alert" className="mt-3 text-[12.5px] text-danger">
                  {note}
                </p>
              )
            )}
          </>
        ) : (
          <p role="status" className="text-[12.5px] text-muted-foreground">
            {answer ?? note ?? "Up to date"}
          </p>
        )}
      </div>
      <dialog
        ref={restart}
        aria-labelledby={`${id}-restart`}
        className="m-auto w-[24rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
      >
        <form
          method="dialog"
          className="px-5 pt-4 pb-4"
          onSubmit={(e) => {
            if ((e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "restart")
              void window.parallax.update();
          }}
        >
          <h2 id={`${id}-restart`} className="text-[15px] font-semibold">
            Restart to update
          </h2>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Parallax {available?.version} is downloaded. Restart to install it, or it installs when
            Parallax quits.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="submit"
              value="later"
              className="rounded-md px-3 py-1.5 text-[13px] hover:bg-hover"
            >
              Later
            </button>
            <button
              type="submit"
              value="restart"
              autoFocus
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-foreground hover:opacity-90"
            >
              Restart
            </button>
          </div>
        </form>
      </dialog>
    </span>
  );
}
