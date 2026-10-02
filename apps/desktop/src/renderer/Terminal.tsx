import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useEffectEvent, useRef } from "react";

import type { TerminalTarget } from "../preload/bridge";

/**
 * An xterm.js terminal showing main's terminal `id`, which it opens on `target` when it mounts and
 * ends when it unmounts. What's typed and printed only passes between the two. `onEnd` gets an
 * error for people if it couldn't start, or nothing once what it ran exits. Its colors follow the
 * app theme, with `background` the CSS token behind it. Import it lazily: xterm.js is large.
 */
export function TerminalView({
  id,
  target,
  label,
  background = "--surface",
  onEnd,
}: {
  id: string;
  target: TerminalTarget;
  /** The terminal's accessible name. */
  label: string;
  background?: string;
  onEnd?: (error?: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ended = useEffectEvent((error?: string) => onEnd?.(error));
  // The target when it mounted. Another target is another terminal: key it by its target.
  const opened = useRef(target);

  useEffect(() => {
    const element = container.current!;
    const theme = () => {
      const style = getComputedStyle(element);
      const color = (token: string) => style.getPropertyValue(token).trim();
      return {
        background: color(background),
        foreground: color("--foreground"),
        cursor: color("--foreground"),
      };
    };
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Links go to main, which opens https ones in the browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    // Outside macOS, Ctrl+V pastes and Ctrl+C copies a selection, as Cmd does on a Mac.
    term.attachCustomKeyEventHandler(
      (e) =>
        window.parallax.platform === "darwin" ||
        e.type !== "keydown" ||
        !e.ctrlKey ||
        !(e.key === "v" || (e.key === "c" && term.hasSelection())),
    );
    term.open(element);
    // Hidden, it has no size to fit; it fits once shown.
    const fitShown = () => element.clientWidth > 0 && fit.fit();
    fitShown();

    const stop = window.parallax.onTerminal(id, (message) => {
      if (message.type === "data") return term.write(message.data);
      ended();
    });
    term.onData((data) => window.parallax.terminalInput(id, data));
    term.onResize(({ cols, rows }) => window.parallax.resizeTerminal(id, cols, rows));
    const observer = new ResizeObserver(fitShown);
    observer.observe(element);
    // The `dark` class on <html> switches the theme's tokens (theme.ts).
    const themes = new MutationObserver(() => (term.options.theme = theme()));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    void window.parallax
      .openTerminal(id, opened.current, term.cols, term.rows)
      .then((error) => error && ended(error));
    term.focus();

    return () => {
      observer.disconnect();
      themes.disconnect();
      stop();
      window.parallax.closeTerminal(id);
      term.dispose();
    };
  }, [id, background]);

  return <div ref={container} role="group" aria-label={label} className="h-full overflow-hidden" />;
}
