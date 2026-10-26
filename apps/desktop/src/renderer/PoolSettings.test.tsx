// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test, vi } from "vite-plus/test";

import type { ProviderInfo, ProviderInstance } from "../protocol/generated/protocol";
import { createPool, newAccount, poolDraft, PoolPane } from "./PoolSettings";
import { accountLabel, saveProvider } from "./providers";

vi.mock("./providers", async (original) => ({
  ...(await original<typeof import("./providers")>()),
  saveProvider: vi.fn(),
}));

const account = (id: string, home?: string): ProviderInstance => ({
  id,
  kind: "codex",
  name: "Codex",
  enabled: true,
  args: [],
  env: [],
  models: [],
  ...(home && { home }),
});
const info = (instance: ProviderInstance, identity?: string): ProviderInfo => ({
  instance,
  installed: true,
  models: [],
  permissions: [],
  efforts: true,
  coordinator: false,
  ...(identity && { account: identity }),
});

beforeEach(() => {
  vi.mocked(saveProvider).mockReset();
});

test("new accounts isolate the home when a renamed default account exists", () => {
  const made = newAccount("codex", "Work", [account("personal")]);
  expect(made.id).toBe("codex-account");
  expect(made.home).toBe("~/.codex-account");
  expect(newAccount("codex", "Personal", []).home).toBeUndefined();
});

test("pool setup does not require users to name accounts", () => {
  expect(poolDraft("codex", []).fresh).toEqual(["", ""]);
  expect(accountLabel(info(account("codex"), "personal@example.test"))).toBe(
    "personal@example.test",
  );
  expect(accountLabel(info({ ...account("work"), name: "Work" }, "work@example.test"))).toBe(
    "Work",
  );
  expect(accountLabel(info(account("codex"), "ChatGPT Pro"))).toBe("Codex");
});

test.each([1, 2])(
  "pool retry retains accounts saved before failure at save %i",
  async (failure) => {
    const stored: ProviderInfo[] = [];
    const save = vi.mocked(saveProvider);
    save.mockImplementation(async (_host, instance) => {
      if (save.mock.calls.length === failure + 1) return "Save failed";
      stored.push(info(instance));
      return undefined;
    });
    const draft = poolDraft("codex", []);
    const failed = await createPool("local", "codex", draft, []);
    expect(failed).toHaveProperty("error");
    if (!("error" in failed)) throw new Error("Expected a save failure");
    expect(failed.created).toHaveLength(failure);
    const retry = {
      ...draft,
      existing: [...draft.existing, ...failed.created],
      fresh: draft.fresh.slice(failed.created.length),
    };
    save.mockClear();
    save.mockImplementation(async (_host, instance) => {
      stored.push(info(instance));
      return undefined;
    });
    expect(await createPool("local", "codex", retry, stored)).toHaveProperty("id");
    const accounts = stored.filter((p) => !p.instance.members);
    expect(accounts).toHaveLength(2);
    expect(new Set(accounts.map((p) => p.instance.id)).size).toBe(2);
    expect(stored.at(-1)?.instance.members).toEqual(accounts.map((p) => p.instance.id));
  },
);

test("pool pane retries adding the saved account when updating the pool fails", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const list = [info(account("codex")), info(account("work", "~/.codex-work"))];
  const pool = info({ ...account("pool"), name: "Codex pool", members: ["codex", "work"] });
  const save = vi.mocked(saveProvider);
  let poolSaves = 0;
  save.mockImplementation(async (_host, instance) => {
    if (instance.members) return ++poolSaves === 1 ? "Save failed" : undefined;
    list.push(info(instance));
    return undefined;
  });
  const opened = vi.fn();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <PoolPane
          id="pool-pane"
          tabId="pool-tab"
          hidden={false}
          hostId="local"
          info={pool}
          list={list}
          nameField={() => null}
          onOpen={opened}
        />,
      ),
    );
    const add = () =>
      [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("account"))!;
    await act(async () => add().click());
    expect(add().textContent).toContain("Retry adding account");
    expect(opened).not.toHaveBeenCalled();
    const made = list.at(-1)!.instance;
    await act(async () => add().click());
    expect(save.mock.calls.filter(([, instance]) => !instance.members)).toHaveLength(1);
    expect(save.mock.calls.at(-1)?.[1].members).toEqual(["codex", "work", made.id]);
    expect(opened).toHaveBeenCalledExactlyOnceWith(made.id);
    expect(add().textContent).toContain("Add account");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
