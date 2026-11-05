import { chunksOf, failure } from "./documents";
import { fromBase64 } from "./ooxml";

/** How long after the last keystroke an edit saves. */
export const SAVE_AFTER_MS = 600;
/** How often the file on screen is checked for changes on disk. */
export const CHECK_EVERY_MS = 3000;

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const videoTypes: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const extensionOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";

/** What a tab holds. */
export type FileBody =
  | { kind: "loading" }
  | {
      kind: "text";
      /** The text on disk as of `sha256`, with `\n` for its line endings and no BOM. */
      text: string;
      /** Absent when the file doesn't exist, or on a plxd that can't save. */
      sha256?: string;
      eol: "\n" | "\r\n";
      bom: boolean;
      /** Why this can't be edited here, when it can't. */
      readOnly?: string;
      /** Counts reloads from disk, for the editor to take in. */
      reloads: number;
    }
  | { kind: "media"; url: string; video: boolean }
  /** A file only Download reads: its bytes when it has them, `large` for one too large to show. */
  | { kind: "note"; note: string; bytes?: Uint8Array; large?: boolean }
  | { kind: "error"; error: string };

/**
 * Where a text file's edits are. `edited` waits to save, and `failed` retries on the next check.
 */
export type SaveState = "saved" | "edited" | "saving" | "failed";

/** One open tab. */
export type OpenFile = {
  /** Stays the same when the file is renamed. */
  id: number;
  path: string;
  body: FileBody;
  save: SaveState;
  /** Why the last save failed. */
  saveError?: string;
  /** The file changed on disk under these edits: what's there now, or nothing when it's gone. */
  conflict?: { sha256?: string };
  /** How Markdown shows: its text, rendered, or both side by side. */
  view: MarkdownView;
  /**
   * A preview tab, as in VS Code and Zed: the next file opened the same way takes its place. An
   * edit or a double-click keeps it.
   */
  transient: boolean;
  /** A line to go to, with what counts asks to go there, so asking twice goes twice. */
  jump?: { line: number; count: number };
  /** What's on disk, while the editor shows edits against it. */
  compare?: string;
};

export type MarkdownView = "code" | "split" | "preview";

const MARKDOWN_VIEW_KEY = "parallax.files.markdownView";
/** The view last chosen for Markdown, which new tabs open in, as T3 Code remembers it. */
function lastMarkdownView(): MarkdownView {
  const saved = localStorage.getItem(MARKDOWN_VIEW_KEY);
  return saved === "split" || saved === "preview" ? saved : "code";
}

/**
 * What the Files view draws, replaced on each change. `home` shows the tree in place of the
 * active tab. `closing` is a tab whose edits can't be saved, waiting on a choice to close it.
 */
export type OpenFilesView = {
  tabs: readonly OpenFile[];
  active?: number;
  home?: boolean;
  closing?: number;
};

/** What the store keeps of a tab beyond what's drawn. */
type Run = {
  /** Counts edits, and `saved` the count the last save held. */
  edits: number;
  saved: number;
  /** The editor's text now. */
  read?: () => string;
  timer?: ReturnType<typeof setTimeout>;
  /** The save under way, which a close waits for. */
  saving?: Promise<void>;
  /** Counts what changes the file on disk from here, so an older check's answer is ignored. */
  epoch: number;
  /** The editor's own state, kept while another tab is on screen. */
  kept?: unknown;
  /** Whether it's a link, which shows its target and isn't edited. */
  link: boolean;
  /** The last `jump` the editor went to, so a tab shown again doesn't go there again. */
  jumped: number;
};

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** `bytes` as text for the editor, or nothing when they aren't UTF-8 text. */
function textOf(
  bytes: Uint8Array,
): Pick<Extract<FileBody, { kind: "text" }>, "text" | "eol" | "bom" | "readOnly"> | undefined {
  if (bytes.includes(0)) return undefined;
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const bom = raw.startsWith("﻿");
  if (bom) raw = raw.slice(1);
  const crlf = raw.match(/\r\n/g)?.length ?? 0;
  const lf = (raw.match(/\n/g)?.length ?? 0) - crlf;
  const cr = (raw.match(/\r/g)?.length ?? 0) - crlf;
  // The editor holds one line ending, so saving these would rewrite every line.
  const mixed = cr > 0 || (crlf > 0 && lf > 0);
  return {
    text: raw.replace(/\r\n?/g, "\n"),
    eol: crlf > 0 && !mixed ? "\r\n" : "\n",
    bom,
    ...(mixed && { readOnly: "This file mixes line endings, so it can't be edited here." }),
  };
}

