import { expectTypeOf, test } from "vite-plus/test";

import type {
  AccountsDefaultsGetResult,
  AccountsDefaultsSetParams,
  EventsEventParams,
  ProjectCreateParams,
  ProjectListResult,
  ProjectUpdateParams,
  ProjectUpdateResult,
  WispNotifications,
  WispRequests,
} from "./generated/protocol";

// The shape a typed client call takes: the method name picks its params and result.
type Params<M extends keyof WispRequests> = WispRequests[M]["params"];
type Result<M extends keyof WispRequests> = WispRequests[M]["result"];

// These assertions are checked by `pnpm check`, which type-checks this file.
test("each method maps to its params and result types", () => {
  expectTypeOf<Params<"project/create">>().toEqualTypeOf<ProjectCreateParams>();
  expectTypeOf<Result<"project/list">>().toEqualTypeOf<ProjectListResult>();
  expectTypeOf<Params<"project/update">>().toEqualTypeOf<ProjectUpdateParams>();
  expectTypeOf<Result<"project/update">>().toEqualTypeOf<ProjectUpdateResult>();
  expectTypeOf<Params<"accounts/defaults/set">>().toEqualTypeOf<AccountsDefaultsSetParams>();
  expectTypeOf<Result<"accounts/defaults/set">>().toEqualTypeOf<AccountsDefaultsGetResult>();
  expectTypeOf<WispNotifications["events/event"]>().toEqualTypeOf<EventsEventParams>();
});

test("wrong params and unknown methods fail to type-check", () => {
  // @ts-expect-error: project/create needs an id and a repoPath too.
  expectTypeOf({ name: "wisp" }).toExtend<Params<"project/create">>();
  // @ts-expect-error: there is no project/nope method.
  expectTypeOf<Params<"project/nope">>().toBeObject();
});
