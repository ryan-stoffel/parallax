import { useEffect, useRef, useState } from "react";

import type { HtmlRenderRef } from "./transcript";

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;

// The categorical chart colors after the accent, as T3 Code fixes them per appearance.
const charts = {
  light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
  dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
};

/**
 * The app's theme as an html_render page reads it (PLX-639): T3 Code's variable names, from
 * index.css's tokens as they stand now.
 */
export function pageTheme() {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const appearance = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const surface = (color: string) => `color-mix(in oklab, ${color} 14%, ${v("--surface")})`;
  return {
    appearance,
    variables: {
      "--background": v("--background"),
      "--foreground": v("--foreground"),
      "--muted": v("--selected"),
      "--muted-foreground": v("--muted-foreground"),
      "--card": v("--surface"),
      "--card-foreground": v("--foreground"),
      "--popover": v("--surface"),
      "--popover-foreground": v("--foreground"),
      "--secondary": v("--selected"),
      "--secondary-foreground": v("--foreground"),
      "--border": v("--border"),
      "--input": v("--border"),
      "--ring": v("--ring"),
      "--primary": v("--primary"),
      "--primary-foreground": v("--primary-foreground"),
      "--accent": v("--accent"),
      "--accent-foreground": v("--accent-foreground"),
      "--accent-surface": surface(v("--accent")),
      "--accent-surface-foreground": v("--foreground"),
      "--destructive": v("--danger"),
      "--destructive-foreground": v("--danger"),
      "--destructive-surface": surface(v("--danger")),
      "--warning": v("--warning"),
      "--warning-foreground": v("--warning"),
      "--warning-surface": surface(v("--warning")),
      "--success": v("--added"),
      "--success-foreground": v("--added"),
      "--info": "#3b82f6",
      "--info-foreground": appearance === "dark" ? "#60a5fa" : "#1d4ed8",
      "--code-background": v("--code"),
      "--code-foreground": v("--foreground"),
      "--chart-1": v("--accent"),
      ...Object.fromEntries(charts[appearance].map((color, i) => [`--chart-${i + 2}`, color])),
      "--radius": "0.625rem",
      "--font-sans": v("--font-sans"),
      "--font-mono": v("--font-mono"),
    },
  };
}

/** The address main serves a run's html_render page at (main/hosts.ts). */
export const pageUrl = (hostId: string, runId: string, attachmentId: string) =>
  `plx-render://page/${encodeURIComponent(hostId)}/${encodeURIComponent(runId)}/${encodeURIComponent(attachmentId)}`;

/**
 * An html_render page inline in the transcript, as T3 Code shows one: borderless, in a frame that
 * runs its scripts and nothing else (no same origin, popups, or navigation of the app). It gets
 * the app's theme in its URL and again whenever the theme changes, reports its height, which the
 * frame fits up to the agent's `height`, and sends its links here to open in the browser. It
 * speaks MCP Apps' JSON-RPC over postMessage.
 */
export function HtmlRender({
  hostId,
  page,
}: {
  hostId: string;
  page: HtmlRenderRef & { runId: string };
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number>();
  // The theme at mount; later changes go by message, so the page keeps its state.
  const [src] = useState(
    () =>
      `${pageUrl(hostId, page.runId, page.attachmentId)}#plx-theme=${encodeURIComponent(JSON.stringify(pageTheme()))}`,
  );

  useEffect(() => {
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");
    const onMessage = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const { jsonrpc, id, method, params } = (event.data ?? {}) as {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        params?: { height?: unknown; url?: unknown };
      };
      if (jsonrpc !== "2.0") return;
      const height = params?.height;
      if (method === "ui/notifications/size-changed" && typeof height === "number" && height > 0)
        setContentHeight(height);
      const url = params?.url;
      if (method === "ui/open-link" && typeof url === "string" && /^https?:\/\//i.test(url)) {
        // Main opens it in the system browser.
        window.open(url);
        if (typeof id === "string" || typeof id === "number")
          post({ jsonrpc: "2.0", id, result: {} });
      }
    };
    window.addEventListener("message", onMessage);
    // The theme lives in <html>'s class (theme.ts) and style (appearance.ts).
    const themed = new MutationObserver(() => {
      const theme = pageTheme();
      post({
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: theme.appearance, styles: { variables: theme.variables } },
      });
    });
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => {
      window.removeEventListener("message", onMessage);
      themed.disconnect();
    };
  }, []);

  const height = Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Math.round(Math.min(page.height, contentHeight ?? page.height))),
  );
  return (
    <iframe
      ref={frame}
      title={page.title}
      src={src}
      sandbox="allow-scripts"
      style={{ height }}
      className="block w-full border-0"
    />
  );
}
