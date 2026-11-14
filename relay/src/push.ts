import { base64url } from "./crypto";
import type { Env } from "./index";

/**
 * What plxd says about a run. `sealed` is the thread's title and the start of its reply, encrypted
 * with a key only the user's phones hold (0100): the relay never decodes it, and never logs it.
 */
export type Notification = {
  hostId: string;
  run: string;
  state: "needsYou" | "done" | "failed";
  sealed?: string;
};

/** The longest `sealed` the relay carries. plxd's longest fits (`daemon/src/relay/seal.rs`), and
 *  this leaves the APNs payload well under its 4 KB. */
export const MAX_SEALED = 2400;

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
 * its data, from which it opens the run. With `sealed`, `mutable-content` wakes the phone's
 * notification service extension to open it, and the fixed text stands if that can't.
 */
export function apnsPayload(notification: Notification) {
  return {
    aps: {
      alert: { title: "Parallax", body: TEXT[notification.state] },
      sound: "default",
      "thread-id": notification.hostId,
      ...(notification.sealed && { "mutable-content": 1 }),
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
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) {
    console.log("apns (stub)", device.slice(0, 8), notification.run, notification.state);
    return "stubbed";
  }
  const payload = JSON.stringify(apnsPayload(notification));
  const token = await providerToken(env);
  for (const server of SERVERS) {
    const answer = await send(`${server}/3/device/${device}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        // The app's own notification for this event has the same id (`apps/mobile/src/push.ts`),
        // so iOS keeps one. APNs takes at most 64 bytes.
        "apns-collapse-id": `${notification.run}:${notification.state}`.slice(0, 64),
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

/** How the relay keeps an Android device: `fcm:` and its FCM registration token, in the same list
 *  as iOS's bare APNs tokens. */
export const FCM = "fcm:";

/**
 * The FCM v1 message for `notification` to the Android device with token `device`. It's data
 * only, so FCM never shows it itself and the app's background task gets it even while the app is
 * closed. expo-notifications shows `title` and `message` (the fixed text) under `tag`, the id the
 * app's own notification for this event has, and gives `body` to the app as the notification's
 * data, as on iOS. The task then opens `sealed` and replaces it under the same id (0100).
 */
export function fcmMessage(device: string, notification: Notification) {
  return {
    message: {
      token: device,
      android: { priority: "HIGH" },
      data: {
        title: "Parallax",
        message: TEXT[notification.state],
        tag: `${notification.run}:${notification.state}`,
        body: JSON.stringify(notification),
      },
    },
  };
}

/** The fields of a Google service account key (its JSON) that sending needs. */
type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri?: string };

let access: { account: string; token: string; made: number } | undefined;

/** An OAuth access token for FCM, from a JWT signed with the service account's key, reused for
 *  [`TOKEN_AGE`]. Google's last an hour. */
async function accessToken(account: ServiceAccount, send: typeof fetch): Promise<string | undefined> {
  const now = Date.now();
  if (access?.account === account.client_email && now - access.made < TOKEN_AGE) return access.token;
  const der = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const part = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const uri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const claims = { iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: uri, iat, exp: iat + 3600 };
  const signed = `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signed));
  const answer = await send(uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${signed}.${base64url(signature)}` }),
  });
  const { access_token: token } = await answer.json<{ access_token?: string }>().catch(() => ({ access_token: undefined }));
  if (!answer.ok || !token) {
    console.log("fcm token", answer.status);
    return undefined;
  }
  access = { account: account.client_email, token, made: now };
  return token;
}

/**
 * Sends `notification` to the Android device with FCM token `device`. "gone" when FCM no longer
 * knows the token, so the caller drops it. Without `FCM_SERVICE_ACCOUNT`, as in tests and `wrangler
 * dev`, it only logs and answers "stubbed".
 */
export async function sendFcm(
  env: Env,
  device: string,
  notification: Notification,
  send: typeof fetch = fetch,
): Promise<"sent" | "gone" | "failed" | "stubbed"> {
  if (!env.FCM_SERVICE_ACCOUNT) {
    console.log("fcm (stub)", device.slice(0, 8), notification.run, notification.state);
    return "stubbed";
  }
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  const token = await accessToken(account, send);
  if (!token) return "failed";
  const answer = await send(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(fcmMessage(device, notification)),
  });
  if (answer.ok) return "sent";
  const { error } = await answer
    .json<{ error?: { status?: string; details?: { errorCode?: string }[] } }>()
    .catch(() => ({ error: undefined }));
  const code = error?.details?.find((d) => d.errorCode)?.errorCode;
  // FCM says UNREGISTERED for a token an uninstall or a reset retired, and NOT_FOUND for one it
  // never knew.
  if (answer.status === 404 || code === "UNREGISTERED") return "gone";
  console.log("fcm", answer.status, error?.status, code);
  return "failed";
}
