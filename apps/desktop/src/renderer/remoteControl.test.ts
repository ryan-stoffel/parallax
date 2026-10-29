// @vitest-environment happy-dom
import { expect, test } from "vite-plus/test";

import {
  isRemoteControl,
  needsAttention,
  readTextFile,
  remoteControlDisabled,
  withInlineFiles,
} from "./remoteControl";

const session = (state: "idle" | "archived" | "offline") => ({
  sessionId: "session_1",
  url: "https://claude.ai/code/session_1",
  state,
});

test("a run is Claude Remote Control when its session is claude.ai's", () => {
  expect(isRemoteControl({ sessionId: "session_018aq" })).toBe(true);
  expect(isRemoteControl({ sessionId: "5c5f05dc-0803-5867-9381-52e904679e32" })).toBe(false);
  expect(isRemoteControl({})).toBe(false);
  expect(isRemoteControl(undefined)).toBe(false);
});

test("only an archived session turns Send off, and only states that ask something lead", () => {
  expect(remoteControlDisabled(session("archived"))).toMatch(/archived/);
  expect(remoteControlDisabled(session("offline"))).toBeUndefined();
  expect(remoteControlDisabled(undefined)).toBeUndefined();
  const states = ["running", "idle", "waiting", "offline", "archived"] as const;
  expect(states.filter((state) => needsAttention(state))).toEqual([
    "waiting",
    "offline",
    "archived",
  ]);
});

test("files go after the text under their names, in fences their contents can't close", () => {
  expect(withInlineFiles("Review these", [])).toBe("Review these");
  expect(
    withInlineFiles("Review these", [
      { name: "a.md", text: "# A\n" },
      { name: "b.rs", text: 'println!("```")' },
    ]),
  ).toBe('Review these\n\na.md:\n```\n# A\n```\n\nb.rs:\n````\nprintln!("```")\n````');
  // A file alone is a message too.
  expect(withInlineFiles("  ", [{ name: "a.txt", text: "hi" }])).toBe("a.txt:\n```\nhi\n```");
});

test("a file goes inline only when it's text and fits", async () => {
  expect(await readTextFile(new File(["fn main() {}"], "main.rs"))).toEqual({
    text: "fn main() {}",
  });
  const binary = await readTextFile(new File([new Uint8Array([0x89, 0x50, 0, 0xff])], "a.bin"));
  expect(binary).toEqual({ error: expect.stringContaining("a.bin isn't a text file") });
  const big = await readTextFile(new File(["12345"], "log.txt"), 4);
  expect(big).toEqual({ error: expect.stringContaining("log.txt is too large") });
});
