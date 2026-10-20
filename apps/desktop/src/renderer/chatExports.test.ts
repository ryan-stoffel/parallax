import { strToU8, zipSync } from "fflate";
import { expect, test } from "vite-plus/test";

import { parseExport, readExport } from "./chatExports";

// A ChatGPT conversation whose user edited their first message: `current_node` follows the edit.
const chatgpt = {
  title: "Plan a trip",
  create_time: 1_725_300_000.5,
  update_time: 1_725_400_000,
  conversation_id: "c-1",
  current_node: "a2",
  mapping: {
    root: { id: "root", message: null, parent: null, children: ["sys"] },
    sys: {
      id: "sys",
      parent: "root",
      message: {
        author: { role: "system" },
        content: { content_type: "text", parts: ["You are ChatGPT"] },
      },
    },
    u1: {
      id: "u1",
      parent: "sys",
      message: { author: { role: "user" }, content: { content_type: "text", parts: ["Old ask"] } },
    },
    u2: {
      id: "u2",
      parent: "sys",
      message: {
        author: { role: "user" },
        content: { content_type: "multimodal_text", parts: [{ asset: "img" }, "Plan Lisbon"] },
      },
    },
    tool: {
      id: "tool",
      parent: "u2",
      message: {
        author: { role: "assistant" },
        recipient: "browser",
        content: { content_type: "code", text: "search(...)" },
      },
    },
    a1: {
      id: "a1",
      parent: "tool",
      message: {
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "text", parts: ["Day one: Alfama."] },
      },
    },
    ctx: {
      id: "ctx",
      parent: "a1",
      message: {
        author: { role: "user" },
        metadata: { is_visually_hidden_from_conversation: true },
        content: { content_type: "text", parts: ["hidden"] },
      },
    },
    a2: {
      id: "a2",
      parent: "ctx",
      message: {
        author: { role: "assistant" },
        content: { content_type: "text", parts: ["Day two: Belém."] },
      },
    },
  },
};

const claude = {
  uuid: "k-1",
  name: "",
  created_at: "2026-08-11T09:30:00.000Z",
  updated_at: "2026-08-12T10:00:00.000Z",
  chat_messages: [
    { sender: "human", text: "Explain monads", content: [] },
    {
      sender: "assistant",
      text: "",
      content: [{ type: "text", text: "A monad is…" }, { type: "tool_use" }],
    },
    { sender: "human", text: "   ", content: [] },
  ],
};

test("a ChatGPT chat keeps the branch the user last saw, and only its visible text", () => {
  const [chat] = parseExport([chatgpt]);
  expect(chat).toEqual({
    source: "chatgpt",
    id: "c-1",
    title: "Plan a trip",
    createdAt: "2024-09-02T18:00:00.500Z",
    updatedAt: "2024-09-03T21:46:40.000Z",
    messages: [
      { role: "user", text: "Plan Lisbon" },
      { role: "assistant", text: "Day one: Alfama." },
      { role: "assistant", text: "Day two: Belém." },
    ],
  });
});

test("a Claude chat reads text or text blocks, and an untitled one gets a name", () => {
  const [chat] = parseExport([claude]);
  expect(chat).toMatchObject({ source: "claudeChat", id: "k-1", title: "Claude chat" });
  expect(chat!.messages).toEqual([
    { role: "user", text: "Explain monads" },
    { role: "assistant", text: "A monad is…" },
  ]);
});

test("chats with nothing from the user, and things that aren't chats, are left out", () => {
  const silent = { ...claude, uuid: "k-2", chat_messages: [{ sender: "assistant", text: "Hi" }] };
  expect(parseExport([silent, { users: [] }, 3, null])).toEqual([]);
  expect(parseExport({ not: "a list" })).toEqual([]);
});

test("a long chat keeps its first message and the newest that fit", () => {
  const huge = "x".repeat(40 * 1024);
  const messages = Array.from({ length: 100 }, (_, i) => ({
    sender: i % 2 ? "assistant" : "human",
    text: `${i} ${huge}`,
  }));
  const [chat] = parseExport([{ ...claude, chat_messages: messages }]);
  expect(chat!.messages[0]!.text.startsWith("0 ")).toBe(true);
  expect(chat!.messages.at(-1)!.text.startsWith("99 ")).toBe(true);
  expect(chat!.messages.every((m) => m.text.length <= 32 * 1024)).toBe(true);
  expect(chat!.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(
    2 * 1024 * 1024,
  );
});

test("an export .zip's conversations.json is read, newest first, and anything else says why", async () => {
  const zip = zipSync({
    "conversations.json": strToU8(JSON.stringify([chatgpt, claude])),
    "users.json": strToU8("[]"),
  });
  const chats = await readExport(new File([zip], "export.zip"));
  expect(chats.map((c) => c.id)).toEqual(["k-1", "c-1"]);
  const empty = zipSync({ "users.json": strToU8("[]") });
  await expect(readExport(new File([empty], "other.zip"))).rejects.toThrow(
    "has no conversations.json",
  );
  await expect(readExport(new File([strToU8("nope")], "bad.zip"))).rejects.toThrow("isn't a .zip");
});
