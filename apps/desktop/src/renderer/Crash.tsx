import { t } from "i18next";
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";

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
        title={t("Parallax hit a problem")}
        message={t("This window stopped working. Your threads are saved and agents keep running.")}
        details={this.state.details}
        action={{ label: t("Reload"), onClick: () => window.location.reload() }}
      />
    );
  }
}

/**
 * The whole window when something fails (PLX-1482): what happened in plain words, one action to
 * recover, Copy error, and the technical text behind Show details. `onDismiss` adds Continue
 * anyway, for a failure the rest of the app can work around.
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
  const [open, setOpen] = useState(false);
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
      <main className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 text-center">
        <div className="flex w-full max-w-sm flex-col items-center motion-safe:animate-[sidebar-rise_240ms_ease-out]">
          <ParallaxMark className="size-10" />
          <h1 id="crash-title" className="mt-6 text-heading font-semibold tracking-tight">
            {title}
          </h1>
          <p id="crash-message" className="mt-1.5 text-body leading-relaxed text-muted-foreground">
            {message}
          </p>
          <div className="mt-6 flex items-center gap-2">
            <Button variant="primary" onClick={action.onClick}>
              {action.label}
            </Button>
            <Button variant="outline" onClick={copy}>
              {copied ? t("Copied") : t("Copy error")}
            </Button>
          </div>
          <div className="mt-4 flex items-center gap-3 text-meta text-faint-foreground">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="hover:text-foreground"
            >
              {open ? t("Hide details") : t("Show details")}
            </button>
            {onDismiss && (
              <>
                <span aria-hidden>·</span>
                <button type="button" onClick={onDismiss} className="hover:text-foreground">
                  {t("Continue anyway")}
                </button>
              </>
            )}
          </div>
        </div>
        {open && (
          <pre className="mt-5 max-h-56 w-full max-w-lg overflow-auto rounded-xl bg-surface px-3.5 py-3 text-left text-caption [font-variant-ligatures:none] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground ring-1 ring-border select-text">
            {details}
          </pre>
        )}
      </main>
      {version && (
        <p className="shrink-0 pb-4 text-center text-caption text-faint-foreground">
          Parallax {version}
        </p>
      )}
    </dialog>
  );
}
