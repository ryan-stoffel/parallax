// Opens the title and text plxd sealed for a push (0100, daemon/src/relay/seal.rs), as the iOS
// notification service extension does in Swift (modules/thread-status/ios/ThreadStatus.swift).
// Android's background push task (androidPush.ts) uses it.
import { gcm } from "@noble/ciphers/aes.js";

/** What a push carries as its data: the relay's `Notification` (relay/src/push.ts). */
export type PushBody = { hostId: string; run: string; state: "needsYou" | "done" | "failed"; sealed?: string };

/** What plxd sealed: the thread's title and the start of its reply. */
export type Sealed = { title: string; text: string };

function base64url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/**
 * Opens `body.sealed` with `key`, the push key of the computer `body.hostId` names, in base64url.
 * `sealed` is a 12-byte nonce and the AES-256-GCM ciphertext with its tag, over `<hostId>:<run>:<state>`,
 * so it opens only for the push it came with. Undefined when it doesn't open.
 */
export function openSealed(body: PushBody, key: string): Sealed | undefined {
  try {
    if (!body.sealed) return undefined;
    const bytes = base64url(key);
    if (bytes.length !== 32) return undefined;
    const sealed = base64url(body.sealed);
    const data = new TextEncoder().encode(`${body.hostId}:${body.run}:${body.state}`);
    const plain = gcm(bytes, sealed.subarray(0, 12), data).decrypt(sealed.subarray(12));
    const { title, text } = JSON.parse(new TextDecoder().decode(plain)) as Partial<Sealed>;
    return typeof title === "string" && typeof text === "string" ? { title, text } : undefined;
  } catch {
    return undefined;
  }
}
