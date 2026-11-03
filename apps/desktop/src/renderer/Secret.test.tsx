// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { notify } from "./notifications";
import { isEnvFile, SecretCard } from "./Secret";

vi.mock("./notifications", () => ({ notify: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request = vi.fn(async () => ({ result: {}, logId: "log-1" }));
Object.assign(window, { parallax: { request } });

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  request.mockClear();
});

function card(delivery?: "file") {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  act(() =>
    root!.render(
      <SecretCard
        hostId="h1"
        runId="r1"
        secret={{
          kind: "secret",
          key: "k1",
          request: {
            requestId: "s1",
            label: "Webhook secret",
            reason: "To check signatures.",
            delivery,
          },
        }}
      />,
    ),
  );
  return el;
}

test("Save sends the value to secret/answer from a password field, and Decline sends none", async () => {
  const el = card();
  const input = el.querySelector("input")!;
  expect(input.type).toBe("password");
  expect(el.textContent).toContain("To check signatures.");
  input.value = "example";
  await act(async () => el.querySelector("form")!.requestSubmit());
  expect(request).toHaveBeenCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "save", secret: "example" },
  });

  act(() => root!.unmount());
  const again = card();
  const decline = [...again.querySelectorAll("button")].find((b) => b.textContent === "Decline")!;
  await act(async () => decline.click());
  expect(request).toHaveBeenLastCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "decline" },
  });
});

test("A file request says commands can read it, and Enter is a new line until Command-Enter saves", async () => {
  const el = card("file");
  expect(el.textContent).toContain("this agent's commands can read for 24 hours");
  expect(el.textContent).not.toContain("never the value");
  const field = el.querySelector("textarea")!;
  field.value = "A=1\nB=2\n";
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  await act(async () => field.dispatchEvent(enter));
  expect(request).not.toHaveBeenCalled();
  const save = new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true });
  await act(async () => field.dispatchEvent(save));
  expect(request).toHaveBeenCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "save", secret: "A=1\nB=2\n" },
  });
});

const env = '# old-value\nAPI_KEY=abc\n\nEMPTY=\nexport DB_URL="postgres://x"\n';

function painted(el: HTMLElement) {
  return el.querySelector("[data-testid=secret-paint]")!.textContent;
}

async function pick(el: HTMLElement, file: File) {
  const picker = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await file.text();
  });
}

test("An env file shows its names masked, and its values only once asked", async () => {
  const el = card("file");
  const field = el.querySelector("textarea")!;
  field.value = env;
  await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  expect(painted(el)).toBe("•••••••••••\nAPI_KEY=•••\n\n••••••\nexport DB_URL=••••••••••••••\n\n");
  const show = el.querySelector<HTMLButtonElement>('button[aria-label="Show values"]')!;
  await act(async () => show.click());
  expect(painted(el)).toBe(`${env}\n`);
  await act(async () => show.click());
  expect(painted(el)).not.toContain("abc");
});

test("A picked file loads into the editor by name, fully masked if it isn't an env file", async () => {
  const el = card("file");
  const text = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
  await pick(el, new File([text], "deploy.pem"));
  await vi.waitFor(() => expect(el.textContent).toContain("deploy.pem"));
  expect(el.querySelector("textarea")!.value).toBe(text);
  expect(painted(el)).not.toMatch(/[A-Za-z]/);
});

test.each([
  ["too large", new File(["x".repeat(64 * 1024 + 1)], "big.env"), "up to 64 KB"],
  ["binary", new File(["a\0b"], "key.p12"), "text file"],
])("A %s file is refused", async (_, file, body) => {
  const el = card("file");
  await pick(el, file);
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(body) }),
    ),
  );
  expect(el.textContent).not.toContain(file.name);
});

test("isEnvFile takes an env file with variables that have values", () => {
  expect(isEnvFile(env)).toBe(true);
  expect(isEnvFile("A=1\r\nB='two words'\r\n")).toBe(true);
});

test.each([
  ["a password with an equals sign", "ABC=def"],
  ["a single variable, which could be a password copied with its newline", "ABC=def\n"],
  ["base32 tokens with padding", "ABCDEF==\nGHIJKL=="],
  ["base32 tokens with single padding", "ABCDEFG=\nHIJKLMN="],
  ["a quoted value spanning lines", 'CONFIG="user=a\npass=b"'],
  ["a private key", "-----BEGIN KEY-----\nabc=\nDEF=x\n-----END KEY-----"],
  ["assignments among other text", "A=1\nB=2\nnot an assignment"],
])("isEnvFile refuses %s", (_, value) => {
  expect(isEnvFile(value)).toBe(false);
});
