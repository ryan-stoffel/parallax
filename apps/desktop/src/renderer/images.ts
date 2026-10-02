// Images sent with a message (RYA-193, decision 0026): read from a pasted, dropped, or picked
// file into what plxd takes, and fetched back for the transcript.
import type { ConnectionState } from "../preload/bridge";
import type { ImageMediaType, PromptImage } from "../protocol/generated/protocol";

/** The `promptImages` capability's caps: how many images a message takes, and how long each image's base64 and all of theirs together may be. */
export interface ImageCaps {
  maxImages: number;
  maxImageBytes: number;
  maxTotalBytes: number;
}

/** A host's image caps. Undefined while it isn't connected, or when its plxd takes no images. */
export function imageCaps(connection?: ConnectionState): ImageCaps | undefined {
  const options =
    connection?.status === "connected" ? connection.capabilities["promptImages"] : undefined;
  const { maxImages, maxImageBytes, maxTotalBytes } = options ?? {};
  return typeof maxImages === "number" &&
    typeof maxImageBytes === "number" &&
    typeof maxTotalBytes === "number"
    ? { maxImages, maxImageBytes, maxTotalBytes }
    : undefined;
}

const mediaTypes: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] satisfies ImageMediaType[];

// The longest edge an image is sent at: Anthropic refuses larger ones once a conversation holds
// more than 20 images, and Claude Code sends the whole conversation every turn.
const maxEdge = 2000;

/**
 * `file` as an image to send, at most 2000 px on its long edge and `maxBytes` of base64: as it is
 * when it fits (so a GIF keeps its frames), or else redrawn smaller as WebP, which keeps any
 * transparency. Resolves to why not, for people, when it isn't an image plxd takes or can't fit.
 */
export async function readImage(file: Blob, maxBytes: number): Promise<PromptImage | string> {
  if (!mediaTypes.includes(file.type)) return "Only PNG, JPEG, GIF, and WebP images can be sent.";
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    return await fit(file, bitmap, maxBytes);
  } catch {
    return "That image couldn't be read.";
  } finally {
    // Its decoded pixels are megabytes for a photo: free them now, not whenever GC runs.
    bitmap?.close();
  }
}

async function fit(
  file: Blob,
  bitmap: ImageBitmap,
  maxBytes: number,
): Promise<PromptImage | string> {
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= maxEdge) {
    const image = fromDataUrl(await dataUrlOf(file));
    if (image.data.length <= maxBytes) return image;
  }
  const canvas = document.createElement("canvas");
  for (let edge = Math.min(long, maxEdge); edge >= 100; edge = Math.floor(edge * 0.75)) {
    canvas.width = Math.max(1, Math.round((bitmap.width * edge) / long));
    canvas.height = Math.max(1, Math.round((bitmap.height * edge) / long));
    // Sizing the canvas resets its context, so this goes after. The default smoothing aliases
    // text in a scaled-down screenshot.
    const context = canvas.getContext("2d")!;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // A browser without WebP gives PNG instead, which the data URL says.
    const image = fromDataUrl(canvas.toDataURL("image/webp", 0.9));
    if (image.data.length <= maxBytes) return image;
  }
  return "That image is too large to send.";
}

function dataUrlOf(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read the file"));
    reader.readAsDataURL(file);
  });
}

// `data:<type>;base64,<data>`, which is only ever one of `mediaTypes` here.
const fromDataUrl = (url: string): PromptImage => ({
  mediaType: url.slice(5, url.indexOf(";")) as ImageMediaType,
  data: url.slice(url.indexOf(",") + 1),
});

// One data URL per image, so re-rendering a thumbnail doesn't rebuild megabytes of string.
const urls = new WeakMap<PromptImage, string>();

/** An image as a data URL, for an `<img>`. */
export function imageUrl(image: PromptImage): string {
  let url = urls.get(image);
  if (url === undefined) urls.set(image, (url = `data:${image.mediaType};base64,${image.data}`));
  return url;
}

// Images fetched from plxd, by id, which never changes what it names. ponytail: kept for the
// window's life at up to ~5 MiB each; evict the least recently shown if long sessions grow large.
const fetched = new Map<string, Promise<string | undefined>>();

/**
 * Image `imageId` of run `runId` as a data URL, from `agent/image`, or undefined when plxd can't
 * serve it. Cached by id; a failure isn't, so the next showing tries again.
 */
export function loadImage(hostId: string, runId: string, imageId: string) {
  let image = fetched.get(imageId);
  if (!image) {
    const failed = () => {
      fetched.delete(imageId);
      return undefined;
    };
    image = window.parallax
      .request(hostId, "agent/image", { runId, imageId })
      .then((answer) => ("result" in answer ? imageUrl(answer.result) : failed()), failed);
    fetched.set(imageId, image);
  }
  return image;
}
