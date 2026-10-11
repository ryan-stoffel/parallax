import { DurableObject } from "cloudflare:workers";

import { Limiter } from "./crypto";
import type { Env } from "./index";
import { type Notification, sendApns } from "./push";

/** Per-user limits, each per minute. */
export const USER_LIMITS = { requests: 120, pushes: 120 };

/** How many hosts one user may register, so one account's cost has a ceiling (0068). */
export const MAX_HOSTS = 10;
const MAX_DEVICES = 20;
/** An APNs device token: 32 or more bytes in hex. */
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;

/** One Clerk user on the relay: the hosts they registered, their devices, and their limits. */
export class UserAccount extends DurableObject<Env> {
  private limits = new Limiter();
  /** The notifications the APNs stub would have sent, newest last. Read by tests. */
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

  /** Registers an iOS device's APNs token for push. False when it isn't one. */
  async addDevice(token: string): Promise<boolean> {
    const device = token.toLowerCase();
    if (!DEVICE_TOKEN.test(device)) return false;
    const devices = (await this.devices()).filter((d) => d !== device);
    devices.push(device);
    await this.ctx.storage.put("devices", devices.slice(-MAX_DEVICES));
    return true;
  }

  async removeDevice(token: string) {
    const devices = await this.devices();
    await this.ctx.storage.put(
      "devices",
      devices.filter((d) => d !== token.toLowerCase()),
    );
  }

  private async devices(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("devices")) ?? [];
  }

  /** Tells this user's devices that run `run` on host `hostId` needs them, finished, or failed. */
  async push(hostId: string, run: string, state: Notification["state"]) {
    if (!this.limits.allow("pushes", USER_LIMITS.pushes)) return;
    const notification: Notification = { hostId, run, state };
    for (const device of await this.devices()) {
      if ((await sendApns(this.env, device, notification)) === "stubbed") {
        this.outbox.push({ device, notification });
        this.outbox.splice(0, this.outbox.length - 50);
      }
    }
  }
}
