import { expectTypeOf, test } from "vite-plus/test";

import type { ParallaxRequests } from "./generated/protocol";

// The shape a typed client call takes: the method name picks its params. `pnpm check` type-checks
// this file, so params that loosen to `any` fail it.
type Params<M extends keyof ParallaxRequests> = ParallaxRequests[M]["params"];

test("wrong params and unknown methods fail to type-check", () => {
  // @ts-expect-error: project/create needs an id and a repoPath too.
  expectTypeOf({ name: "parallax" }).toExtend<Params<"project/create">>();
  // @ts-expect-error: there is no project/nope method.
  expectTypeOf<Params<"project/nope">>().toBeObject();
});
