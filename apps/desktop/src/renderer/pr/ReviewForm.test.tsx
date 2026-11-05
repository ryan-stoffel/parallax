// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";

import type { PrWrite } from "../../protocol/generated/protocol";
import { CommentBox } from "./CommentBox";
import { ReviewForm } from "./ReviewForm";
import { ReviewThread } from "./ReviewThread";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let key = 0;

async function mount(node: React.ReactNode) {
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () => createRoot(root).render(node));
  return root;
}

const button = (root: Element, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

async function type(root: Element, text: string) {
  const field = root.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function form(props: { reviewId?: string; pending?: number }) {
  const write = vi.fn<(w: PrWrite) => Promise<boolean>>(async () => true);
  return { write, node: <ReviewForm write={write} open draftKey={`t/${key++}`} {...props} /> };
}

test("with a pending review, Comment sends it, its comments enough with no summary", async () => {
  const { write, node } = form({ reviewId: "PRR_1", pending: 2 });
  const root = await mount(node);
  expect(root.textContent).toContain("Sends with 2 pending comments");
  await act(async () => button(root, "Comment")!.click());
  expect(write).toHaveBeenCalledWith({
    kind: "submitReview",
    reviewId: "PRR_1",
    event: "comment",
    body: "",
  });
});

test("with a pending review, a verdict sends it", async () => {
  const { write, node } = form({ reviewId: "PRR_1", pending: 1 });
  const root = await mount(node);
  await act(async () => button(root, "Request changes")!.click());
  expect(write.mock.calls[0]![0]).toMatchObject({ kind: "submitReview", event: "requestChanges" });
});

test("with no pending review, the box comments and reviews as before", async () => {
  const { write, node } = form({});
  const root = await mount(node);
  expect(button(root, "Comment")!.disabled).toBe(true);
  expect(button(root, "Discard")).toBeUndefined();
  await type(root, "Looks good");
  await act(async () => button(root, "Comment")!.click());
  expect(write).toHaveBeenCalledWith({ kind: "comment", body: "Looks good" });
});

test("a comment box offers a single comment only with no pending review", async () => {
  const onSend = vi.fn(async () => true);
  const box = (pending: boolean) => (
    <CommentBox
      target={{ path: "a.ts", range: { side: "left", start: 2, end: 4 } }}
      draftKey={`t/${key++}`}
      pending={pending}
      onText={() => {}}
      onSend={onSend}
      onCancel={() => {}}
    />
  );
  const fresh = await mount(box(false));
  expect(fresh.textContent).toContain("Lines 2 to 4, old file");
  expect(button(fresh, "Start a review")).toBeDefined();
  await type(fresh, "Why?");
  await act(async () => button(fresh, "Add single comment")!.click());
  expect(onSend).toHaveBeenCalledWith("Why?", true);

  const inReview = await mount(box(true));
  expect(button(inReview, "Add single comment")).toBeUndefined();
  expect(button(inReview, "Add to review")).toBeDefined();
});

test("a comment box scrolled away keeps its lines locked while it holds text", async () => {
  const onText = vi.fn();
  const root = document.createElement("div");
  const mounted = createRoot(root);
  await act(async () =>
    mounted.render(
      <CommentBox
        target={{ path: "a.ts" }}
        draftKey={`t/${key++}`}
        pending={false}
        onText={onText}
        onSend={async () => true}
        onCancel={() => {}}
      />,
    ),
  );
  await type(root, "Why?");
  expect(onText).toHaveBeenLastCalledWith(true);
  await act(async () => mounted.unmount());
  expect(onText).toHaveBeenLastCalledWith(true);
});

test("a thread folds when it's resolved, and opens again when it's reopened", async () => {
  const root = document.createElement("div");
  const mounted = createRoot(root);
  const thread = (resolved: boolean) => (
    <ReviewThread
      bare
      repo="o/r"
      onOpen={() => {}}
      thread={{ id: "T1", resolved, comments: [{ author: "a", body: "the body" }] }}
    />
  );
  await act(async () => mounted.render(thread(false)));
  expect(root.querySelector("ol")).not.toBeNull();
  await act(async () => mounted.render(thread(true)));
  expect(root.querySelector("ol")).toBeNull();
  expect(root.textContent).toContain("Resolved");
  await act(async () => mounted.render(thread(false)));
  expect(root.querySelector("ol")).not.toBeNull();
});
