import { expect, test } from "vite-plus/test";

import { ErrorCodes, PROTOCOL_VERSION } from "../protocol/generated/protocol";
import { INTERNAL_ERROR, INVALID_PARAMS, PROTOCOL_VERSION as WEB_PROTOCOL } from "./webBridge";

// webBridge.ts copies these so the web chunk shares no module with the app's.
test("the web bridge's protocol constants match the generated protocol", () => {
  expect(WEB_PROTOCOL).toBe(PROTOCOL_VERSION);
  expect(INTERNAL_ERROR).toBe(ErrorCodes.InternalError);
  expect(INVALID_PARAMS).toBe(ErrorCodes.InvalidParams);
});
