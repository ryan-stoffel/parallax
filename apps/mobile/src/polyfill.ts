// What Hermes lacks that noble and the desktop's uuidv7 read: crypto.getRandomValues, from the
// system's secure generator.
import { randomBytes } from "../modules/pinned-tls";

globalThis.crypto ??= {} as Crypto;
crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
  if (array)
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
      randomBytes(array.byteLength),
    );
  return array;
};