/**
 * A thread's open files on one host: their tabs, what's on disk under each, and their saves. It
 * outlives the Files view, so edits, undo, and a save under way survive switching views or threads.
 *
 * Every save says which content it was edited from, and plxd refuses it when the file has moved on
 * (`agent/fileWrite`), since an agent writes these files too. An edit saves `SAVE_AFTER_MS` after
 * the last one, one save at a time. `check` looks for changes on disk: an unedited file reloads,
 * and an edited one gets `conflict`, which holds its saves until `reload` or `overwrite`.
 */
export class OpenFiles {
  private view: OpenFilesView = { tabs: [] };
  private readonly runs = new Map<number, Run>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  /** Whether this plxd has `fileWrite`. */
  writable = false;
  /** The tree's open folders, kept with the tabs. */
  expanded: ReadonlySet<string> = new Set();
  /** The last file the command menu revealed, so coming back to the view doesn't reveal it again. */
  revealed?: object;

  constructor(
    private readonly hostId: string,
    private readonly runId: string,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.view;

  private draw(view: OpenFilesView) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  private find(id: number) {
    return this.view.tabs.find((f) => f.id === id);
  }
  private change(id: number, change: Partial<OpenFile>) {
    this.draw({
      ...this.view,
      tabs: this.view.tabs.map((f) => (f.id === id ? { ...f, ...change } : f)),
    });
  }

  /**
   * Opens `path`, or goes to its tab. A `link` shows its target, which can't be edited. A `transient`
   * one takes the place of the last transient tab, unless that has edits. `line` goes to that line.
   */
  open(path: string, options: { link?: boolean; transient?: boolean; line?: number } = {}): number {
    const { link = false, transient = false, line } = options;
    const open = this.view.tabs.find((f) => f.path === path);
    if (open) {
      this.activate(open.id);
      if (!transient) this.pin(open.id);
      if (line) this.goTo(open.id, line);
      return open.id;
    }
    const id = this.nextId++;
    this.runs.set(id, { edits: 0, saved: 0, epoch: 0, link, jumped: 0 });
    const file: OpenFile = {
      id,
      path,
      body: { kind: "loading" },
      save: "saved",
      // Going to a line needs the text on screen.
      view: line && lastMarkdownView() === "preview" ? "code" : lastMarkdownView(),
      transient,
      ...(line && { jump: { line, count: 1 } }),
    };
    const replaced = transient
      ? this.view.tabs.find((f) => f.transient && !this.unsaved(f.id) && !f.conflict)
      : undefined;
    const tabs = replaced
      ? this.view.tabs.map((f) => (f === replaced ? file : f))
      : [...this.view.tabs, file];
    if (replaced) this.forget(replaced);
    this.draw({ ...this.view, tabs, active: id, home: false });
    void this.read(path, link, 0).then((body) => this.change(id, { body }));
    return id;
  }

  /** Keeps a transient tab open. */
  pin(id: number) {
    if (this.find(id)?.transient) this.change(id, { transient: false });
  }

  /** Puts the cursor on `line` and scrolls to it. */
  goTo(id: number, line: number) {
    const file = this.find(id);
    if (!file) return;
    this.change(id, {
      jump: { line, count: (file.jump?.count ?? 0) + 1 },
      ...(file.view === "preview" && { view: "code" }),
    });
  }

  /** The line tab `id`'s editor should go to now: each `goTo` once, however often it's shown. */
  takeJump(id: number): number | undefined {
    const run = this.runs.get(id);
    const jump = this.find(id)?.jump;
    if (!run || !jump || jump.count <= run.jumped) return undefined;
    run.jumped = jump.count;
    return jump.line;
  }

  private forget(file: OpenFile) {
    const run = this.runs.get(file.id);
    if (run?.timer) clearTimeout(run.timer);
    this.runs.delete(file.id);
    if (file.body.kind === "media") URL.revokeObjectURL(file.body.url);
  }

  activate(id: number) {
    if (this.view.active === id && !this.view.home) return;
    this.draw({ ...this.view, active: id, home: false });
    void this.check(id);
  }

  /** Shows the tree in place of the active tab, or not. */
  showHome(home: boolean) {
    if (!!this.view.home !== home) this.draw({ ...this.view, home });
  }

  /** Closes tab `id` once it's saved, or asks first, through `closing`, when its edits can't land. */
  async askClose(id: number) {
    if (!(await this.close(id))) this.draw({ ...this.view, closing: id });
  }

  /** Answers `closing`: drops the tab's edits and closes it, or keeps it open. */
  settleClose(discard: boolean) {
    const id = this.view.closing;
    this.draw({ ...this.view, closing: undefined });
    if (discard && id !== undefined) this.discard(id);
  }

  /** `path` as a tab shows it, read with its SHA-256 so what's edited is known exactly. */
  private async read(path: string, link: boolean, reloads: number): Promise<FileBody> {
    const answer = await window.parallax.request(this.hostId, "agent/file", {
      runId: this.runId,
      path,
      side: "working",
      hash: true,
    });
    if ("error" in answer)
      return { kind: "error", error: await failure(this.hostId, answer.error) };
    const read = answer.result;
    if (!read.exists) return { kind: "note", note: "This file isn't there anymore." };
    if (read.tooLarge || read.content == null)
      return {
        kind: "note",
        note: "This file is too large to show.",
        large: !!(await chunksOf(this.hostId)),
      };
    const bytes = fromBase64(read.content);
    const extension = extensionOf(path);
    const type = imageTypes[extension] ?? videoTypes[extension];
    if (type && !link)
      return {
        kind: "media",
        url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
        video: extension in videoTypes,
      };
    const text = textOf(bytes);
    if (!text) return { kind: "note", note: "This is a binary file.", bytes };
    const readOnly =
      text.readOnly ??
      (link
        ? "This is a link, and this shows where it points."
        : this.writable && read.sha256
          ? undefined
          : "Update Parallax on this host to edit files.");
    return {
      kind: "text",
      ...text,
      ...(read.sha256 && { sha256: read.sha256 }),
      ...(readOnly && { readOnly }),
      reloads,
    };
  }

  /** The editor's text changed, as `read` now reads it. */
  edited(id: number, read: () => string) {
    const run = this.runs.get(id);
    if (!run) return;
    run.edits++;
    run.read = read;
    if (run.timer) clearTimeout(run.timer);
    run.timer = setTimeout(() => void this.save(id), SAVE_AFTER_MS);
    this.pin(id);
    const file = this.find(id);
    if (file && file.save !== "saving" && file.save !== "edited")
      this.change(id, { save: "edited" });
  }

  /** Keeps the editor's own state while another tab is on screen. */
  keep(id: number, state: unknown) {
    const run = this.runs.get(id);
    if (run) run.kept = state;
  }
  kept(id: number) {
    return this.runs.get(id)?.kept;
  }

  /** The text in tab `id` now, edits included. */
  textNow(id: number): string {
    const file = this.find(id);
    return this.runs.get(id)?.read?.() ?? (file?.body.kind === "text" ? file.body.text : "");
  }

  /** Whether tab `id` has edits that aren't on disk. */
  unsaved(id: number) {
    const run = this.runs.get(id);
    return !!run && run.edits !== run.saved;
  }

  /** Saves tab `id`'s edits now, and answers once none are left that a save could write. */
  async save(id: number): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    while (run.saving) await run.saving;
    const file = this.find(id);
    if (!file || file.body.kind !== "text" || file.body.readOnly || file.conflict) return;
    if (run.edits === run.saved || !run.read) return;
    run.saving = this.write(id, run, run.read(), file.body.sha256);
    await run.saving;
    run.saving = undefined;
    // Edits made while it wrote.
    const after = this.find(id);
    if (run.edits !== run.saved && after && after.save === "edited") await this.save(id);
  }

