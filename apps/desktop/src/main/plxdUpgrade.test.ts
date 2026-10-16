import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, vi } from "vite-plus/test";

import type { ConnectionState, WatchMessage } from "../preload/bridge";
import { Connection } from "./connection";
import { plxdVersion, replaceServe, type ServeService } from "./plxd";

// Opt in with a locally built plxd. Every process and service belongs to a temporary data folder.
const binary = process.env["PLX_TEST_PLXD"];
for (const kind of ["bundled", "service", "external"]) {
  const loginService = kind === "service";
  const external = kind === "external";
  test.skipIf(
    !binary || process.platform === "win32" || (loginService && process.platform !== "darwin"),
  )(
    `a real ${kind} daemon reconnects with the correct version and process`,
    async () => {
      const dir = mkdtempSync("/tmp/plx700-");
      const data = path.join(dir, "data");
      const label = `io.parallax.test.plx700-${path.basename(dir)}`;
      const env = { ...process.env, PLXD_DATA_DIR: data, PLXD_SERVICE_LABEL: label };
      const bundle = (name: string, version: string) => {
        const resources =
          name === "External"
            ? path.join(dir, "external")
            : path.join(dir, `${name}.app`, "Contents", "Resources");
        mkdirSync(resources, { recursive: true });
        const plxd = path.join(resources, "plxd");
        copyFileSync(binary!, plxd);
        writeFileSync(path.join(resources, "plxd.version"), `${version}\n`);
        return plxd;
      };
      const old = bundle(external ? "External" : "Old", "1.0.0");
      const current = bundle("Current", "1.1.0");
      const run = (plxd: string, ...args: string[]) =>
        promisify(execFile)(plxd, args, { env, timeout: 20_000 });
      const service: ServeService = {
        status: async () => {
          const { stdout } = await run(current, "service", "status", "--label", label);
          const pid = /^pid: (\d+)$/m.exec(stdout)?.[1];
          return {
            ...(pid && { pid: Number(pid) }),
            ready: /^answers initialize: true$/m.test(stdout),
          };
        },
        replace: async () => {
          await run(current, "service", "install", "--replace", "--label", label);
        },
      };
      const lockPid = () => Number.parseInt(readFileSync(path.join(data, "plxd.lock"), "utf8"));
      const states: ConnectionState[] = [];
      const connect = (replaceDaemon?: (version: string) => Promise<boolean>) =>
        new Connection({
          command: () => [current, "attach"],
          clientVersion: "1.1.0",
          onState: (state) => states.push(state),
          ...(replaceDaemon && { replaceDaemon }),
          spawn: (file, args) => spawn(file, args, { env, stdio: "pipe" }),
        });
      let serve: ChildProcess | undefined;
      let probe: Connection | undefined;
      let upgraded: Connection | undefined;
      try {
        if (loginService) await run(old, "service", "install", "--label", label);
        else serve = spawn(old, ["serve"], { env, stdio: "ignore" });
        await vi.waitFor(() => expect(existsSync(path.join(data, "plxd.sock"))).toBe(true), {
          timeout: 10_000,
        });
        const oldPid = lockPid();
        probe = connect();
        probe.start();
        await vi.waitFor(
          () => expect(probe?.state).toMatchObject({ status: "connected", plxd: "1.0.0" }),
          { timeout: 10_000 },
        );
        // An app update changes the file on disk. The already running daemon keeps its snapshot.
        writeFileSync(path.join(path.dirname(old), "plxd.version"), "1.1.0\n");
        expect(await plxdVersion(old)).toBe("1.1.0");
        expect(await probe.request("host/version", {})).toMatchObject({
          result: { plxd: "1.0.0" },
        });
        probe.dispose();
        states.length = 0;
        const messages: WatchMessage[] = [];
        upgraded = connect(
          async (running) =>
            (
              await replaceServe(
                data,
                running,
                await plxdVersion(current),
                undefined,
                loginService ? service : undefined,
              )
            ).stopped,
        );
        upgraded.watch({ shell: true }, (message) => messages.push(message));
        upgraded.start();
        const expectedVersion = external ? "1.0.0" : "1.1.0";
        await vi.waitFor(
          () =>
            expect(upgraded?.state).toMatchObject({ status: "connected", plxd: expectedVersion }),
          { timeout: 15_000 },
        );
        await vi.waitFor(
          () => expect(messages.some((message) => message.type === "snapshot")).toBe(true),
          { timeout: 10_000 },
        );
        expect(states.filter((state) => state.status === "connected")).toEqual([
          expect.objectContaining({ plxd: expectedVersion }),
        ]);
        expect(messages.some((message) => message.type === "error")).toBe(false);
        if (external) expect(lockPid()).toBe(oldPid);
        else expect(lockPid()).not.toBe(oldPid);
        if (loginService) {
          expect(await service.status()).toEqual({ pid: lockPid(), ready: true });
          const { stdout } = await run(current, "service", "status", "--label", label);
          expect(readFileSync(/^file: (.*)$/m.exec(stdout)![1]!, "utf8")).toContain(current);
        }
      } finally {
        probe?.dispose();
        upgraded?.dispose();
        if (loginService) await run(current, "service", "uninstall", "--label", label);
        if (existsSync(path.join(data, "plxd.lock"))) {
          try {
            process.kill(lockPid());
          } catch {
            /* Already exited. */
          }
        }
        serve?.kill();
        await vi.waitFor(() => expect(existsSync(path.join(data, "plxd.sock"))).toBe(false), {
          timeout: 10_000,
        });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );
}
