// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { ParallaxBridge } from "../preload/bridge";
import type { ImportableSession } from "../protocol/generated/protocol";
import { ImportSessions } from "./ImportSessions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
HTMLElement.prototype.hidePopover = () => {};
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

/**
 * A bridge with `saved` SSH hosts, each connected and able to import but those `offline`, and
 * with `remote`, able to list claude.ai's Remote Control sessions too (PLX-1136).
 */
function bridge(
  request: unknown,
  saved: { id: string; name: string }[] = [],
  offline: string[] = [],
  remote = false,
) {
  window.parallax = {
    connectionState: async (host: string) =>
      offline.includes(host)
        ? { status: "connecting" as const }
        : {
            status: "connected" as const,
            plxd: "1",
            protocol: 1,
            capabilities: { threadImport: {}, ...(remote && { threadImportRemote: {} }) },
          },
    onConnectionState: () => () => {},
    hosts: async () => saved,
    onHosts: () => () => {},
    onLocalName: () => () => {},
    onDevices: () => () => {},
    onConnect: () => () => {},
    request,
  } as unknown as ParallaxBridge;
}

const session = (over: Partial<ImportableSession>): ImportableSession => ({
  source: "codex",
  id: "s",
  title: "A session",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

test("picking an app's sessions imports each on that app's agent, then lists them imported", async () => {
  let sessions = [
    session({ source: "claude", id: "c1", title: "Fix the login redirect", cwd: "/src/web" }),
    session({ id: "x1", title: "Finish HW2" }),
    session({ id: "x2", title: "Zip the submission" }),
    session({ id: "x3", title: "Already here", thread: "01a0" }),
  ];
  const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
    if (method === "thread/importable") return { result: { sessions } };
    if (method === "providers/list")
      return {
        result: {
          providers: [
            { instance: { id: "codex", kind: "codex", enabled: true } },
            { instance: { id: "claude", kind: "claude", enabled: false } },
          ],
        },
      };
    if (method === "thread/import") {
      sessions = sessions.map((s) => (s.id === params["id"] ? { ...s, thread: "01a1" } : s));
      return { result: {} };
    }
    throw new Error(`unexpected ${method}`);
  });
  bridge(request);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ImportSessions />));
  const box = (label: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

  expect(document.body.textContent).toContain("1 of 4 imported");
  expect(box("Import Already here")).toBeNull();
  const button = (name: string) =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
  await act(async () => box("Codex").click());
  expect(box("Import Fix the login redirect")).toBeNull();
  await act(async () => button("Select all").click());
  expect(box("Import Finish HW2").checked).toBe(true);
  await act(async () => button("Import 2").click());

  const imports = request.mock.calls.filter(([, method]) => method === "thread/import");
  expect(imports.map(([, , params]) => params)).toEqual([
    { source: "codex", id: "x1", account: { kind: "subscription", backend: "codex" } },
    { source: "codex", id: "x2", account: { kind: "subscription", backend: "codex" } },
  ]);
  expect(document.body.textContent).toContain("3 of 4 imported");
  expect(button("Select all").disabled).toBe(true);
});

test("Refresh lists a computer's sessions again, and the menu lists another connected one's", async () => {
  const found: Record<string, ImportableSession[]> = {
    local: [session({ id: "x1", title: "Finish HW2" })],
    desk: [session({ source: "claude", id: "c9", title: "Run through Remote Control" })],
  };
  const request = vi.fn(async (host: string, method: string) => {
    if (method === "thread/importable") return { result: { sessions: found[host] } };
    if (method === "providers/list") return { result: { providers: [] } };
    throw new Error(`unexpected ${method}`);
  });
  bridge(request, [{ id: "desk", name: "Desktop PC" }]);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ImportSessions />));
  const text = () => document.body.textContent;
  expect(text()).toContain("Finish HW2");

  found["local"] = [...found["local"]!, session({ id: "x2", title: "Started a minute ago" })];
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click(),
  );
  expect(text()).toContain("Started a minute ago");

  await act(async () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[role="menu"][aria-label="Computer"] [role="menuitemradio"]',
      ),
    ]
      .find((o) => o.textContent === "Desktop PC")!
      .click(),
  );
  expect(text()).toContain("Run through Remote Control");
  expect(text()).not.toContain("Finish HW2");
  expect(request).toHaveBeenCalledWith("desk", "thread/importable", {});
});

test("the menu leaves out a computer that isn't connected, and an import's reload doesn't replace the next one's list", async () => {
  let imported: (value: unknown) => void = () => {};
  const found: Record<string, ImportableSession[]> = {
    local: [session({ id: "x1", title: "On this computer" })],
    desk: [session({ id: "d1", title: "On the desktop" })],
  };
  const request = vi.fn((host: string, method: string) => {
    if (method === "providers/list") return Promise.resolve({ result: { providers: [] } });
    if (method === "thread/import") return new Promise((resolve) => (imported = resolve));
    return Promise.resolve({ result: { sessions: found[host] } });
  });
  bridge(
    request,
    [
      { id: "desk", name: "Desktop PC" },
      { id: "lab", name: "Lab" },
    ],
    ["lab"],
  );
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ImportSessions />));
  const options = () => [
    ...document.querySelectorAll<HTMLElement>(
      '[role="menu"][aria-label="Computer"] [role="menuitemradio"]',
    ),
  ];
  expect(options().map((o) => o.textContent)).toEqual(["This computer", "Desktop PC"]);

  // An import on this computer finishes after the desktop is picked.
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('input[aria-label="Import On this computer"]')!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Import 1")!.click(),
  );
  await act(async () =>
    options()
      .find((o) => o.textContent === "Desktop PC")!
      .click(),
  );
  await act(async () => imported({ result: {} }));
  const text = document.body.textContent;
  expect(text).toContain("On the desktop");
  expect(text).not.toContain("On this computer");
});

test("claude.ai's Remote Control sessions join the list, marked remote, and import as remote", async () => {
  const request = vi.fn(async (_host: string, method: string, params: Record<string, unknown>) => {
    if (method === "providers/list") return { result: { providers: [] } };
    if (method === "thread/import") return { result: {} };
    if (params["remote"])
      return {
        result: {
          sessions: [
            session({
              source: "claude",
              id: "session_01r1",
              title: "Hello from Claude RC",
              updatedAt: "2026-10-02T00:00:00Z",
              remote: true,
            }),
          ],
        },
      };
    return { result: { sessions: [session({ id: "x1", title: "Finish HW2" })] } };
  });
  bridge(request, [], [], true);
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<ImportSessions />));

  const rows = [...document.querySelectorAll('ul[aria-label="Sessions"] li')];
  expect(rows.map((r) => r.querySelector('[role="img"]')?.getAttribute("aria-label"))).toEqual([
    "Remote Control, from claude.ai",
    undefined,
  ]);
  await act(async () =>
    document
      .querySelector<HTMLInputElement>('input[aria-label="Import Hello from Claude RC"]')!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Import 1")!.click(),
  );
  expect(request).toHaveBeenCalledWith("local", "thread/import", {
    source: "claude",
    id: "session_01r1",
    remote: true,
  });
});
