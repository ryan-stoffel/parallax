// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import { OpenFiles, SAVE_AFTER_MS, type FileBody } from "./openFiles";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const unb64 = (text: string) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
  );
const sha = (text: string) => `sha-${text}`;

/** plxd's folder: path to content. */
let disk: Map<string, string>;
let writes: { path: string; text: string; expected?: string }[];
/** When set, `agent/fileWrite` waits for this before answering. */
let holdWrite: Promise<void> | undefined;
let failWrite: string | undefined;

type Asked = {
  path: string;
  sizeOnly?: boolean;
  hash?: boolean;
  content: string;
  expectedSha256?: string;
};
const request = vi.fn(async (_host: string, method: string, p: Asked) => {
  if (method === "agent/file") {
    const text = disk.get(p.path);
    if (text === undefined)
      return { logId: "l", result: { path: p.path, exists: false, tooLarge: false } };
    return {
      logId: "l",
      result: {
        path: p.path,
        exists: true,
        tooLarge: false,
        size: text.length,
        ...(!p.sizeOnly && { content: b64(text) }),
        ...(p.hash && { sha256: sha(text) }),
      },
    };
  }
  if (method === "agent/fileWrite") {
    const text = unb64(p.content);
    writes.push({ path: p.path, text, expected: p.expectedSha256 });
    if (holdWrite) await holdWrite;
    if (failWrite) return { logId: "l", error: { code: -32603, message: failWrite } };
    const current = disk.get(p.path);
    const now = current === undefined ? undefined : sha(current);
    if (now !== p.expectedSha256)
      return { logId: "l", result: { conflict: true, ...(now && { sha256: now }) } };
    disk.set(p.path, text);
    return { logId: "l", result: { conflict: false, sha256: sha(text) } };
  }
  throw new Error(method);
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

function textBody(store: OpenFiles, id: number): Extract<FileBody, { kind: "text" }> {
  const body = store.get().tabs.find((f) => f.id === id)?.body;
  if (body?.kind !== "text") throw new Error(`not text: ${body?.kind}`);
  return body;
}
const tab = (store: OpenFiles, id: number) => store.get().tabs.find((f) => f.id === id);

async function opened(path = "a.ts", writable = true) {
  const store = new OpenFiles("local", "run-1");
  store.writable = writable;
  const id = store.open(path);
  await settle();
  return { store, id };
}

beforeEach(() => {
  vi.useFakeTimers();
  disk = new Map([["a.ts", "one\n"]]);
  writes = [];
  holdWrite = undefined;
  failWrite = undefined;
  request.mockClear();
  localStorage.clear();
  window.parallax = {
    request,
    connectionState: async () => ({ status: "connected" }),
  } as unknown as ParallaxBridge;
});
afterEach(() => {
  vi.useRealTimers();
});

test("an edit saves after a pause, once, from the content it was edited from", async () => {
  const { store, id } = await opened();
  store.edited(id, () => "t");
  store.edited(id, () => "tw");
  store.edited(id, () => "two\n");
  expect(tab(store, id)?.save).toBe("edited");
  await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS - 1);
  expect(writes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await settle();
  expect(writes).toEqual([{ path: "a.ts", text: "two\n", expected: sha("one\n") }]);
  expect(disk.get("a.ts")).toBe("two\n");
  expect(tab(store, id)?.save).toBe("saved");
  expect(textBody(store, id).sha256).toBe(sha("two\n"));
});

test("typing during a save saves again, from what the first save wrote", async () => {
  const { store, id } = await opened();
  let release = () => {};
  holdWrite = new Promise((done) => (release = done));
  store.edited(id, () => "two\n");
  const first = store.save(id);
  await settle();
  store.edited(id, () => "three\n");
  holdWrite = undefined;
  release();
  await first;
  await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS);
  await settle();
  expect(writes.map((w) => [w.text, w.expected])).toEqual([
    ["two\n", sha("one\n")],
    ["three\n", sha("two\n")],
  ]);
  expect(disk.get("a.ts")).toBe("three\n");
  expect(tab(store, id)?.save).toBe("saved");
});

test("an unedited file takes changes on disk, and keeps counting reloads", async () => {
  const { store, id } = await opened();
  disk.set("a.ts", "the agent's\n");
  await store.check(id);
  await settle();
  const body = textBody(store, id);
  expect(body.text).toBe("the agent's\n");
  expect(body.reloads).toBe(1);
  expect(tab(store, id)?.conflict).toBeUndefined();
  expect(writes).toEqual([]);
});

test("an edited file keeps your text when disk changes, until Reload or Overwrite", async () => {
  const { store, id } = await opened();
  store.edited(id, () => "mine\n");
  disk.set("a.ts", "the agent's\n");
  await store.check(id);
  expect(tab(store, id)?.conflict).toEqual({ sha256: sha("the agent's\n") });

  // A conflict holds its saves.
  await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS * 2);
  expect(writes).toEqual([]);
  expect(disk.get("a.ts")).toBe("the agent's\n");

  await store.overwrite(id);
  await settle();
  expect(writes).toEqual([{ path: "a.ts", text: "mine\n", expected: sha("the agent's\n") }]);
  expect(disk.get("a.ts")).toBe("mine\n");
  expect(tab(store, id)?.conflict).toBeUndefined();
  expect(tab(store, id)?.save).toBe("saved");
});

