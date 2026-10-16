import { useEffect, useState } from "react";

import { useConnection } from "./ConnectionStatus";
import { download, load, type DocRef } from "./documents";
import { isVideo } from "./transcript";

/**
 * Where main streams a presented video from (main/hosts.ts's `streamFile`, PLX-836), so it plays
 * while it loads and seeks without being read whole first: for a host whose plxd reads files in
 * slices (`fileChunks`, 0074). Null for an image or other file, and for an older host, which read
 * it whole as before. Undefined for a video until the host's capabilities are known.
 */
export function useStreamUrl(hostId: string, doc: DocRef): string | null | undefined {
  const connection = useConnection(hostId);
  // Kept through a reconnect, so a video that's playing stays.
  const [known, setKnown] = useState<{ hostId: string; chunks: boolean }>();
  useEffect(() => {
    if (connection?.status === "connected")
      setKnown({ hostId, chunks: connection.capabilities["fileChunks"] !== undefined });
  }, [hostId, connection]);
  if (!isVideo(doc.kind)) return null;
  if (known?.hostId !== hostId) return undefined;
  return known.chunks
    ? `plx-file://file/${[hostId, doc.runId, doc.path].map(encodeURIComponent).join("/")}`
    : null;
}

/** Download for a streamed video: reads the whole file through `load` once it's clicked. */
export function useSaveWhole(hostId: string, doc: DocRef) {
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const save = () => {
    setState({ busy: true });
    load(hostId, doc).then(
      ({ bytes }) => {
        download(doc.name, bytes);
        setState({ busy: false });
      },
      (error: unknown) =>
        setState({ busy: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return { ...state, save };
}
