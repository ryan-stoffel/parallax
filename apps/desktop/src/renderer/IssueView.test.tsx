// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";

import type { Issue, IssueDetail } from "../protocol/generated/protocol";
import { IssueView } from "./IssueView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has no popovers, which the picker's menu is.
HTMLElement.prototype.hidePopover = () => {};

const issue: Issue = {
  connectionId: "jira",
  provider: "jira",
  id: "OPS-1",
  key: "OPS-1",
  title: "Rotate the certificates",
  url: "https://acme.atlassian.net/browse/OPS-1",
  state: { id: "21", name: "In Progress", category: "inProgress" },
  container: { id: "OPS", name: "Operations" },
  updatedAt: "2026-11-17T12:00:00Z",
};
const detail: IssueDetail = {
  issue,
  body: "",
  comments: [],
  states: [
    { id: "11", name: "To Do", category: "todo" },
    { id: "21", name: "In Progress", category: "inProgress" },
  ],
};

test("the state picker moves an issue to another state, and never to its own", async () => {
  const request = vi.fn(async (_host: string, method: string) => ({
    result: method === "issue/get" ? detail : issue,
  }));
  (window as unknown as { parallax: unknown }).parallax = { request };
  const root = document.createElement("div");
  document.body.append(root);
  await act(async () =>
    createRoot(root).render(
      <IssueView
        entry={{ hostId: "mac", issue }}
        onBack={() => {}}
        onChanged={() => {}}
        onStartThread={() => {}}
      />,
    ),
  );
  const pick = (name: string) =>
    act(async () =>
      [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((b) => b.textContent?.trim() === name)!
        .click(),
    );
  const sets = () => request.mock.calls.filter(([, method]) => method === "issue/setState");

  const move = ["mac", "issue/setState", { connectionId: "jira", id: "OPS-1", stateId: "11" }];
  await pick("To Do");
  expect(sets()).toEqual([move]);
  // The fake still reports In Progress, the state picked now.
  await pick("In Progress");
  expect(sets()).toEqual([move]);
});
