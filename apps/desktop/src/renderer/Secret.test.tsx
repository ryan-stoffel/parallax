// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { notify } from "./notifications";
import { envNames, SecretCard } from "./Secret";

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

test("A file request says commands can read it, keeps newlines, and saves on Enter", async () => {
  const el = card("file");
  expect(el.textContent).toContain("this agent's commands can read for 24 hours");
  expect(el.textContent).not.toContain("never the value");
  const field = el.querySelector("textarea")!;
  field.value = "A=1\nB=2\n";
  const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true });
  await act(async () => field.dispatchEvent(newline));
  expect(request).not.toHaveBeenCalled();
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
  await act(async () => field.dispatchEvent(enter));
  expect(request).toHaveBeenCalledWith("h1", "secret/answer", {
    runId: "r1",
    requestId: "s1",
    answer: { type: "save", secret: "A=1\nB=2\n" },
  });
});

const env = '# old-value\nAPI_KEY=abc\n\nEMPTY=\nexport DB_URL="postgres://x"\n';

function savedSecret() {
  return (request.mock.lastCall as unknown as [string, string, { answer: { secret: string } }])[2]
    .answer.secret;
}

test("A pasted env file lists its names, hides its values, and still saves all of it", async () => {
  const el = card("file");
  const field = el.querySelector("textarea")!;
  const paste = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
    clipboardData: { getData: () => env },
  });
  await act(async () => field.dispatchEvent(paste));
  expect(paste.defaultPrevented).toBe(true);
  const names = [...el.querySelectorAll("li span:first-child")].map((name) => name.textContent);
  expect(names).toEqual(["API_KEY", "DB_URL"]);
  expect(el.textContent).toContain("2 variables");
  expect(el.textContent).not.toContain("abc");
  expect(el.textContent).not.toContain("postgres");
  await act(async () => el.querySelector("form")!.requestSubmit());
  expect(savedSecret()).toBe(env);
});

test("A picked file shows by name, and Remove goes back to an empty field", async () => {
  const el = card("file");
  const picker = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["-----BEGIN KEY-----\nabc\n-----END KEY-----\n"], "deploy.pem");
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await file.text();
  });
  await vi.waitFor(() => expect(el.textContent).toContain("deploy.pem"));
  expect(el.textContent).toContain("3 lines");
  expect(el.querySelector("ul")).toBeNull();
  const remove = el.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')!;
  await act(async () => remove.click());
  expect(el.textContent).not.toContain("deploy.pem");
  expect(el.querySelector("textarea")!.value).toBe("");
});

test.each([
  ["too large", new File(["x".repeat(64 * 1024 + 1)], "big.env"), "up to 64 KB"],
  ["binary", new File(["a\0b"], "key.p12"), "text file"],
])("A %s file is refused", async (_, file, body) => {
  const el = card("file");
  const picker = el.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(picker, "files", { value: [file], configurable: true });
  await act(async () => {
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await file.text();
  });
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(body) }),
    ),
  );
  expect(el.textContent).not.toContain(file.name);
});

test("envNames takes an env file's variables with values", () => {
  expect(envNames(env)).toEqual(["API_KEY", "DB_URL"]);
  expect(envNames("A=1\r\nB='two words'\r\n")).toEqual(["A", "B"]);
});

test.each([
  ["a password with an equals sign", "ABC=def"],
  ["a single variable, which could be a password copied with its newline", "ABC=def\n"],
  ["base32 tokens with padding", "ABCDEF==\nGHIJKL=="],
  ["base32 tokens with single padding", "ABCDEFG=\nHIJKLMN="],
  ["a quoted value spanning lines", 'CONFIG="user=a\npass=b"'],
  ["a private key", "-----BEGIN KEY-----\nabc=\nDEF=x\n-----END KEY-----"],
  ["assignments among other text", "A=1\nB=2\nnot an assignment"],
])("envNames shows no names for %s", (_, value) => {
  expect(envNames(value)).toEqual([]);
});
