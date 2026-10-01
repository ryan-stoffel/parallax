import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { CliKind } from "../protocol/generated/protocol";

/**
 * A terminal running `cli`'s own sign-in on a host (0004), in the main process's pty. What's typed
 * and printed only passes between the two. `onExit` runs when the sign-in ends; closing the pane
 * (`onClose`, or unmounting) ends it if it's still running.
 */
export function SignInTerminal({
  hostId,
  cli,
  name,
  onExit,
  onClose,
}: {
  hostId: string;
  cli: CliKind;
  /** The CLI as people know it, such as "Claude Code". */
  name: string;
  onExit: () => void;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);
  const exited = useEffectEvent(onExit);

  useEffect(() => {
    const element = container.current!;
    const style = getComputedStyle(element);
    const color = (token: string) => style.getPropertyValue(token).trim();
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: color("--surface"),
        foreground: color("--foreground"),
        cursor: color("--foreground"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Links, such as the vendor's sign-in page, go to main, which opens https ones in the browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    // Outside macOS, Ctrl+V pastes and Ctrl+C copies a selection, as Cmd does on a Mac.
    term.attachCustomKeyEventHandler(
      (e) =>
        window.wisp.platform === "darwin" ||
        e.type !== "keydown" ||
        !e.ctrlKey ||
        !(e.key === "v" || (e.key === "c" && term.hasSelection())),
    );
    term.open(element);
    fit.fit();

    const stop = window.wisp.onTerminal((message) => {
      if (message.type === "data") return term.write(message.data);
      setEnded(true);
      exited();
    });
    term.onData((data) => window.wisp.terminalInput(data));
    term.onResize(({ cols, rows }) => window.wisp.resizeTerminal(cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    void window.wisp.openTerminal(hostId, cli, term.cols, term.rows).then(setError);
    term.focus();

    return () => {
      observer.disconnect();
      stop();
      window.wisp.closeTerminal();
      term.dispose();
    };
  }, [hostId, cli]);

  const done = ended || error !== undefined;
  return (
    <div className="flex flex-col gap-2 border-border px-4 py-3 not-last:border-b">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-muted-foreground">
          {done ? `${name} sign-in ended.` : `Signing in to ${name}…`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="-my-1 rounded-md px-2.5 py-1 text-[12.5px] text-muted-foreground hover:bg-hover hover:text-foreground"
        >
          {done ? "Close" : "Cancel"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {/* The fit addon sizes the terminal to the inner box, so the padding goes outside it. */}
      <div className="h-64 rounded-md border border-border bg-surface p-2">
        <div
          ref={container}
          role="group"
          aria-label={`${name} sign-in terminal`}
          className="h-full overflow-hidden"
        />
      </div>
    </div>
  );
}
