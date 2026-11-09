import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";

import { icons } from "./icons";
import { ParallaxMark } from "./logos";
import { Button } from "./ui";

/**
 * Around the app: a render that throws shows the crash screen with Reload, instead of an empty
 * window (PLX-1482).
 */
export class CrashBoundary extends Component<{ children: ReactNode }, { details?: string }> {
  override state: { details?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { details: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Parallax's window crashed", error, info.componentStack);
  }

  override render() {
    return this.state.details === undefined ? (
      this.props.children
    ) : (
      <CrashScreen
        title="Parallax hit a problem"
        message="This window stopped working. Your threads are saved, and running agents keep going. Reload to pick up where you left off."
        details={this.state.details}
        action={{ label: "Reload", onClick: () => window.location.reload() }}
      />
    );
  }
}

/**
 * The whole window when something fails (PLX-1482): what happened in plain words, one action to
 * recover, Copy error, and the technical text folded under Error details. `onDismiss` adds
 * Continue anyway, for a failure the rest of the app can work around.
 */
export function CrashScreen({
  title,
  message,
  details,
  action,
  onDismiss,
}: {
  title: string;
  message: string;
  details: string;
  action: { label: string; onClick: () => void };
  onDismiss?: () => void;
}) {
  const [version, setVersion] = useState<string>();
  const [copied, setCopied] = useState(false);
  // A modal dialog, so the app under it is inert and focus starts on the action and stays here.
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  useEffect(() => {
    void window.parallax
      .version()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const copy = () =>
    void navigator.clipboard
      .writeText([title, details, version && `Parallax ${version}`].filter(Boolean).join("\n\n"))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
  return (
    // Opaque, as the splash is, since index.css thins `.bg-background` in a clear window. Escape
    // is Continue anyway where there is one. Chromium lets Escape close a modal whatever its
    // cancel handler does after the first time, so a close with nothing to continue to reopens it.
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-labelledby="crash-title"
      aria-describedby="crash-message"
      onClose={() => (onDismiss ? onDismiss() : dialog.current?.showModal())}
      className="m-0 h-full max-h-none w-full max-w-none flex-col border-0 bg-[var(--background)] p-0 text-foreground backdrop:bg-transparent open:flex"
    >
      {/* Something to drag the window by, since the page draws the title bar. */}
      <div className="titlebar h-11 shrink-0" />
      <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 pb-16">
        <div className="w-full max-w-md motion-safe:animate-[sidebar-rise_240ms_ease-out]">
          <div className="relative size-12">
            <ParallaxMark className="size-12" />
            <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-danger text-danger-foreground ring-[3px] ring-[var(--background)]">
              <icons.warning aria-hidden className="size-3" strokeWidth={2.5} />
            </span>
          </div>
          <h1 id="crash-title" className="mt-6 text-display font-semibold tracking-tight">
            {title}
          </h1>
          <p id="crash-message" className="mt-2 text-reading leading-relaxed text-muted-foreground">
            {message}
          </p>
          <div className="mt-7 flex items-center gap-2">
            <Button variant="primary" onClick={action.onClick}>
              <icons.refresh aria-hidden />
              {action.label}
            </Button>
            <Button variant="outline" onClick={copy}>
              {copied ? <icons.done aria-hidden /> : <icons.copy aria-hidden />}
              {copied ? "Copied" : "Copy error"}
            </Button>
            {onDismiss && (
              <Button className="ml-auto" onClick={onDismiss}>
                Continue anyway
              </Button>
            )}
          </div>
          <details className="group mt-8 overflow-hidden rounded-xl bg-surface ring-1 ring-border">
            <summary className="flex cursor-default list-none items-center justify-between px-3.5 py-2.5 text-meta font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              Error details
              <icons.expand
                aria-hidden
                className="size-3.5 transition-transform group-open:rotate-180"
              />
            </summary>
            <pre className="max-h-56 overflow-auto border-t border-border px-3.5 py-3 text-caption [font-variant-ligatures:none] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
              {details}
            </pre>
          </details>
          {version && <p className="mt-4 text-caption text-faint-foreground">Parallax {version}</p>}
        </div>
      </main>
    </dialog>
  );
}
