import { beforeEach, expect, test, vi } from "vite-plus/test";

vi.stubGlobal("window", { parallax: { platform: "darwin" } });

const {
  activeCommand,
  applyBindingsJson,
  bindingOf,
  bindingsJson,
  commandOf,
  isDefault,
  parseOverrides,
  resetBindings,
  setBinding,
  setWhen,
  whenOf,
} = await import("./keybindings");

beforeEach(() => resetBindings());

test("a command saved with several shortcuts keeps its first", () => {
  expect(parseOverrides({ terminal: ["Meta+KeyJ", "Ctrl+Shift+Backquote"], sidebar: [] })).toEqual({
    terminal: { key: "Meta+KeyJ" },
    sidebar: { key: null },
  });
  expect(parseOverrides({ gone: ["Meta+KeyJ"], find: { when: "nonsense" } })).toEqual({ find: {} });
});

test("a command has one binding, and none once it's removed", () => {
  expect(bindingOf("terminal")).toBe("Meta+KeyJ");
  expect(commandOf("Ctrl+Shift+Backquote")).toBeUndefined();
  setBinding("terminal", "Meta+KeyL");
  expect(bindingOf("terminal")).toBe("Meta+KeyL");
  expect(commandOf("Meta+KeyJ")).toBeUndefined();
  setBinding("terminal", null);
  expect(bindingOf("terminal")).toBeUndefined();
});

test("a press runs its command only while its When holds", () => {
  vi.stubGlobal("document", { activeElement: { closest: () => null, matches: () => false } });
  setWhen("find", "terminalFocus");
  expect(activeCommand("Meta+KeyF")).toBeUndefined();
  setWhen("find", "!terminalFocus");
  expect(activeCommand("Meta+KeyF")).toBe("find");
  expect(commandOf("Meta+KeyF")).toBe("find");
});

test("Applying the JSON as it opens changes nothing, and a left-out When stays", () => {
  setWhen("find", "!terminalFocus");
  expect(applyBindingsJson(bindingsJson())).toEqual([]);
  expect(whenOf("find")).toBe("!terminalFocus");
  expect(isDefault("find")).toBe(false);
  expect(isDefault("sidebar")).toBe(true);

  expect(applyBindingsJson('{"find":{"key":"Mod+KeyG"}}')).toEqual([]);
  expect(whenOf("find")).toBe("!terminalFocus");

  // Any key recording can take applies again, and an entry that isn't an object says so.
  setBinding("find", "Meta+IntlBackslash");
  expect(applyBindingsJson(bindingsJson())).toEqual([]);
  expect(applyBindingsJson('{"find":"Mod+KeyG"}')).toHaveLength(1);
});

test("the JSON editor applies all of it, or nothing and says why", () => {
  expect(applyBindingsJson('{"sidebar":{"key":"Mod+KeyB","when":"!terminalFocus"}}')).toEqual([]);
  expect(bindingOf("sidebar")).toBe("Meta+KeyB");

  expect(applyBindingsJson('{"nope":{"key":"Mod+KeyB"}}')).toEqual(["Unknown command: nope"]);
  expect(applyBindingsJson('{"find":{"key":"F"}}')[0]).toContain("find:");
  expect(applyBindingsJson('{"find":{"key":"Mod+KeyB"}}')[0]).toContain("on both");
  expect(bindingOf("find")).toBe("Meta+KeyF");

  // What recording would refuse, since it'd never run.
  for (const key of ["Alt+KeyK", "Mod+K", "Mod+KeyC", "Mod+Digit1", "Ctrl+Meta+Digit1"]) {
    expect(applyBindingsJson(JSON.stringify({ find: { key } }))).toHaveLength(1);
    expect(bindingOf("find")).toBe("Meta+KeyF");
  }
});
