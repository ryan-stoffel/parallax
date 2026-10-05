import assert from "node:assert/strict";
import test from "node:test";

import { failureOf, userMessage, viewResult, viewTool } from "./protocol.mjs";

test("a plan tool becomes ExitPlanMode with the plan text", () => {
  const view = viewTool({ type: "createPlan", args: { plan: "# Do it" } });
  assert.equal(view.name, "ExitPlanMode");
  assert.deepEqual(view.input, { plan: "# Do it" });
  assert.equal(view.plan, "# Do it");
});

test("a shell tool becomes Bash, and todos keep their text", () => {
  assert.deepEqual(viewTool({ type: "shell", args: { command: "ls" } }).input, { command: "ls" });
  assert.deepEqual(
    viewTool({
      type: "updateTodos",
      args: { todos: [{ content: "Write it", status: "inProgress" }] },
    }).todos,
    [{ text: "Write it", status: "inProgress" }],
  );
});

test("a failed tool result is an error, and a success is clipped later by the caller", () => {
  assert.deepEqual(viewResult({ result: { status: "error", error: "no" } }), {
    status: "error",
    output: "no",
  });
  assert.equal(viewResult({ result: { status: "success", value: { ok: true } } }).status, "ok");
});

test("auth and rate-limit errors are named, and everything else failed", () => {
  assert.equal(failureOf({ name: "AuthenticationError", message: "no" }), "notSignedIn");
  assert.equal(failureOf({ name: "RateLimitError", message: "slow" }), "rateLimited");
  assert.equal(failureOf({ message: "HTTP 401" }), "notSignedIn");
  assert.equal(failureOf({ message: "the workspace vanished" }), "failed");
});

test("images go through with their media type, and text stays even when empty", () => {
  assert.deepEqual(userMessage("", [{ data: "aaaa", mediaType: "image/png" }, { data: 1 }]), {
    text: "",
    images: [{ data: "aaaa", mimeType: "image/png" }],
  });
  assert.deepEqual(userMessage("hi"), { text: "hi" });
});
