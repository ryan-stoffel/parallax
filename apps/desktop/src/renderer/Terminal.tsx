import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useEffectEvent, useRef } from "react";

import type { TerminalTarget } from "../preload/bridge";
import { terminalAppShortcut } from "./ui";

const mac = () => window.parallax.platform === "darwin";

/**
 * An xterm.js terminal showing main's terminal `id`, which it opens on `target` when it mounts and
 * ends when it unmounts. What's typed and printed only passes between the two. `onStart` is called
 * once what it runs has started, and `onEnd` gets an error for people if it couldn't start, or
 * nothing once what it ran exits. Its colors follow the
 * app theme, with `background` the CSS token behind it. Import it lazily: xterm.js is large.
 */
export function TerminalView({
  id,
  target,
  label,
  background = "--surface",
  onStart,
  onEnd,
}: {
  id: string;
  target: TerminalTarget;
  /** The terminal's accessible name. */
  label: string;
  background?: string;
  onStart?: () => void;
  /** Called with an error for people if it couldn't start, else with how it exited. */
  onEnd?: (error?: string, exitCode?: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const began = useEffectEvent(() => onStart?.());
  const ended = useEffectEvent((error?: string, exitCode?: number) => onEnd?.(error, exitCode));
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
    // The monospace font and size from Settings > Appearance (appearance.ts), on <html>.
    const font = () => {
      const style = getComputedStyle(document.documentElement);
      const family = style.getPropertyValue("--code-font").trim();
      return {
        fontFamily: `${family && `${family}, `}"JetBrains Mono Nerd Font", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`,
        fontSize: Number(style.getPropertyValue("--code-size")) || 12,
      };
    };
    const term = new Terminal({
      ...font(),
      cursorBlink: true,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Links go to main, which opens https ones in the browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    // The app's shortcuts reach only the app, but plain Ctrl+letter ones outside macOS, which stay
    // the shell's (`terminalAppShortcut`). Outside macOS, Ctrl+V pastes and Ctrl+C copies a
    // selection, as Cmd does on a Mac.
    term.attachCustomKeyEventHandler(
      (e) =>
        !terminalAppShortcut(e) &&
        (mac() ||
          e.type !== "keydown" ||
          !e.ctrlKey ||
          !(e.key === "v" || (e.key === "c" && term.hasSelection()))),
    );
    term.open(element);
    // Hidden, it has no size to fit; it fits once shown.
    const fitShown = () => element.clientWidth > 0 && fit.fit();
    fitShown();

    const stop = window.parallax.onTerminal(id, (message) => {
      if (message.type === "data") return term.write(message.data);
      ended(undefined, message.exitCode);
    });
    term.onData((data) => window.parallax.terminalInput(id, data));
    term.onResize(({ cols, rows }) => window.parallax.resizeTerminal(id, cols, rows));
    const observer = new ResizeObserver(fitShown);
    observer.observe(element);
    // The `dark` class on <html> switches the theme's tokens (theme.ts), and its style holds the
    // monospace font and size.
    const themes = new MutationObserver(() => {
      term.options.theme = theme();
      Object.assign(term.options, font());
      fitShown();
    });
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    let live = true;
    // The shell starts once the Nerd Font icons have loaded: xterm.js measures a glyph's width
    // once, so an icon drawn before its font arrives would stay a cell off.
    void document.fonts
      .load('12px "JetBrains Mono Nerd Font"', "\ue0a0")
      .catch(() => {})
      .then(() =>
        live ? window.parallax.openTerminal(id, opened.current, term.cols, term.rows) : undefined,
      )
      .then((error) => live && (error ? ended(error) : began()));
    term.focus();

    return () => {
      live = false;
      observer.disconnect();
      themes.disconnect();
      stop();
      window.parallax.closeTerminal(id);
      term.dispose();
    };
  }, [id, background]);

  return <div ref={container} role="group" aria-label={label} className="h-full overflow-hidden" />;
}
