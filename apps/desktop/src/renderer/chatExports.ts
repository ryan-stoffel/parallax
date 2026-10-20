import { strFromU8, unzipSync } from "fflate";

import type { ChatMessage, ImportSource } from "../protocol/generated/protocol";

/** A chat read from a ChatGPT or Claude data export (PLX-883), for `thread/importChat`. */
export type ExportedChat = {
  source: Extract<ImportSource, "chatgpt" | "claudeChat">;
  id: string;
  title: string;
  /** ISO times. */
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

/** The longest message kept, in characters: plxd cuts each to 32 KiB anyway. */
const MAX_MESSAGE_CHARS = 32 * 1024;
/** The most characters one chat sends, so its request stays under the 8 MiB frame. */
const MAX_CHAT_CHARS = 2 * 1024 * 1024;
/** The most messages one chat sends, as plxd takes (`MAX_CHAT_MESSAGES`). */
const MAX_CHAT_MESSAGES = 10_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** A ChatGPT time, in seconds, or a Claude one, ISO, as ISO; `undefined` when neither. */
function iso(v: unknown): string | undefined {
  const date = typeof v === "number" ? new Date(v * 1000) : new Date(text(v));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * `messages` sized to send: each cut to `MAX_MESSAGE_CHARS`, and, past `MAX_CHAT_CHARS` or
 * `MAX_CHAT_MESSAGES` in all, the first kept with the newest that fit.
 */
function fit(messages: ChatMessage[]): ChatMessage[] {
  const cut = messages.map((m) => ({ ...m, text: m.text.slice(0, MAX_MESSAGE_CHARS) }));
  let budget = MAX_CHAT_CHARS - (cut[0]?.text.length ?? 0);
  const kept: ChatMessage[] = [];
  for (
    let i = cut.length - 1;
    i > 0 && budget >= cut[i]!.text.length && kept.length < MAX_CHAT_MESSAGES - 1;
    i--
  ) {
    budget -= cut[i]!.text.length;
    kept.unshift(cut[i]!);
  }
  return cut.length ? [cut[0]!, ...kept] : [];
}

/** One ChatGPT conversation: its branch the user last saw, from `current_node` up to the root. */
function chatgpt(c: Json): ExportedChat | undefined {
  const mapping = isObject(c["mapping"]) ? c["mapping"] : {};
  const path: Json[] = [];
  const seen = new Set<string>();
  let at = text(c["current_node"]);
  while (at && !seen.has(at) && isObject(mapping[at])) {
    seen.add(at);
    const node = mapping[at] as Json;
    path.unshift(node);
    at = text(node["parent"]);
  }
  const messages: ChatMessage[] = [];
  for (const node of path) {
    const m = node["message"];
    if (!isObject(m)) continue;
    const role = isObject(m["author"]) ? m["author"]["role"] : undefined;
    const content = isObject(m["content"]) ? m["content"] : {};
    const meta = isObject(m["metadata"]) ? m["metadata"] : {};
    // Tool calls, hidden context, and anything but text are left out.
    if (role !== "user" && role !== "assistant") continue;
    if (meta["is_visually_hidden_from_conversation"] === true) continue;
    if (m["recipient"] !== undefined && m["recipient"] !== "all") continue;
    if (!["text", "multimodal_text"].includes(text(content["content_type"]))) continue;
    // Typed text is a string part; a voice chat's spoken turn is an audio transcription's text.
    const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
    const body = parts
      .map((p) =>
        typeof p === "string"
          ? p
          : isObject(p) && p["content_type"] === "audio_transcription"
            ? text(p["text"])
            : "",
      )
      .filter(Boolean)
      .join("\n");
    if (body.trim()) messages.push({ role: role === "user" ? "user" : "assistant", text: body });
  }
  const id = text(c["conversation_id"]) || text(c["id"]);
  const createdAt = iso(c["create_time"]);
  if (!id || !createdAt) return undefined;
  return {
    source: "chatgpt",
    id,
    title: text(c["title"]).trim() || "ChatGPT chat",
    createdAt,
    updatedAt: iso(c["update_time"]) ?? createdAt,
    messages: fit(messages),
  };
}

/** One Claude conversation. */
function claude(c: Json): ExportedChat | undefined {
  const messages: ChatMessage[] = [];
  for (const m of Array.isArray(c["chat_messages"]) ? c["chat_messages"] : []) {
    if (!isObject(m)) continue;
    // The text blocks first: `text` stands a placeholder line in for each tool block.
    const blocks = Array.isArray(m["content"]) ? m["content"] : [];
    const body =
      blocks
        .filter((b) => isObject(b) && b["type"] === "text")
        .map((b) => text((b as Json)["text"]))
        .join("\n\n") || text(m["text"]);
    const sender = m["sender"];
    if (body.trim() && (sender === "human" || sender === "assistant"))
      messages.push({ role: sender === "human" ? "user" : "assistant", text: body });
  }
  const id = text(c["uuid"]);
  const createdAt = iso(c["created_at"]);
  if (!id || !createdAt) return undefined;
  return {
    source: "claudeChat",
    id,
    title: text(c["name"]).trim() || "Claude chat",
    createdAt,
    updatedAt: iso(c["updated_at"]) ?? createdAt,
    messages: fit(messages),
  };
}

/**
 * The chats in an export's `conversations.json`, ChatGPT's (each with a `mapping`) or Claude's
 * (each with `chat_messages`), the most recently updated first. Chats with no message from the
 * user are left out.
 */
export function parseExport(json: unknown): ExportedChat[] {
  const all = Array.isArray(json) ? json : [];
  return all
    .filter(isObject)
    .map((c) => ("mapping" in c ? chatgpt(c) : "chat_messages" in c ? claude(c) : undefined))
    .filter((c): c is ExportedChat => !!c && c.messages.some((m) => m.role === "user"))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The chats in `file`: a ChatGPT or Claude export .zip, whose `conversations.json` (or numbered
 * `conversations-NNN.json` parts) it reads, or that `conversations.json` itself. Throws, in words,
 * when it holds none.
 */
// ponytail: the whole file is read into memory; stream it if exports past a few hundred MB fail.
export async function readExport(file: File): Promise<ExportedChat[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let texts: string[];
  if (file.name.toLowerCase().endsWith(".json")) texts = [strFromU8(bytes)];
  else {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, {
        filter: (f) => /(^|\/)conversations(-\d+)?\.json$/i.test(f.name),
      });
    } catch {
      throw new Error(`${file.name} isn't a .zip Parallax can open.`);
    }
    texts = Object.keys(files)
      .sort()
      .map((name) => strFromU8(files[name]!));
  }
  if (!texts.length)
    throw new Error(`${file.name} has no conversations.json. Is it a ChatGPT or Claude export?`);
  const chats = texts.flatMap((t) => {
    try {
      return parseExport(JSON.parse(t));
    } catch {
      return [];
    }
  });
  if (!chats.length) throw new Error(`${file.name} has no ChatGPT or Claude chats in it.`);
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
