import { expect, test, vi } from "vitest";

const stored = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (name: string) => (await Promise.resolve(), stored.get(name) ?? null),
  setItemAsync: async (name: string, value: string) => void (await Promise.resolve(), stored.set(name, value)),
  deleteItemAsync: async (name: string) => void stored.delete(name),
}));
vi.mock("expo-notifications", () => ({}));
vi.mock("expo-task-manager", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("./language", () => ({ startLanguage: async () => {} }));
vi.mock("./androidThreads", () => ({ keepPush: async () => {} }));

const { forgetAndroidPushKeys, saveAndroidPushKey } = await import("./androidPush");

test("two computers saving their push keys at once both keep them, and signing out drops both", async () => {
  await Promise.all([saveAndroidPushKey("host-a", "key-a"), saveAndroidPushKey("host-b", "key-b")]);
  expect(JSON.parse(stored.get("pushKeys")!)).toEqual({ "host-a": "key-a", "host-b": "key-b" });
  await forgetAndroidPushKeys();
  expect(stored.has("pushKeys")).toBe(false);
});
