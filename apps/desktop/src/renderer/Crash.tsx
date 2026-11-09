import { Component, useState, type ErrorInfo, type ReactNode } from "react";

import { icons } from "./icons";
import { Button } from "./ui";

/**
 * A failure's technical text, folded under Details with a Copy button, so a person sees plain
 * words first and can still send the text on (PLX-1482).
 */
export function ErrorDetails({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <details className="group w-full">
      <summary className="inline-flex cursor-default list-none items-center gap-1 rounded-md text-meta text-faint-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <icons.next aria-hidden className="size-3 transition-transform group-open:rotate-90" />
        Details
      </summary>
      <div className="relative mt-1.5 rounded-lg bg-background ring-1 ring-border">
        <pre className="max-h-40 overflow-auto p-2 pr-8 text-left text-caption break-words whitespace-pre-wrap text-muted-foreground select-text">
          {text}
        </pre>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy details"}
          onClick={copy}
          className="absolute top-1 right-1 grid size-6 place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
        >
          {copied ? <icons.done aria-hidden /> : <icons.copy aria-hidden />}
        </button>
      </div>
    </details>
  );
}

/**
 * Around the app: a render that throws shows a screen to reload from, with what failed, instead
 * of an empty window.
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
      <CrashScreen details={this.state.details} />
    );
  }
}

/** The whole window after a crash: what happened, Reload, and the error under Details. */
export function CrashScreen({ details }: { details: string }) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Something to drag the window by, since the page draws the title bar. */}
      <div className="titlebar h-10 shrink-0" />
      <main className="grid flex-1 place-items-center px-6 pb-10">
        <div className="flex w-full max-w-sm flex-col items-center text-center">
          <div className="grid size-11 place-items-center rounded-full bg-danger/12 text-danger">
            <icons.warning aria-hidden className="size-5" />
          </div>
          <h1 className="mt-4 text-heading font-semibold">Parallax hit a problem</h1>
          <p className="mt-1.5 text-body leading-normal text-muted-foreground">
            This window stopped working. Your threads are saved, and running agents keep going.
            Reload to pick up where you left off.
          </p>
          <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
            <icons.refresh aria-hidden />
            Reload
          </Button>
          <div className="mt-6 w-full">
            <ErrorDetails text={details} />
          </div>
        </div>
      </main>
    </div>
  );
}
