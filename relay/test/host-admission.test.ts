import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { accountOf } from "../src/clerk";
import { type HostRelay, MAX_STREAMS } from "../src/host";
import { StreamRelay } from "../src/stream";
import { connectHost, newHost, register, session, testEnv } from "./helpers";

async function fixture() {
  const user = `admission_${crypto.randomUUID()}`;
  const host = await newHost();
  expect((await register(host, await session(user))).status).toBe(200);
  const { control } = await connectHost(host);
  await control.next();
  const stub = testEnv.HOSTS.get(testEnv.HOSTS.idFromName(host.id));
  return { host, control, stub, user: accountOf("https://clerk.test", user) };
}
it("17 concurrent public opens share the legacy spare and pending 16-slot ledger", async () => {
  const { stub, user, control } = await fixture();
  try {
    control.ws.send(JSON.stringify({ t: "spare" }));
    const spare = JSON.parse(await control.next() as string) as { stream: string; spare: boolean };
    expect(spare.spare).toBe(true);
    const results = await Promise.all(Array.from({ length: 17 }, () => stub.open(user)));
    const accepted = results.filter((r) => !("error" in r));
    const refused = results.filter((r) => "error" in r);
    const count = await runInDurableObject(stub, async (_: HostRelay, state) =>
      Object.keys((await state.storage.get<object>("streams")) ?? {}).length);
    const distinct = new Set(accepted.map((r) => "stream" in r ? r.stream : "")).size;
    expect({ accepted: accepted.length, distinct, slots: count, refused }).toEqual({
      accepted: MAX_STREAMS, distinct: MAX_STREAMS, slots: MAX_STREAMS,
      refused: [{ status: 429, error: "too_many_streams" }],
    });
    expect(accepted.some((r) => "stream" in r && r.stream === spare.stream)).toBe(true);
  } finally { await stub.unregister(user); control.ws.close(); }
});

async function ledger(stub: ReturnType<typeof testEnv.HOSTS.get>) {
  return runInDurableObject(stub, async (_: HostRelay, state) =>
    (await state.storage.get<Record<string, { pending?: true; spare?: true }>>("streams")) ?? {});
}

