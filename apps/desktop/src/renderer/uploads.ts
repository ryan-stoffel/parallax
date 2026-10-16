// Files attached to a message (PLX-779, decision 0071): plxd saves each on the host with
// `host/upload`, and the message lists their paths for the agent to read. Images are saved too
// (PLX-799), so the agent has a file to work with as well as the image it sees. On a plxd with
// `fileChunks` (PLX-835, decision 0074), a file goes in pieces and reads back in slices.
import type { ConnectionState, HostResponse } from "../preload/bridge";
import type { HostUploadResult, PromptImage } from "../protocol/generated/protocol";
import { fileChunks, readSlices, retried, type Slice } from "./documents";
import { describeError } from "./errors";

/** What a host's `host/upload` takes: the most bytes one file can be, and on `fileChunks`, the most one piece carries. */
export interface UploadCaps {
  maxBytes: number;
  chunkBytes?: number;
}

/**
 * `connection`'s upload caps: `fileChunks`' when its plxd has them, or else the file `fileUploads`'
 * cap on one message's base64 holds. Undefined while the host isn't connected, or when its plxd
 * takes no files.
 */
export function uploadBytes(connection?: ConnectionState): UploadCaps | undefined {
  const base64 =
    connection?.status === "connected"
      ? connection.capabilities["fileUploads"]?.["maxBytes"]
      : undefined;
  if (typeof base64 !== "number") return undefined;
  // Every 3 bytes are 4 characters of base64.
  return fileChunks(connection) ?? { maxBytes: Math.floor(base64 / 4) * 3 };
}

/** A file already in base64, such as a message's image, to save with `uploadFiles`. */
export interface Encoded {
  name: string;
  data: string;
}

/** `image` as `uploadFiles` saves it: `image-<n>` with its type's extension. */
export const encodedImage = (image: PromptImage, n: number): Encoded => ({
  name: `image-${n}.${image.mediaType.slice("image/".length).replace("jpeg", "jpg")}`,
  data: image.data,
});

/** Whether `path` is one `encodedImage` named, which the transcript shows as the image itself. */
export const isImagePath = (path: string) => /[/\\]image-\d+\.(?:png|jpg|gif|webp)$/.test(path);

/**
 * Saves each of `files` on the host, in order, and resolves to their paths there, or to why not.
 * With `chunkBytes`, each `File` goes in pieces that size, and `onProgress` gets the share of it
 * sent before the first and after each. An encoded image is always one message.
 */
export async function uploadFiles(
  hostId: string,
  files: (File | Encoded)[],
  chunkBytes?: number,
  onProgress?: (file: File, share: number) => void,
): Promise<string[] | string> {
  const paths: string[] = [];
  for (const file of files) {
    const answer =
      file instanceof File && chunkBytes
        ? await sendPieces(hostId, file, chunkBytes, (share) => onProgress?.(file, share))
        : await window.parallax.request(hostId, "host/upload", {
            name: file.name,
            data: file instanceof Blob ? await base64Of(file) : file.data,
          });
    if ("error" in answer) return `${file.name} couldn't be sent: ${describeError(answer.error)}`;
    paths.push(answer.result.path);
  }
  return paths;
}

/**
 * `file` sent to `hostId` as `Blob.slice()` pieces of `chunkBytes`, in order (0074), each tried up
 * to three times, which plxd answers as it did when a try already landed. Answers the last piece's
 * answer, or the first that failed.
 */
async function sendPieces(
  hostId: string,
  file: File,
  chunkBytes: number,
  onProgress: (share: number) => void,
): Promise<HostResponse<HostUploadResult>> {
  let uploadId: string | undefined;
  onProgress(0);
  for (let offset = 0; ; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, file.size);
    const last = end === file.size;
    const data = await base64Of(file.slice(offset, end));
    const answer = await retried(hostId, () =>
      window.parallax.request(hostId, "host/upload", {
        name: file.name,
        data,
        uploadId,
        offset,
        last,
      }),
    );
    if ("error" in answer) return answer;
    onProgress(file.size ? end / file.size : 1);
    if (last) return answer;
    uploadId = answer.result.uploadId;
  }
}

/**
 * `text` as the agent gets it: the paths of the files sent with it listed after it. A list it
 * already ends in, such as one Stop put back, takes them, so the message keeps one.
 */
export function withFiles(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  const listed = splitFiles(text);
  const list = `Attached files:\n${[...listed.paths, ...paths].map((p) => `- ${p}`).join("\n")}`;
  return listed.text.trim() ? `${listed.text}\n\n${list}` : list;
}

/**
 * A sent message's text without its images' paths, for the box to put back: the images go back as
 * images, and are saved again when it sends.
 */
export function withoutImages(text: string): string {
  const { text: said, paths } = splitFiles(text);
  return withFiles(
    said,
    paths.filter((path) => !isImagePath(path)),
  );
}

/** A sent message's text split as `withFiles` joined it: the user's text, and the files' paths. */
export function splitFiles(text: string): { text: string; paths: string[] } {
  const list = /(?:^|\n\n)Attached files:\n((?:- .+(?:\n|$))+)$/.exec(text);
  const paths = list?.[1]
    ?.trimEnd()
    .split("\n")
    .map((line) => line.slice(2));
  // Only absolute paths count, so a list the user wrote stays text.
  if (!list || !paths?.every((p) => /^(?:\/|[a-z]:\\)/i.test(p))) return { text, paths: [] };
  return { text: text.slice(0, list.index), paths };
}

/** A file `uploadFiles` saved on `hostId`, read back for the transcript with `readSlices`. */
export function readUpload(hostId: string, path: string): Promise<Uint8Array> {
  const slice: Slice = async (at) => {
    const answer = await retried(hostId, () =>
      window.parallax.request(hostId, "host/readUpload", { path, ...at }),
    );
    if ("error" in answer) throw new Error(describeError(answer.error));
    return answer.result;
  };
  return readSlices(hostId, slice);
}

function base64Of(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // `data:<type>;base64,<data>`
    reader.onload = () => resolve((reader.result as string).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the file"));
    reader.readAsDataURL(file);
  });
}
