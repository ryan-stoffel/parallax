import type { DidFailLoadEvent, WebviewTag } from "electron";
import { ArrowLeft, ArrowRight, Globe, RotateCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "./ui";

/** Google's results page for `query`. */
export const searchUrl = (query: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(query)}`;

/**
 * The page the address bar's text opens, or undefined for nothing or a scheme other than http or
 * https. A host without a scheme is https, except localhost, an IP address, or a host with a port,
 * which are http. Anything else, such as words or a single word, searches Google.
 */
export function browserUrl(address: string): string | undefined {
  const text = address.trim();
  if (!text) return undefined;
  // A scheme is letters then a colon, which a port's digits don't follow.
  if (/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text)) {
    const url = URL.parse(text);
    if (url?.protocol === "http:" || url?.protocol === "https:") return url.href;
    // Words after a colon, such as a pasted `error: cannot borrow`, are a search.
    return /\s/.test(text) ? searchUrl(text) : undefined;
  }
  if (/\s/.test(text)) return searchUrl(text);
  const url = URL.parse(`http://${text}`);
  if (!url) return searchUrl(text);
  const host = url.hostname;
  const local =
    host === "localhost" ||
    // Four dotted numbers in the text itself, since the parser reads `1.5` as 1.0.0.5.
    /^\d{1,3}(\.\d{1,3}){3}(?![\d.])/.test(text) ||
    host.startsWith("[") ||
    url.port !== "";
  if (local) return url.href;
  // A domain ends in a letters-only top-level name, as in example.com.
  if (/\.[a-z]{2,}$/i.test(host)) return url.href.replace(/^http:/, "https:");
  return searchUrl(text);
}

/** A url as the address bar shows it while unfocused: without its scheme or a lone trailing slash. */
export const shortUrl = (url: string) =>
  url.replace(/^https?:\/\//, "").replace(/^([^/?#]*)\/$/, "$1");

/**
 * The side panel's browser: back, forward, reload or stop, a loading bar, and an address bar that
 * opens a page or searches Google, over a webview, which main
 * keeps in its own session with no preload or Node (main.ts). Each new `page` loads its url, even
 * the one already shown. `remoteHost`, the open host's name when it's an SSH host, notes that
 * localhost is this computer.
 */
export function Browser({ page, remoteHost }: { page?: { url: string }; remoteHost?: string }) {
  const view = useRef<WebviewTag>(null);
  // The first page, which mounts the webview; later pages load in it.
  const [src, setSrc] = useState<string>();
  const [address, setAddress] = useState("");
  const [history, setHistory] = useState({ back: false, forward: false });
  const [error, setError] = useState<{ url: string; description: string }>();
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);

  const open = (text: string) => {
    const next = browserUrl(text);
    if (!next) {
      if (text.trim()) setError({ url: text, description: "Only http and https pages open here." });
      return;
    }
    setError(undefined);
    setAddress(next);
    // The view shows a load's error, so the rejection needs no handling here.
    if (view.current) view.current.loadURL(next).catch(() => {});
    else setSrc(next);
  };

  // Only a new `page` loads a page.
  useEffect(() => page && open(page.url), [page]);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const navigated = () => {
      setAddress(el.getURL());
      setHistory({ back: el.canGoBack(), forward: el.canGoForward() });
    };
    const started = () => {
      setError(undefined);
      setLoading(true);
    };
    const stopped = () => setLoading(false);
    // -3 is a load another one replaced.
    const failed = (e: DidFailLoadEvent) => {
      if (e.isMainFrame && e.errorCode !== -3)
        setError({ url: e.validatedURL, description: e.errorDescription });
    };
    el.addEventListener("did-navigate", navigated);
    el.addEventListener("did-navigate-in-page", navigated);
    el.addEventListener("did-start-loading", started);
    el.addEventListener("did-fail-load", failed);
    el.addEventListener("did-stop-loading", stopped);
    return () => {
      el.removeEventListener("did-stop-loading", stopped);
      el.removeEventListener("did-navigate", navigated);
      el.removeEventListener("did-navigate-in-page", navigated);
      el.removeEventListener("did-start-loading", started);
      el.removeEventListener("did-fail-load", failed);
    };
  }, [src]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex items-center gap-0.5 border-b border-border px-2 pb-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          open(address);
        }}
      >
        <IconButton label="Back" disabled={!history.back} onClick={() => view.current?.goBack()}>
          <ArrowLeft />
        </IconButton>
        <IconButton
          label="Forward"
          disabled={!history.forward}
          onClick={() => view.current?.goForward()}
        >
          <ArrowRight />
        </IconButton>
        {loading ? (
          <IconButton label="Stop" onClick={() => view.current?.stop()}>
            <X />
          </IconButton>
        ) : (
          <IconButton label="Reload" disabled={!src} onClick={() => view.current?.reload()}>
            <RotateCw />
          </IconButton>
        )}
        <input
          autoFocus
          aria-label="Address"
          placeholder="Search Google or type a URL"
          spellCheck={false}
          value={editing ? address : shortUrl(address)}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            setEditing(true);
            // The full url replaces the short one first, so select it once it renders.
            const input = e.target;
            requestAnimationFrame(() => input.select());
          }}
          onBlur={() => setEditing(false)}
          className="ml-1 min-w-0 flex-1 rounded-md bg-selected px-2 py-1 text-[12.5px] placeholder:text-faint-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
      </form>
      {remoteHost && (
        <p className="border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
          Pages load on this computer, so localhost isn't {remoteHost}. Forwarding its ports isn't
          built yet.
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {loading && (
          <div
            role="progressbar"
            aria-label="Loading"
            className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-ring"
          />
        )}
        {src && (
          // React drops a `true` attribute it doesn't know, so allowpopups is the empty string.
          // Main loads the windows its pages open in it.
          <webview
            ref={view}
            src={src}
            {...{ allowpopups: "" as unknown as boolean }}
            className="flex-1"
          />
        )}
        {(error || !src) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background px-8 pb-16 text-center">
            {error ? (
              <>
                <TriangleAlert aria-hidden className="mb-1 size-5 text-faint-foreground" />
                <p role="alert" className="text-[13px] font-medium text-foreground">
                  Can't open {error.url}
                </p>
                <p className="text-[12.5px] break-all text-muted-foreground">{error.description}</p>
              </>
            ) : (
              <>
                <Globe aria-hidden className="mb-1 size-5 text-faint-foreground" />
                <p className="text-[13px] font-medium text-foreground">Open a page</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Search Google, or type an address such as a dev server's localhost:5173.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