it.each(["open", "ticket"] as const)("caps 17 parallel %s admissions without a spare", async (kind) => {
  const { stub, user, control } = await fixture();
  try {
    const tickets = kind === "ticket"
      ? await Promise.all(Array.from({ length: 17 }, () => stub.ticket(user)))
      : [];
    const results = await Promise.all(Array.from({ length: 17 }, (_, i) => {
      const ticket = tickets[i];
      return ticket && "ticket" in ticket ? stub.redeem(ticket.ticket) : stub.open(user);
    }));
    const accepted = results.filter((r) => "stream" in r);
    expect(new Set(accepted.map((r) => r.stream)).size).toBe(MAX_STREAMS);
    expect(results.filter((r) => "error" in r)).toEqual([{ status: 429, error: "too_many_streams" }]);
    expect(Object.keys(await ledger(stub))).toHaveLength(MAX_STREAMS);
    expect(Object.values(await ledger(stub)).some((s) => s.pending)).toBe(false);
  } finally { await stub.unregister(user); control.ws.close(); }
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it("counts pending arms while other admissions proceed without a global RPC gate", async () => {
  const { stub, user, control } = await fixture();
  let entered = false;
  const resume = latch();
  const arm = StreamRelay.prototype.arm;
  let first = true;
  const spy = vi.spyOn(StreamRelay.prototype, "arm").mockImplementation(async function (this: StreamRelay, args) {
    if (first) {
      first = false;
      entered = true;
      await resume.promise;
    }
    return arm.call(this, args);
  });
  const pending = stub.open(user);
  try {
    await expect.poll(() => entered).toBe(true);
    expect(Object.values(await ledger(stub))).toEqual([{ pending: true }]);
    const others = await Promise.all(Array.from({ length: 16 }, () => stub.open(user)));
    expect(others.filter((r) => "stream" in r)).toHaveLength(15);
    expect(others.filter((r) => "error" in r)).toEqual([{ status: 429, error: "too_many_streams" }]);
    expect(Object.keys(await ledger(stub))).toHaveLength(MAX_STREAMS);
    resume.release();
    expect(await pending).toHaveProperty("stream");
  } finally {
    resume.release();
    await pending;
    spy.mockRestore();
    await stub.unregister(user);
    control.ws.close();
  }
});

it.each(["before", "after"] as const)("releases capacity when arm fails %s committing", async (stage) => {
  const { stub, user, control } = await fixture();
  const arm = StreamRelay.prototype.arm;
  let failedId = "";
  const spy = vi.spyOn(StreamRelay.prototype, "arm").mockImplementationOnce(async function (this: StreamRelay, args) {
    failedId = args.stream;
    if (stage === "after") await arm.call(this, args);
    throw new Error("injected arm failure");
  });
  try {
    const error = await runInDurableObject(stub, async (relay: HostRelay) => {
      try { await relay.open(user); return ""; }
      catch (error) { return (error as Error).message; }
    });
    expect(error).toContain("injected arm failure");
    expect(await ledger(stub)).toEqual({});
    const object = testEnv.STREAMS.get(testEnv.STREAMS.idFromString(failedId));
    expect(await runInDurableObject(object, (_, state) => state.storage.get("armed"))).toBeUndefined();
    expect(await stub.open(user)).toHaveProperty("stream");
    expect(Object.keys(await ledger(stub))).toHaveLength(1);
  } finally { spy.mockRestore(); await stub.unregister(user); control.ws.close(); }
});

it.each(
  (["reconnect", "move", "unregister", "report", "gone"] as const)
    .flatMap((cancel) => (["before", "after"] as const).map((stage) => ({ cancel, stage }))),
)(
  "does not resurrect a pending arm canceled by $cancel $stage arm commits", async ({ cancel, stage }) => {
    const { host, stub, user, control } = await fixture();
    let entered = false;
    const resume = latch();
    const arm = StreamRelay.prototype.arm;
    let stream = "";
    const spy = vi.spyOn(StreamRelay.prototype, "arm").mockImplementationOnce(async function (this: StreamRelay, args) {
      stream = args.stream;
      if (stage === "after") await arm.call(this, args);
      entered = true;
      await resume.promise;
      if (stage === "before") await arm.call(this, args);
    });
    const pending = stub.open(user);
    let nextControl = control;
    let nextUser = user;
    try {
      await expect.poll(() => entered).toBe(true);
      if (cancel === "reconnect") {
        nextControl = (await connectHost(host)).control;
        await nextControl.next();
      } else if (cancel === "move") {
        const name = `admission_${crypto.randomUUID()}`;
        expect((await register(host, await session(name))).status).toBe(200);
        nextUser = accountOf("https://clerk.test", name);
      } else if (cancel === "unregister") {
        expect(await stub.unregister(user)).toBe(true);
      } else if (cancel === "report") {
        await stub.report(stream, 0, true);
      } else {
        control.ws.send(JSON.stringify({ t: "gone", stream }));
        await expect.poll(() => ledger(stub)).toEqual({});
      }
      expect(await ledger(stub)).toEqual({});
      resume.release();
      expect(await pending).toEqual({ status: 503, error: "host_offline" });
      expect(await ledger(stub)).toEqual({});
      const object = testEnv.STREAMS.get(testEnv.STREAMS.idFromString(stream));
      expect(await runInDurableObject(object, (_, state) => state.storage.get("armed"))).toBeUndefined();
      if (cancel === "move") expect((await stub.status(nextUser))?.usage.bytes).toBe(0);
      if (cancel === "reconnect" || cancel === "report" || cancel === "gone")
        expect(await stub.open(user)).toHaveProperty("stream");
    } finally {
      resume.release();
      await pending;
      spy.mockRestore();
      await stub.unregister(nextUser);
      nextControl.ws.close();
      control.ws.close();
    }
  },
);

it("counts a pending spare without exposing it before arm completes", async () => {
  const { stub, user, control } = await fixture();
  const resume = latch();
  const arm = StreamRelay.prototype.arm;
  let entered = false;
  let spare = "";
  const spy = vi.spyOn(StreamRelay.prototype, "arm").mockImplementationOnce(async function (this: StreamRelay, args) {
    spare = args.stream;
    entered = true;
    await resume.promise;
    return arm.call(this, args);
  });
  try {
    control.ws.send(JSON.stringify({ t: "spare" }));
    await expect.poll(() => entered).toBe(true);
    expect(await ledger(stub)).toEqual({ [spare]: { pending: true, spare: true } });
    const results = await Promise.all(Array.from({ length: 17 }, () => stub.open(user)));
    expect(results.filter((r) => "stream" in r)).toHaveLength(15);
    expect(results.filter((r) => "error" in r)).toEqual(Array(2).fill({ status: 429, error: "too_many_streams" }));
    expect(results.some((r) => "stream" in r && r.stream === spare)).toBe(false);
    expect(Object.keys(await ledger(stub))).toHaveLength(MAX_STREAMS);
    resume.release();
    await expect.poll(async () => (await ledger(stub))[spare]).toEqual({ spare: true });
    expect(await stub.open(user)).toEqual({ stream: spare });
    expect(Object.keys(await ledger(stub))).toHaveLength(MAX_STREAMS);
  } finally {
    resume.release();
    spy.mockRestore();
    await stub.unregister(user);
    control.ws.close();
  }
});
