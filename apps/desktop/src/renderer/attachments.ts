// How a message carries files (PLX-779, 0071): an image saved as `image-<n>`, and the saved files'
// paths listed after the text for the agent to read. Pure, so the desktop and mobile apps share it.
import type { PromptImage } from "../protocol/generated/protocol";

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
