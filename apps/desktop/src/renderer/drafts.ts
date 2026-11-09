import type { JSONContent } from "@tiptap/react";
import { useSyncExternalStore } from "react";

import type { AgentPermission, PromptImage } from "../protocol/generated/protocol";
import { uuidv7 } from "./uuidv7";

/** What a composer holds: its Markdown, its editor document, and what's attached. */
export interface ComposerContents {
  text: string;
  doc: JSONContent;
  images: PromptImage[];
  files: File[];
  threads: string[];
  /** The Access picked for a New thread, over the default. */
  permission?: AgentPermission;
  /** The provider instance a New thread runs on, picked or the default, when one is chosen. */
  provider?: string;
}

/** A New Thread prompt left unsent (PLX-788), with where it would run. */
export interface Draft extends ComposerContents {
  id: string;
  hostId: string;
  groupId: string;
}

/** Whether a composer holds nothing worth keeping. */
export const isEmpty = (c: ComposerContents) =>
  c.text.trim() === "" && c.images.length === 0 && c.files.length === 0 && c.threads.length === 0;

// ponytail: in memory, so drafts last until the app quits. `File`s don't fit localStorage; keep
// them on disk if drafts need to outlive the app.
let list: readonly Draft[] = [];
// Existing threads' unsent prompts (PLX-887), by `hostId/runId`.
let byThread: Readonly<Record<string, ComposerContents>> = {};
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const set = (next: readonly Draft[]) => {
  list = next;
  changed();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The unsent New Thread prompts, newest first. New Thread takes its own out while it's open and
 * puts it back as it closes, so each draft shows in the sidebar only while nothing edits it.
 */
export const drafts = {
  get: () => list,
  use: () => useSyncExternalStore(subscribe, () => list),
  /** Adds `draft`, or replaces the one with its id, at the top. */
  put: (draft: Draft) => set([draft, ...list.filter((d) => d.id !== draft.id)]),
  remove: (id: string) => {
    if (list.some((d) => d.id === id)) set(list.filter((d) => d.id !== id));
  },
};

const DOCTOR_PLAYBOOK =
  "https://raw.githubusercontent.com/ryan-stoffel/parallax/develop/packages/plx/src/doctor-playbook.md";

/**
 * The New thread Diagnose a problem opens: the prompt that runs `plx doctor`, on Full access, since
 * the worker sandbox blocks plxd's data folder (0013) and the doctor reads its logs and state. The
 * prompt says so, since Access sits in the model menu. Plain text: Markdown marks would come back
 * escaped.
 */
export function doctorDraft(hostId: string, groupId: string): Draft {
  const paragraphs = [
    `Parallax is misbehaving on this computer. This thread has Full access, so your commands run without asking: ask me before you change or post anything. Run npx -y plx-cli@latest doctor (npx.cmd on Windows), then read the prompt.md it names and follow it. If that can't run, fetch ${DOCTOR_PLAYBOOK} and follow it.`,
    "What went wrong: ",
  ];
  return {
    id: uuidv7(),
    hostId,
    groupId,
    text: paragraphs.join("\n\n"),
    doc: {
      type: "doc",
      content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    },
    images: [],
    files: [],
    threads: [],
    permission: "bypass",
  };
}

// A fresh New thread's draft id, by the selection that opened it.
const fresh = new WeakMap<object, string>();

/**
 * The draft id of a New thread opened by `selection` (PLX-1150): a new one for each selection
 * that opens a fresh New thread, the same one for every render of it. App keeps it as the
 * selection's `draft` through a change of repository or computer, and keys New Thread by it, so
 * opening another New thread leaves this one as a draft.
 */
export function freshDraftId(selection: object): string {
  let id = fresh.get(selection);
  if (!id) fresh.set(selection, (id = uuidv7()));
  return id;
}

/**
 * The unsent prompts of existing threads (PLX-887), by `hostId/runId`. A thread takes its own out
 * while it's open and puts it back as it closes, as New Thread does, so a row shows Draft only
 * while nothing edits it.
 */
export const threadDrafts = {
  get: () => byThread,
  /** Whether the thread `key` has a draft, re-rendering only as that changes. */
  use: (key: string) => useSyncExternalStore(subscribe, () => key in byThread),
  put: (key: string, contents: ComposerContents) => {
    byThread = { ...byThread, [key]: contents };
    changed();
  },
  remove: (key: string) => {
    if (!(key in byThread)) return;
    const { [key]: _, ...rest } = byThread;
    byThread = rest;
    changed();
  },
};
