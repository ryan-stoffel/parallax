// Files attached to a message (PLX-779, decision 0071): plxd saves each on the host with
// `host/upload`, and the message lists their paths for the agent to read. Images are saved too
// (PLX-799), so the agent has a file to work with as well as the image it sees.
import type { ConnectionState } from "../preload/bridge";
import type { PromptImage } from "../protocol/generated/protocol";
import { describeError } from "./errors";
import { fromBase64 } from "./ooxml";

/** The `fileUploads` cap on one file's base64. Undefined while the host isn't connected, or when its plxd takes no files. */
export function uploadBytes(connection?: ConnectionState): number | undefined {
  const max =
    connection?.status === "connected"
      ? connection.capabilities["fileUploads"]?.["maxBytes"]
      : undefined;
  return typeof max === "number" ? max : undefined;
}

/** How long `file`'s base64 is, which the cap is measured on. */
export const base64Length = (file: Blob) => Math.ceil(file.size / 3) * 4;

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

/** Saves each of `files` on the host, in order, and resolves to their paths there, or to why not. */
export async function uploadFiles(
  hostId: string,
  files: (File | Encoded)[],
): Promise<string[] | string> {
  const paths: string[] = [];
  for (const file of files) {
    const answer = await window.parallax.request(hostId, "host/upload", {
      name: file.name,
      data: file instanceof Blob ? await base64Of(file) : file.data,
    });
    if ("error" in answer) return `${file.name} couldn't be sent: ${describeError(answer.error)}`;
    paths.push(answer.result.path);
  }
  return paths;
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

/** A file `uploadFiles` saved on `hostId`, read back for the transcript. */
export async function readUpload(hostId: string, path: string): Promise<Uint8Array> {
  const answer = await window.parallax.request(hostId, "host/readUpload", { path });
  if ("error" in answer) throw new Error(describeError(answer.error));
  return fromBase64(answer.result.data);
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