test("Reload drops edits for what's on disk", async () => {
  const { store, id } = await opened();
  store.edited(id, () => "mine\n");
  disk.set("a.ts", "the agent's\n");
  await store.check(id);
  await store.reload(id);
  expect(textBody(store, id).text).toBe("the agent's\n");
  expect(store.unsaved(id)).toBe(false);
  expect(store.textNow(id)).toBe("the agent's\n");
  await vi.advanceTimersByTimeAsync(SAVE_AFTER_MS * 2);
  expect(writes).toEqual([]);
});

test("a save that lands after a write plxd saw first becomes a conflict, and writes nothing", async () => {
  const { store, id } = await opened();
  store.edited(id, () => "mine\n");
  disk.set("a.ts", "the agent's\n");
  await store.save(id);
  expect(disk.get("a.ts")).toBe("the agent's\n");
  expect(tab(store, id)?.conflict).toEqual({ sha256: sha("the agent's\n") });
});

test("a deleted file says so, and Save again puts it back", async () => {
  const { store, id } = await opened();
  disk.delete("a.ts");
  await store.check(id);
  expect(tab(store, id)?.conflict).toEqual({});
  await store.overwrite(id);
  await settle();
  expect(writes.at(-1)).toEqual({ path: "a.ts", text: "one\n", expected: undefined });
  expect(disk.get("a.ts")).toBe("one\n");
});

test("a failed save keeps the edits and tries again on the next check", async () => {
  const { store, id } = await opened();
  failWrite = "disk full";
  store.edited(id, () => "two\n");
  await store.save(id);
  expect(tab(store, id)?.save).toBe("failed");
  expect(tab(store, id)?.saveError).toContain("disk full");
  expect(store.unsaved(id)).toBe(true);

  failWrite = undefined;
  await store.check(id);
  await settle();
  expect(disk.get("a.ts")).toBe("two\n");
  expect(tab(store, id)?.save).toBe("saved");
});

test("closing a tab waits for its save, and refuses when the edits can't land", async () => {
  const { store, id } = await opened();
  store.edited(id, () => "two\n");
  expect(await store.close(id)).toBe(true);
  expect(disk.get("a.ts")).toBe("two\n");
  expect(store.get().tabs).toEqual([]);

  const again = store.open("a.ts");
  await settle();
  failWrite = "nope";
  store.edited(again, () => "three\n");
  expect(await store.close(again)).toBe(false);
  expect(tab(store, again)).toBeDefined();
  store.discard(again);
  expect(store.get().tabs).toEqual([]);
  expect(disk.get("a.ts")).toBe("two\n");
});

test("a save keeps the file's line endings and BOM", async () => {
  disk.set("win.txt", "﻿one\r\ntwo\r\n");
  const { store, id } = await opened("win.txt");
  const body = textBody(store, id);
  expect(body.text).toBe("one\ntwo\n");
  expect(body.eol).toBe("\r\n");
  expect(body.readOnly).toBeUndefined();
  store.edited(id, () => "one\nthree\n");
  await store.save(id);
  expect(writes[0]?.text).toBe("﻿one\r\nthree\r\n");
});

test("a file that mixes line endings, a link, or an older plxd opens read-only and never saves", async () => {
  disk.set("mixed.txt", "one\r\ntwo\n");
  const mixed = await opened("mixed.txt");
  expect(textBody(mixed.store, mixed.id).readOnly).toMatch(/mixes line endings/);

  const older = await opened("a.ts", false);
  expect(textBody(older.store, older.id).readOnly).toMatch(/Update Parallax/);

  const links = new OpenFiles("local", "run-1");
  links.writable = true;
  const link = links.open("a.ts", { link: true });
  await settle();
  expect(textBody(links, link).readOnly).toMatch(/link/);

  for (const [store, id] of [
    [mixed.store, mixed.id],
    [older.store, older.id],
    [links, link],
  ] as const) {
    store.edited(id, () => "no\n");
    await store.save(id);
  }
  expect(writes).toEqual([]);
});

