import {
  createContext,
  useContext,
  useEffect,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { defaultUrlTransform } from "react-markdown";

import { download, failure, useDocument, useObjectUrl, type DocRef } from "./documents";
import { OpenDocumentContext } from "./FileCards";
import { Lightbox } from "./Lightbox";
import { notify } from "./notifications";
import { isMedia, isVideo, kindOf } from "./transcript";

/**
 * Files an agent links in its messages (PLX-834). The hrefs are its output, so they're untrusted:
 * one names a file only as a relative path, an absolute path inside the thread's folder, or a
 * `file:` URL to one, and is read only through `agent/file`, whose worktree rules plxd enforces.
 * Any other scheme is a web link, which main opens in the browser only when it's https.
 */

/** The thread a transcript's file links read from, set by the transcript. */
export const FileRunContext = createContext<{ hostId: string; runId: string } | undefined>(
  undefined,
);

// A Windows drive path, its backslash as written or as Markdown percent-encodes it.
const drive = /^[a-z]:(?:[\\/]|%5c)/i;
const isAbsolute = (path: string) => path.startsWith("/") || /^[a-z]:\//i.test(path);

/**
 * react-markdown's `urlTransform` in a transcript: keeps `file:` URLs and drive paths, which can
 * name the thread's files, and leaves the rest to its default, which drops `javascript:` and every
 * other unsafe scheme.
 */
export const keepFiles = (url: string) =>
  /^file:/i.test(url) || drive.test(url) ? url : defaultUrlTransform(url);

/**
 * The path a link or image names when it's a file rather than a web page: relative, absolute, or
 * a `file:` URL, decoded, with `/` between folders. Undefined for any other scheme, a link within
 * the page, or none.
 */
export function linkedPath(href?: string): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("//")) return undefined;
  let path: string;
  if (/^file:/i.test(href)) {
    const url = URL.parse(href);
    if (!url) return undefined;
    // file://server/share names another computer's file, which is never in the folder.
    path =
      url.host && url.host !== "localhost"
        ? `//${url.host}${url.pathname}`
        : url.pathname.replace(/^\/(?=[a-z]:)/i, "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !drive.test(href)) return undefined;
  else path = href.replace(/[?#][^]*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // A stray %, kept as written.
  }
  return path.replaceAll("\\", "/");
}

/**
 * `path`, as `linkedPath` gives it, relative to the thread's folder `folder`, as `agent/file`
 * takes it. Undefined when it's not in the folder: an absolute path elsewhere, one from the home
 * folder, or a `..` that climbs out. A relative path is read from the folder.
 */
export function inFolder(path: string, folder?: string): string | undefined {
  if (path.startsWith("~")) return undefined;
  let rest = path;
  if (isAbsolute(path)) {
    const base = folder?.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!base || !path.startsWith(`${base}/`)) return undefined;
    rest = path.slice(base.length + 1);
  }
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "..") {
      if (parts.pop() === undefined) return undefined;
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/") || undefined;
}

// Each thread's folder by host and thread, once `agent/files` names it.
const folders = new Map<string, Promise<string | undefined>>();

/** Thread `runId`'s folder on `hostId`, which an absolute link has to be in. */
function folderOf(hostId: string, runId: string): Promise<string | undefined> {
  const key = `${hostId}\n${runId}`;
  let folder = folders.get(key);
  if (!folder) {
    folder = window.parallax.request(hostId, "agent/files", { runId }).then(async (answer) => {
      if ("error" in answer) throw new Error(await failure(hostId, answer.error));
      return answer.result.folder;
    });
    folders.set(key, folder);
    // A host that's offline now may answer later.
    folder.catch(() => folders.delete(key));
  }
  return folder;
}

/**
 * The file `path` names in thread `runId`'s folder on `hostId`, or undefined when it's outside it.
 * Rejects, saying why, when an absolute path's folder can't be read.
 */
export async function linkedFile(
  hostId: string,
  runId: string,
  path: string,
): Promise<DocRef | undefined> {
  const inside = inFolder(path, isAbsolute(path) ? await folderOf(hostId, runId) : undefined);
  if (inside === undefined) return undefined;
  const name = inside.slice(inside.lastIndexOf("/") + 1);
  return { runId, path: inside, name, kind: kindOf(name) };
}

export const outsideFolder =
  "This file is outside the thread's folder, so it can't be opened here.";

/**
 * A link to a file in a transcript: opens it in the side panel, as a presented file's card does,
 * where it shows as a document, an image or video, or a file to download. A file outside the
 * thread's folder, or a folder that can't be read, says so in a notification. Outside a
 * transcript, only its text.
 */
export function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const run = useContext(FileRunContext);
  const open = useContext(OpenDocumentContext);
  if (!run || !open) return <a>{children}</a>;
  const fail = (body: string) =>
    notify({ key: `file/${path}`, tone: "error", title: "Couldn't open the file", body });
  const follow = (e: MouseEvent) => {
    e.preventDefault();
    linkedFile(run.hostId, run.runId, path).then(
      (doc) => (doc ? open(doc) : fail(outsideFolder)),
      (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
    );
  };
  // "#", so the agent's path never becomes an address the page could go to.
  return (
    <a href="#" title={path} onClick={follow}>
      {children}
    </a>
  );
}

/**
 * A Markdown image in a transcript whose source is an image in the thread's folder: the image,
 * read through `agent/file`, which opens in the Lightbox, with Download, when clicked (PLX-998).
 * Any other source is a FileLink with the alt text.
 */
export function FileImage({ path, alt }: { path: string; alt: string }) {
  const { hostId, runId } = useContext(FileRunContext) ?? {};
  // The image's file once found, or null for a source that isn't one.
  const [doc, setDoc] = useState<DocRef | null>();
  useEffect(() => {
    if (!hostId || !runId) return;
    let live = true;
    linkedFile(hostId, runId, path).then(
      (found) =>
        live && setDoc(found && isMedia(found.kind) && !isVideo(found.kind) ? found : null),
      () => live && setDoc(null),
    );
    return () => {
      live = false;
    };
  }, [hostId, runId, path]);
  if (!hostId || !doc) return <FileLink path={path}>{alt}</FileLink>;
  return <LinkedImage hostId={hostId} doc={doc} alt={alt} />;
}

function LinkedImage({ hostId, doc, alt }: { hostId: string; doc: DocRef; alt: string }) {
  const { loaded, error, progress } = useDocument(hostId, doc);
  const url = useObjectUrl(loaded?.bytes);
  const [shown, setShown] = useState(false);
  if (error)
    return (
      <span className="text-muted-foreground">
        {alt} · {error}
      </span>
    );
  return (
    <>
      <button
        type="button"
        aria-label={`Open ${doc.name}`}
        title={doc.path}
        disabled={!url}
        onClick={(e) => {
          // Not the FileLink a linked image may sit in, which would open the side panel too.
          e.preventDefault();
          e.stopPropagation();
          setShown(true);
        }}
        className="block cursor-zoom-in rounded-md"
      >
        {url ? (
          <img src={url} alt={alt} className="block max-h-96 max-w-full rounded-md" />
        ) : (
          <span
            aria-label={`Loading ${doc.name}`}
            className="grid h-32 w-48 place-items-center rounded-md bg-selected text-[12.5px] text-muted-foreground tabular-nums"
          >
            {progress !== undefined && `${Math.round(progress * 100)}%`}
          </span>
        )}
      </button>
      {/* On the body, since a Markdown image sits in a paragraph, which can't hold a dialog. React
          still bubbles its clicks to the image's parents, such as a FileLink, so they stop here. */}
      {shown &&
        url &&
        createPortal(
          <div onClick={(e) => e.stopPropagation()}>
            <Lightbox
              images={[{ src: url, name: doc.name }]}
              index={0}
              onIndex={() => {}}
              onClose={() => setShown(false)}
              onDownload={() => loaded && download(doc.name, loaded.bytes)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