  private async write(id: number, run: Run, text: string, expected: string | undefined) {
    const sent = run.edits;
    run.epoch++;
    this.change(id, { save: "saving" });
    const body = this.find(id)?.body;
    if (body?.kind !== "text") return;
    const { path } = this.find(id)!;
    const content = (body.bom ? "﻿" : "") + text.replaceAll("\n", body.eol);
    const answer = await window.parallax
      .request(this.hostId, "agent/fileWrite", {
        runId: this.runId,
        path,
        content: encode(content),
        ...(expected && { expectedSha256: expected }),
      })
      .catch((error: unknown) => ({ thrown: String(error) }));
    run.epoch++;
    const now = this.find(id);
    if (!now || now.body.kind !== "text") return;
    if ("thrown" in answer) return this.change(id, { save: "failed", saveError: answer.thrown });
    if ("error" in answer) {
      const saveError = await failure(this.hostId, answer.error);
      return this.change(id, { save: "failed", saveError });
    }
    const { conflict, sha256 } = answer.result;
    if (conflict)
      return this.change(id, {
        save: "edited",
        conflict: sha256 ? { sha256 } : {},
        saveError: undefined,
      });
    run.saved = sent;
    const { sha256: _, ...rest } = now.body;
    this.change(id, {
      body: { ...rest, text, ...(sha256 && { sha256 }) },
      save: run.edits === sent ? "saved" : "edited",
      saveError: undefined,
      conflict: undefined,
    });
  }

