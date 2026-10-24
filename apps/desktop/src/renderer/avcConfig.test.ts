import { expect, test } from "vite-plus/test";

import { simulatorAvcConfig } from "./avcConfig";

// T3 Code's captures of the hub's description, from its low-latency encoder and its fallback.
const lowLatency = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 22, 39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20, 158, 106, 154, 129,
  1, 1, 3, 194, 1, 8, 248, 1, 0, 4, 40, 238, 60, 176,
]);
const fallback = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40,
  238, 60, 176,
]);
const repaired = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35,
  80, 1, 0, 4, 40, 238, 60, 176,
]);

test("the fallback encoder's SPS gets no reordering and one reference frame, once", () => {
  const original = fallback.slice();
  expect(simulatorAvcConfig(fallback)).toEqual(repaired);
  expect(fallback).toEqual(original);
  expect(simulatorAvcConfig(repaired)).toBe(repaired);
});

test("an SPS that already has VUI passes through", () => {
  expect(simulatorAvcConfig(lowLatency)).toBe(lowLatency);
});

test("every SPS in a description is repaired, and its PPS and profile extensions kept", () => {
  const extensions = [0xfd, 0xf8, 0xf8, 0];
  const description = Uint8Array.from([
    ...fallback.subarray(0, 5),
    0xe2,
    ...fallback.subarray(6, 20),
    ...lowLatency.subarray(6, 30),
    ...fallback.subarray(20),
    ...extensions,
  ]);
  expect(simulatorAvcConfig(description)).toEqual(
    Uint8Array.from([
      ...description.subarray(0, 6),
      ...repaired.subarray(6, 25),
      ...lowLatency.subarray(6, 30),
      ...fallback.subarray(20),
      ...extensions,
    ]),
  );
});

test("a truncated, malformed, or unfamiliar description passes through", () => {
  for (const config of [fallback, lowLatency]) {
    for (let length = 0; length < config.length; length++) {
      const truncated = config.subarray(0, length);
      expect(simulatorAvcConfig(truncated)).toBe(truncated);
    }
  }
  const changed = (at: number, value: (byte: number) => number) => {
    const config = fallback.slice();
    config[at] = value(config[at]!);
    return config;
  };
  for (const config of [
    changed(9, () => 110), // High 10 profile
    changed(12, (byte) => byte | 1), // scaling lists
    changed(6, () => 0xff), // SPS length past the end
    changed(21, () => 0xff), // PPS length past the end
    changed(19, () => 0), // no rbsp_stop_one_bit
    changed(8, (byte) => byte | 0x80), // forbidden_zero_bit set
  ]) {
    expect(simulatorAvcConfig(config)).toBe(config);
  }
  const unterminated = fallback.slice();
  unterminated.fill(0, 12, 20);
  expect(simulatorAvcConfig(unterminated)).toBe(unterminated);
  const oversized = new Uint8Array(64 * 1024 + 1);
  oversized.set(fallback);
  expect(simulatorAvcConfig(oversized)).toBe(oversized);
});
