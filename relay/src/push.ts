import { base64url } from "./crypto";
import type { Env } from "./index";

/** What plxd says about a run. No thread content: the relay never sees any. */
export type Notification = { hostId: string; run: string; state: "needsYou" | "done" | "failed" };

const TEXT: Record<Notification["state"], string> = {
  needsYou: "A thread needs you.",
  done: "A thread finished.",
  failed: "A thread failed.",
};

/** The mobile app's bundle id, which every push names as its topic. */
const TOPIC = "dev.parallax.mobile";
/** Production first: a TestFlight or App Store build's token. A build run from Xcode has a
 *  sandbox token, which production refuses as `BadDeviceToken`. */
const SERVERS = ["https://api.push.apple.com", "https://api.sandbox.push.apple.com"];
/** Apple refuses a provider token older than an hour and throttles new ones made more often than
 *  every 20 minutes. */
const TOKEN_AGE = 45 * 60_000;

/**
 * The APNs payload for `notification`. expo-notifications gives the app a remote push's `body` as
 * its data, from which it opens the run.
 */
export function apnsPayload(notification: Notification) {
  return {
    aps: {
      alert: { title: "Parallax", body: TEXT[notification.state] },
      sound: "default",
      "thread-id": notification.hostId,
    },
    body: notification,
  };
}

let provider: { keyId: string; token: string; made: number } | undefined;

/** An ES256 provider token signed with the APNs key, reused for [`TOKEN_AGE`]. */
async function providerToken(env: Env): Promise<string> {
  const keyId = env.APNS_KEY_ID!;
  const now = Date.now();
  if (provider?.keyId === keyId && now - provider.made < TOKEN_AGE) return provider.token;
  const der = Uint8Array.from(atob(env.APNS_KEY!.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const signed = `${part({ alg: "ES256", kid: keyId })}.${part({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signed));
  provider = { keyId, token: `${signed}.${base64url(signature)}`, made: now };
  return provider.token;
}

/**
 * Sends `notification` to the iOS device with APNs token `device`. "gone" when Apple no longer
 * knows the token, so the caller drops it. Without the APNs secrets, as in tests and `wrangler
 * dev`, it only logs and answers "stubbed".
 */
export async function sendApns(
  env: Env,
  device: string,
  notification: Notification,
  send: typeof fetch = fetch,
): Promise<"sent" | "gone" | "failed" | "stubbed"> {
  const payload = JSON.stringify(apnsPayload(notification));
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    console.log("apns (stub)", device.slice(0, 8), payload);
    return "stubbed";
  }
  const token = await providerToken(env);
  for (const server of SERVERS) {
    const answer = await send(`${server}/3/device/${device}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      body: payload,
    });
    if (answer.ok) return "sent";
    const { reason } = await answer.json<{ reason?: string }>().catch(() => ({ reason: undefined }));
    if (answer.status === 410) return "gone";
    if (reason === "BadDeviceToken") continue;
    console.log("apns", answer.status, reason);
    return "failed";
  }
  return "gone";
}
