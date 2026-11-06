import { expectTypeOf, test } from "vite-plus/test";

import type { ParallaxRequests } from "./generated/protocol";

// The shape a typed client call takes: the method name picks its params. `pnpm check` type-checks
// this file, so params that loosen to `any` fail it.
type Params<M extends keyof ParallaxRequests> = ParallaxRequests[M]["params"];

test("wrong params and unknown methods fail to type-check", () => {
  // @ts-expect-error: orchestrator/create needs an id and a repoPath too.
  expectTypeOf({ name: "parallax" }).toExtend<Params<"orchestrator/create">>();
  // @ts-expect-error: there is no orchestrator/nope method.
  expectTypeOf<Params<"orchestrator/nope">>().toBeObject();
});
