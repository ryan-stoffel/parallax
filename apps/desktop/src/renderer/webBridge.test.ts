import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { ErrorCodes, PROTOCOL_VERSION } from "../protocol/generated/protocol";
import { INTERNAL_ERROR, INVALID_PARAMS, PROTOCOL_VERSION as WEB_PROTOCOL } from "./webBridge";

// webBridge.ts copies these so the web chunk shares no module with the app's.
test("the web bridge's protocol constants match the generated protocol", () => {
  expect(WEB_PROTOCOL).toBe(PROTOCOL_VERSION);
  expect(INTERNAL_ERROR).toBe(ErrorCodes.InternalError);
  expect(INVALID_PARAMS).toBe(ErrorCodes.InvalidParams);
});

// plxd serves the renderer build to anyone who reaches it (PLX-651), so nothing from the build's
// environment, such as a key, may be compiled into it.
test("the renderer reads no environment, so its build holds no secrets", () => {
  const dirs = ["src/renderer", "src/protocol"];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
      .map((file) => path.join(dir, file)),
  );
  const reading = [...files, "src/preload/bridge.ts"].filter((file) =>
    /import\.meta\.env|process\.env/.test(readFileSync(file, "utf8")),
  );
  expect(reading).toEqual([]);
});
