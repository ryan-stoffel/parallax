// Local-only fixture. Never imported by the production entry point or migration config.
import worker, { type Env, network, StreamRelay, UserAccount } from "../src/index";
import { HostRelay } from "../src/host";
import { verifySession } from "../src/clerk";
import { randomToken, same, sha256 } from "../src/crypto";
import { JOIN_TIMEOUT, MIN_FRAME_BYTES, REPORT_BYTES, REPORT_AFTER } from "../src/stream";
export { StreamRelay, UserAccount };

type Slot = {
  tokenHash: string; client?: WebSocket; joined: boolean; bytes: number;
  due: number; ending: boolean;
};
export class ProofHost extends HostRelay {
  private slots = new Map<string, Slot>();
  private carrier?: WebSocket;
  private token?: string;

  protected override async armStream(object: Parameters<HostRelay["armStream"]>[0],
    armed: Parameters<HostRelay["armStream"]>[1], spare: boolean, proof = false) {
    if (!proof) return super.armStream(object, armed, spare);
    if (!this.carrier) throw new Error("proof carrier unavailable");
    this.slots.set(armed.stream, { tokenHash: armed.tokenHash, joined: false, bytes: 0,
      due: Date.now() + JOIN_TIMEOUT, ending: false });
    await this.scheduleProof();
    return { proof: true };
  }
  protected override streamObject(host: string, id: string) {
    if (!this.slots.has(id)) return super.streamObject(host, id);
    return {
      arm: async () => {},
      close: async (code: number, reason: string) => { await this.finish(id, code, reason); },
      hostJoined: async () => this.slots.get(id)?.joined === true,
      taken: async () => {},
      hostGone: async () => { await this.finish(id); },
    };
  }
  private signal(id: string, t: string, extra = {}) {
    if (this.carrier?.readyState === WebSocket.OPEN)
      this.carrier.send(JSON.stringify({ t, id, ...extra }));
  }
  private ready(id: string) {
    const s = this.slots.get(id);
    if (s?.client && s.joined) {
      s.due = Infinity;
      s.client.send("ready");
      this.signal(id, "ready");
    }
  }
  async proofConnect(user: string): Promise<Response> {
    const refused = await this.admit(user);
    if (refused) return Response.json(refused, { status: refused.status });
    if (this.carrier?.readyState !== WebSocket.OPEN)
      return Response.json({ error: "carrier_unavailable" }, { status: 503 });
    const opened = await this.newStream(user, false, true);
    if ("error" in opened) return Response.json(opened, { status: opened.status });
    const s = this.slots.get(opened.stream);
    // A prejoined legacy spare uses precisely the old route and shared authority.
    if (!s) return this.env.STREAMS.get(this.env.STREAMS.idFromString(opened.stream))
      .fetch("https://stream/client", { headers: { upgrade: "websocket" } });
    const [client, server] = Object.values(new WebSocketPair());
    s.client = server!;
    server!.binaryType = "arraybuffer";
    server!.accept();
    server!.addEventListener("message", e => {
      if (typeof e.data !== "object" || !(e.data instanceof ArrayBuffer)) {
        void this.finish(opened.stream, 4400, "bad frame"); return;
      }
      void this.data(opened.stream, e.data, false);
    });
    server!.addEventListener("close", () => { void this.finish(opened.stream); });
    server!.addEventListener("error", () => { void this.finish(opened.stream); });
    this.ready(opened.stream);
    return new Response(null, { status: 101, webSocket: client });
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/proof-client")
      return this.proofConnect(request.headers.get("x-proof-user") ?? "");
    if (new URL(request.url).pathname.endsWith("/proof-data")) {
      if (!this.token || !same(new URL(request.url).searchParams.get("token") ?? "", this.token))
        return new Response(null, { status: 401 });
      this.token = undefined;
      const [client, server] = Object.values(new WebSocketPair());
      this.carrier = server!;
      server!.binaryType = "arraybuffer";
      server!.accept();
      server!.addEventListener("message", e => {
        if (this.carrier === server) void this.fromCarrier(e.data);
      });
      const lost = () => {
        try { server!.close(1000, "closed"); } catch {}
        if (this.carrier !== server) return;
        this.carrier = undefined;
        for (const id of this.slots.keys()) void this.finish(id, 1011, "carrier lost");
      };
      server!.addEventListener("close", lost);
      server!.addEventListener("error", lost);
      server!.send(JSON.stringify({ t: "ready" }));
      return new Response(null, { status: 101, webSocket: client });
    }
    // Original signed, replay-checked host control authentication issues a single-use carrier token.
    const response = await super.fetch(request);
    if (response.status === 101) {
      await this.replaceCarrier(true, "control epoch changed");
    }
    return response;
  }
  /** Local proof fault injection, with the same account ownership check as admission. */
  async proofCarrier(user: string, replace?: boolean) {
    const status = await this.status(user);
    if (!status?.online) return { status: 404 };
    if (replace !== undefined) await this.replaceCarrier(replace, "carrier replaced");
    return { status: 200, ready: this.carrier?.readyState === WebSocket.OPEN };
  }
  private async replaceCarrier(replace: boolean, reason: string) {
    this.token = undefined;
    const carrier = this.carrier;
    this.carrier = undefined; // Ignore any late messages from this generation before yielding.
    for (const id of this.slots.keys()) await this.finish(id, 1011, reason);
    if (carrier?.readyState === WebSocket.OPEN) carrier.close(1000, reason);
    if (replace) {
      this.token = randomToken();
      for (const ws of this.ctx.getWebSockets("host"))
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "proof", token: this.token }));
    }
  }
  private async fromCarrier(message: string | ArrayBuffer) {
    if (typeof message !== "string") {
      if (message.byteLength < 64 || message.byteLength > 64 + 65536) {
        this.carrier?.close(4400, "bad frame"); return;
      }
      const id = new TextDecoder().decode(message.slice(0, 64));
      await this.data(id, message.slice(64), true); return;
    }
    if (message.length > 512) { this.carrier?.close(4400, "bad control"); return; }
    const m = JSON.parse(message);
    const s = this.slots.get(m.id);
    if (!s || s.ending) return;
    if (m.t === "join" && !s.joined && same(await sha256(m.token), s.tokenHash)) {
      s.joined = true; this.ready(m.id);
    } else if (m.t === "fin") await this.finish(m.id);
    else this.carrier?.close(4400, "bad control");
  }
  private async data(id: string, bytes: ArrayBuffer, fromHost: boolean) {
    const s = this.slots.get(id);
    if (!s || s.ending || !s.joined || !s.client || !this.carrier || bytes.byteLength > 65536) {
      await this.finish(id, 4400, "not ready"); return;
    }
    if (fromHost) s.client.send(bytes);
    else {
      const frame = new Uint8Array(64 + bytes.byteLength);
      frame.set(new TextEncoder().encode(id)); frame.set(new Uint8Array(bytes), 64);
      this.carrier.send(frame);
    }
    s.bytes += Math.max(bytes.byteLength, MIN_FRAME_BYTES);
    s.due = Math.min(s.due, Date.now() + REPORT_AFTER);
    if (s.bytes >= REPORT_BYTES) await this.settle(id, false);
    await this.scheduleProof();
  }
  private async settle(id: string, closed: boolean) {
    const s = this.slots.get(id);
    if (!s) return;
    const bytes = s.bytes; s.bytes = 0;
    if (!(await this.report(id, bytes, closed)) && !closed) await this.finish(id, 4429, "daily limit");
  }
  private async finish(id: string, code = 1000, reason = "closed") {
    const s = this.slots.get(id);
    if (!s || s.ending) return;
    s.ending = true;
    // Drain notification is ordered after DATA, independently of accounting settlement.
    s.client?.close(code, reason); this.signal(id, "fin");
    await this.settle(id, true);
    this.slots.delete(id);
  }
  private async scheduleProof() {
    const due = Math.min(...[...this.slots.values()].map(s => s.due));
    if (Number.isFinite(due)) await this.ctx.storage.setAlarm(due);
  }
  override async alarm() {
    for (const [id, s] of this.slots) if (s.due <= Date.now()) {
      if (!s.client || !s.joined) await this.finish(id, 4408, "join expired");
      else { s.due = Infinity; await this.settle(id, false); }
    }
    await super.alarm(); await this.scheduleProof();
  }
}
export default {
  async fetch(request: Request, env: Env) {
    const match = new URL(request.url).pathname.match(/^\/v1\/hosts\/([\w-]{43})\/(proof-connect|proof-data|proof-carrier)$/);
    if (!match) return worker.fetch(request as Parameters<typeof worker.fetch>[0], env);
    if (match[2] !== "proof-carrier" && request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, {status:426});
    const address = network(request.headers.get("cf-connecting-ip") ?? "");
    if (!(await env.ANON.limit({key:`${address}:${match[1]}`})).success)
      return Response.json({error:"rate_limited"},{status:429});
    const host = env.HOSTS.get(env.HOSTS.idFromName(match[1]!)) as unknown as DurableObjectStub<ProofHost>;
    if (match[2] === "proof-data") return host.fetch(request);
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    const user = token ? await verifySession(env, token).catch(() => null) : null;
    if (!user) return new Response(null, { status: 401 });
    if (match[2] === "proof-carrier") {
      if (request.method === "GET") {
        const result = await host.proofCarrier(user);
        return Response.json(result, {status:result.status});
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json() as {replace?: unknown};
      if (typeof body.replace !== "boolean") return new Response(null, { status: 400 });
      const result = await host.proofCarrier(user, body.replace);
      return Response.json(result, {status:result.status});
    }
    return host.fetch("https://proof/proof-client", {headers: {upgrade: "websocket", "x-proof-user": user}});
  },
};
