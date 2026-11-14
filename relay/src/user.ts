import { DurableObject } from "cloudflare:workers";

import { Limiter } from "./crypto";
import type { Env } from "./index";
import { FCM, type Notification, sendApns, sendFcm } from "./push";

/** Per-user limits, each per minute. */
export const USER_LIMITS = { requests: 120, pushes: 120 };

/** How many hosts one user may register, so one account's cost has a ceiling (0068). */
export const MAX_HOSTS = 10;
/** How many removed hosts one user's list keeps, newest last, so its size has a ceiling. */
const MAX_REMOVED = 100;
const MAX_DEVICES = 20;
/** An APNs device token: 32 or more bytes in hex. */
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
/** An FCM registration token. Google doesn't promise its form, so only what one has held:
 *  letters, digits, and `:-_`, about 160 characters. */
const FCM_TOKEN = /^[A-Za-z0-9:_-]{100,400}$/;

/** One Clerk user on the relay: the hosts they registered, their devices, and their limits. */
export class UserAccount extends DurableObject<Env> {
  private limits = new Limiter();
  /** The notifications the APNs and FCM stubs would have sent, newest last. Read by tests. */
  outbox: { device: string; notification: Notification }[] = [];

  /** Whether one more signed-in request fits in this minute. */
  allow(): boolean {
    return this.limits.allow("requests", USER_LIMITS.requests);
  }

  /** The hosts this user owns, by id. A host that moves to another user, or is removed, leaves
   *  the list and frees its slot. */
  hosts(): string[] {
    return this.ctx.storage.kv.get<string[]>("hosts") ?? [];
  }

  /**
   * Reserves a slot for `hostId`, unless it's this user's already or [`MAX_HOSTS`] are taken.
   * Synchronous storage, so concurrent registrations can't both take the last slot. [`release`]
   * gives a reserved slot back when the registration fails.
   */
  reserve(hostId: string): "reserved" | "owned" | "full" {
    const hosts = this.hosts();
    if (hosts.includes(hostId)) return "owned";
    if (hosts.length >= MAX_HOSTS) return "full";
    this.ctx.storage.kv.put("hosts", [...hosts, hostId]);
    return "reserved";
  }

  release(hostId: string) {
    this.ctx.storage.kv.put(
      "hosts",
      this.hosts().filter((id) => id !== hostId),
    );
  }

  /**
   * The hosts that left this user's account, by Remove or by moving to another user, until they
   * register under this user again. The only proof that a host left: a list without it may come
   * from a relay that lost its data, whose marks are gone too, so nothing reads as removed.
   */
  removed(): string[] {
    return this.ctx.storage.kv.get<string[]>("removed") ?? [];
  }

  /** `hostId` left this account: its slot is free, and `removed` lists it. */
  left(hostId: string) {
    this.release(hostId);
    const removed = this.removed().filter((id) => id !== hostId);
    this.ctx.storage.kv.put("removed", [...removed, hostId].slice(-MAX_REMOVED));
  }

  /** `hostId` registered under this user, so it's back on the account. */
  joined(hostId: string) {
    const removed = this.removed();
    if (removed.includes(hostId))
      this.ctx.storage.kv.put(
        "removed",
        removed.filter((id) => id !== hostId),
      );
  }

  /** Registers an iOS device's APNs token, or an Android device's FCM token, for push. False when
   *  it isn't one. */
  async addDevice(token: string, android = false): Promise<boolean> {
    const device = android ? `${FCM}${token}` : token.toLowerCase();
    if (!(android ? FCM_TOKEN.test(token) : DEVICE_TOKEN.test(device))) return false;
    const devices = (await this.devices()).filter((d) => d !== device);
    devices.push(device);
    await this.ctx.storage.put("devices", devices.slice(-MAX_DEVICES));
    return true;
  }

  /** Forgets `device`, as kept: an APNs token in any case, or `fcm:` and an FCM token, whose case
   *  matters. */
  async removeDevice(device: string) {
    const devices = await this.devices();
    await this.ctx.storage.put(
      "devices",
      devices.filter((d) => d !== device && d !== device.toLowerCase()),
    );
  }

  private async devices() {
    return (await this.ctx.storage.get<string[]>("devices")) ?? [];
  }

  /** Tells this user's devices that run `run` on host `hostId` needs them, finished, or failed,
   *  with its title and text in `sealed` if plxd sent them, and forgets any device Apple or FCM no
   *  longer knows. */
  async push(hostId: string, run: string, state: Notification["state"], sealed?: string) {
    if (!this.limits.allow("pushes", USER_LIMITS.pushes)) return;
    const notification: Notification = { hostId, run, state, ...(sealed && { sealed }) };
    for (const device of await this.devices()) {
      const sent = device.startsWith(FCM)
        ? await sendFcm(this.env, device.slice(FCM.length), notification)
        : await sendApns(this.env, device, notification);
      if (sent === "gone") await this.removeDevice(device);
      if (sent === "stubbed") {
        this.outbox.push({ device, notification });
        this.outbox.splice(0, this.outbox.length - 50);
      }
    }
  }
}