  /**
   * Compares tab `id` with the file on disk, and retries a save that failed. Asked again while
   * nothing is saving, so a check never answers for a file a save just changed.
   */
  async check(id: number): Promise<void> {
    const run = this.runs.get(id);
    const file = this.find(id);
    if (!run || !file || file.body.kind !== "text" || run.saving) return;
    if (file.save === "failed") return this.save(id);
    if (!this.writable) return;
    const { epoch } = run;
    const answer = await window.parallax.request(this.hostId, "agent/file", {
      runId: this.runId,
      path: file.path,
      side: "working",
      sizeOnly: true,
      hash: true,
    });
    // An error here is a link that's down: the next check asks again.
    if ("error" in answer || run.epoch !== epoch || run.saving) return;
    const now = this.find(id);
    if (!now || now.body.kind !== "text") return;
    const { exists, sha256, tooLarge } = answer.result;
    if (tooLarge || (exists && !sha256)) return;
    const onDisk = exists ? sha256 : undefined;
    if (onDisk === now.body.sha256) {
      if (now.conflict) this.change(id, { conflict: undefined });
      return;
    }
    if (this.unsaved(id) || !exists || now.conflict)
      return this.change(id, { conflict: onDisk ? { sha256: onDisk } : {} });
    await this.reload(id);
  }

  /** Replaces tab `id` with what's on disk, dropping its edits. */
  async reload(id: number): Promise<void> {
    const run = this.runs.get(id);
    const file = this.find(id);
    if (!run || !file || file.body.kind !== "text") return;
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    const edits = run.edits;
    const { epoch } = run;
    const body = await this.read(file.path, run.link, file.body.reloads + 1);
    const now = this.find(id);
    // Typing or a save overtook it; the next check looks again.
    if (!now || run.edits !== edits || run.epoch !== epoch) return;
    run.saved = run.edits;
    run.read = undefined;
    this.change(id, {
      body,
      save: "saved",
      saveError: undefined,
      conflict: undefined,
      compare: undefined,
    });
  }

