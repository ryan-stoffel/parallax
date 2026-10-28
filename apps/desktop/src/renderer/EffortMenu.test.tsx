// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";

import type { AgentEffort } from "../protocol/generated/protocol";
import { EffortMenu } from "./EffortMenu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("the gauge catches fire when turned up to Max, not when it opens there", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const show = (value: AgentEffort) =>
    act(() => root.render(<EffortMenu value={value} onChange={() => {}} />));
  const fire = () => host.querySelector(".effort-fire");

  show("max");
  expect(fire()).toBeNull();
  show("xhigh");
  expect(fire()).toBeNull();
  show("max");
  expect(fire()).not.toBeNull();
  act(() => root.unmount());
});
