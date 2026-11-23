import { afterEach, expect, test, vi } from "vitest";

// What the phone keeps: its private files, as `expo-file-system` writes them, and the keychain.
const stored = vi.hoisted(() => ({ files: new Map<string, string>(), keychain: new Map<string, string>() }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly path: string) {}
    get exists() {
      return stored.files.has(this.path);
    }
    textSync() {
      return stored.files.get(this.path) ?? "";
    }
    write(text: string) {
      stored.files.set(this.path, text);
    }
  },
}));
vi.mock("expo-secure-store", () => ({
  setItemAsync: async (key: string, value: string) => void stored.keychain.set(key, value),
  getItemAsync: async (key: string) => stored.keychain.get(key) ?? null,
}));
vi.mock("../modules/pinned-tls", () => ({ privateFile: (name: string) => `/private/${name}` }));

import { logAppEvent } from "./connectionLog";
import { createGuestLink, forgetGuestLink, guestLinkUrl, hasGuestLink } from "./guestShare";

const secret = ["not", "a", "real", "guest", "secret"].join("-");
const link = {
  id: "link-1",
  threadId: "thread-1",
  createdAt: "2026-11-23T00:00:00Z",
  expiresAt: "2026-11-24T00:00:00Z",
};
const fragment = `host-1.${link.id}.${secret}`;

afterEach(() => vi.restoreAllMocks());

test("a guest link's secret is held in memory until it's copied or shared, and never stored or logged (0108)", async () => {
  const printed: unknown[][] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => void printed.push(args));
  const asked: unknown[] = [];
  const request = async (method: string, params: unknown) => {
    asked.push([method, params]);
    return { result: { link, fragment } };
  };

  // What a screen gets back, and may keep in its state, is the link without its secret.
  const made = await createGuestLink(request, link.threadId, false);
  expect(made).toEqual(link);
  expect(asked).toEqual([["guest/create", { threadId: link.threadId }]]);
  expect(hasGuestLink(link.id)).toBe(true);

  // The URL goes to the clipboard or the share sheet, and then it's gone.
  expect(guestLinkUrl(link.id)).toBe(`https://app.parallax.codes/g#${fragment}`);
  forgetGuestLink(link.id);
  expect(hasGuestLink(link.id)).toBe(false);
  expect(guestLinkUrl(link.id)).toBeUndefined();

  // The log is written as the app writes it, so the check below reads a real file.
  logAppEvent("guest_link_test", { thread: link.threadId });
  expect(stored.files.get("/private/connection-log.txt")).toContain("guest_link_test");
  expect(JSON.stringify([...stored.files])).not.toContain(secret);
  expect(JSON.stringify([...stored.keychain])).not.toContain(secret);
  expect(JSON.stringify(printed)).not.toContain(secret);
});

test("a refusal is plxd's own words, and holds nothing", async () => {
  const refused = async () => ({ error: { message: "Parallax on the web is off on this computer." } });
  expect(await createGuestLink(refused, link.threadId, true)).toBe(
    "Parallax on the web is off on this computer.",
  );
  expect(hasGuestLink(link.id)).toBe(false);
});