  /** Writes tab `id`'s edits over what changed on disk: the same save, from what's there now. */
  async overwrite(id: number): Promise<void> {
    const run = this.runs.get(id);
    const file = this.find(id);
    if (!run || !file?.conflict || file.body.kind !== "text") return;
    while (run.saving) await run.saving;
    this.change(id, { conflict: undefined, compare: undefined });
    run.saving = this.write(id, run, this.textNow(id), file.conflict.sha256);
    await run.saving;
    run.saving = undefined;
  }

  /**
   * Closes tab `id` once its edits are saved. Answers false, leaving it open, when they can't be:
   * then `discard` closes it anyway.
   */
  async close(id: number): Promise<boolean> {
    await this.save(id);
    if (this.unsaved(id)) return false;
    this.discard(id);
    return true;
  }

  /** Closes tab `id`, dropping any edits. */
  discard(id: number) {
    const file = this.find(id);
    if (file) this.forget(file);
    const tabs = this.view.tabs.filter((f) => f.id !== id);
    const at = this.view.tabs.findIndex((f) => f.id === id);
    this.draw({
      ...this.view,
      tabs,
      active: this.view.active === id ? (tabs[at] ?? tabs[at - 1])?.id : this.view.active,
      ...(tabs.length === 0 && { home: true }),
    });
  }

  /** Closes every tab but `except`, leaving any whose edits can't be saved. */
  async closeAll(except?: number) {
    await Promise.all(this.view.tabs.filter((f) => f.id !== except).map((f) => this.close(f.id)));
  }

  setView(id: number, view: MarkdownView) {
    localStorage.setItem(MARKDOWN_VIEW_KEY, view);
    this.change(id, { view });
  }

  /** Shows tab `id`'s edits against what's on disk, or stops. */
  async toggleCompare(id: number) {
    const file = this.find(id);
    if (!file) return;
    if (file.compare !== undefined) return this.change(id, { compare: undefined });
    const body = await this.read(file.path, this.runs.get(id)?.link ?? false, 0);
    // Gone from disk is nothing to compare with: all of it shows as added. A comparison needs the
    // text on screen.
    this.change(id, {
      compare: body.kind === "text" ? body.text : "",
      ...(file.view === "preview" && { view: "code" }),
    });
  }

  /** Saves every open edit under `path`, as a rename or delete of it needs first. */
  async flush(path: string) {
    await Promise.all(
      this.view.tabs
        .filter((f) => f.path === path || f.path.startsWith(`${path}/`))
        .map((f) => this.save(f.id)),
    );
  }

  /** Tabs follow an entry that moved, a folder's files with it. */
  moved(from: string, to: string) {
    this.draw({
      ...this.view,
      tabs: this.view.tabs.map((f) =>
        f.path === from || f.path.startsWith(`${from}/`)
          ? { ...f, path: to + f.path.slice(from.length) }
          : f,
      ),
    });
  }

  /** Tabs close with an entry that was deleted. */
  removed(path: string) {
    for (const file of this.view.tabs)
      if (file.path === path || file.path.startsWith(`${path}/`)) this.discard(file.id);
  }

  /** Saves what's waiting, for the window closing. */
  flushAll() {
    for (const file of this.view.tabs) void this.save(file.id);
  }
}

const stores = new Map<string, OpenFiles>();

/** Thread `runId`'s open files on `hostId`, the same for as long as the app runs. */
export function openFilesOf(hostId: string, runId: string): OpenFiles {
  const key = `${hostId}/${runId}`;
  let store = stores.get(key);
  if (!store) {
    if (!stores.size) window.addEventListener("beforeunload", flushOpenFiles);
    store = new OpenFiles(hostId, runId);
    stores.set(key, store);
  }
  return store;
}

/** Saves every thread's waiting edits, as the window closes. */
function flushOpenFiles() {
  for (const store of stores.values()) store.flushAll();
}

/** Forgets every thread's tabs, between tests. */
export function resetOpenFiles() {
  stores.clear();
}