test("a tab follows a rename, a folder's files with it, and closes with a delete", async () => {
  disk.set("src/a.ts", "a\n");
  disk.set("src/deep/b.ts", "b\n");
  const store = new OpenFiles("local", "run-1");
  store.writable = true;
  const a = store.open("src/a.ts");
  const b = store.open("src/deep/b.ts");
  await settle();
  store.moved("src", "lib");
  expect(tab(store, a)?.path).toBe("lib/a.ts");
  expect(tab(store, b)?.path).toBe("lib/deep/b.ts");
  store.removed("lib/deep");
  expect(tab(store, b)).toBeUndefined();
  expect(store.get().active).toBe(a);
});

test("an image shows as an image, and a link's target stays text whatever its name", async () => {
  URL.createObjectURL = () => "blob:shown";
  URL.revokeObjectURL = () => {};
  disk.set("logo.png", "not really a png");
  const image = await opened("logo.png");
  expect(tab(image.store, image.id)?.body).toEqual({
    kind: "media",
    url: "blob:shown",
    video: false,
  });
  const links = new OpenFiles("local", "run-1");
  const link = links.open("logo.png", { link: true });
  await settle();
  expect(tab(links, link)?.body.kind).toBe("text");
});

test("a transient tab gives way to the next, unless it was edited or kept", async () => {
  disk.set("b.ts", "b\n");
  disk.set("c.ts", "c\n");
  disk.set("d.ts", "d\n");
  const store = new OpenFiles("local", "run-1");
  store.writable = true;
  const a = store.open("a.ts", { transient: true });
  await settle();
  const b = store.open("b.ts", { transient: true });
  await settle();
  // In its place, not beside it.
  expect(store.get().tabs.map((f) => f.path)).toEqual(["b.ts"]);
  expect(tab(store, a)).toBeUndefined();

  // An edit keeps it.
  store.edited(b, () => "edited\n");
  expect(tab(store, b)?.transient).toBe(false);
  const c = store.open("c.ts", { transient: true });
  await settle();
  expect(store.get().tabs.map((f) => f.path)).toEqual(["b.ts", "c.ts"]);

  // So does opening it for good, as a double-click does.
  store.open("c.ts");
  expect(tab(store, c)?.transient).toBe(false);
  store.open("d.ts", { transient: true });
  await settle();
  expect(store.get().tabs.map((f) => f.path)).toEqual(["b.ts", "c.ts", "d.ts"]);
});

test("Compare shows what's on disk until it's stopped or settled", async () => {
  const { store, id } = await opened();
  store.edited(id, () => "mine\n");
  disk.set("a.ts", "the agent's\n");
  await store.check(id);
  await store.toggleCompare(id);
  expect(tab(store, id)?.compare).toBe("the agent's\n");
  await store.toggleCompare(id);
  expect(tab(store, id)?.compare).toBeUndefined();
  await store.toggleCompare(id);
  await store.overwrite(id);
  await settle();
  expect(tab(store, id)?.compare).toBeUndefined();
  expect(disk.get("a.ts")).toBe("mine\n");
});

test("each go-to-line is taken once, and asks for the text when Markdown shows rendered", async () => {
  disk.set("doc.md", "# Doc\n\ntext\n");
  const store = new OpenFiles("local", "run-1");
  const id = store.open("doc.md");
  await settle();
  store.setView(id, "preview");
  store.goTo(id, 3);
  expect(tab(store, id)?.view).toBe("code");
  expect(store.takeJump(id)).toBe(3);
  // Shown again, it stays where the cursor went since.
  expect(store.takeJump(id)).toBeUndefined();
  store.goTo(id, 1);
  expect(store.takeJump(id)).toBe(1);

  // A new tab opened at a line opens as text, whatever was chosen last.
  store.setView(id, "preview");
  const other = store.open("a.ts", { line: 1 });
  expect(tab(store, other)?.view).toBe("code");
});

test("closing all leaves a tab whose edits can't land", async () => {
  disk.set("b.ts", "b\n");
  const store = new OpenFiles("local", "run-1");
  store.writable = true;
  const a = store.open("a.ts");
  const b = store.open("b.ts");
  await settle();
  store.edited(a, () => "mine\n");
  disk.set("a.ts", "the agent's\n");
  await store.closeAll();
  expect(store.get().tabs.map((f) => f.id)).toEqual([a]);
  expect(tab(store, b)).toBeUndefined();
});

test("a binary file offers its bytes, and a missing one says so", async () => {
  disk.set("x.bin", "a\0b");
  const binary = await opened("x.bin");
  const body = tab(binary.store, binary.id)?.body;
  expect(body?.kind === "note" && body.note).toMatch(/binary/);
  expect(body?.kind === "note" && body.bytes?.length).toBe(3);
  const gone = await opened("nope.ts");
  const note = tab(gone.store, gone.id)?.body;
  expect(note?.kind === "note" && note.note).toMatch(/isn't there/);
});
