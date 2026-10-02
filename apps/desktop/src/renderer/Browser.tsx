import type { DidFailLoadEvent, WebviewTag } from "electron";
import { ArrowLeft, ArrowRight, Globe, RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { IconButton } from "./ui";

/**
 * The page an address names, or undefined unless it's http or https. An address without a
 * scheme, such as `localhost:5173`, is http.
 */
export function browserUrl(address: string): string | undefined {
  const text = address.trim();
  if (!text) return undefined;
  // A scheme is letters then a colon, which a port's digits don't follow.
  const url = URL.parse(/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text) ? text : `http://${text}`);
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.href : undefined;
}

/**
 * The side panel's browser: back, forward, reload, and an address bar over a webview, which main
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

  const open = (text: string) => {
    const next = browserUrl(text);
    if (!next) return setError({ url: text, description: "Only http and https pages open here." });
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
    const started = () => setError(undefined);
    // -3 is a load another one replaced.
    const failed = (e: DidFailLoadEvent) => {
      if (e.isMainFrame && e.errorCode !== -3)
        setError({ url: e.validatedURL, description: e.errorDescription });
    };
    el.addEventListener("did-navigate", navigated);
    el.addEventListener("did-navigate-in-page", navigated);
    el.addEventListener("did-start-loading", started);
    el.addEventListener("did-fail-load", failed);
    return () => {
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
        <IconButton label="Reload" disabled={!src} onClick={() => view.current?.reload()}>
          <RotateCw />
        </IconButton>
        <input
          autoFocus
          aria-label="Address"
          placeholder="localhost:5173"
          spellCheck={false}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.target.select()}
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
                  Type an address, such as a dev server's localhost:5173.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
