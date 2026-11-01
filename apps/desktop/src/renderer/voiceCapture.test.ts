import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vite-plus/test";

test("the real audio worklet normalizes clipped and nonfinite microphone samples", () => {
  const sent: { samples?: Float32Array }[] = [];
  let Processor!: new () => { process(input: number[][][]): boolean };
  runInNewContext(readFileSync(new URL("./voiceCapture.worklet.js", import.meta.url), "utf8"), {
    sampleRate: 4,
    AudioWorkletProcessor: class {
      port = { postMessage: (message: { samples?: Float32Array }) => sent.push(message) };
    },
    registerProcessor: (_name: string, processor: typeof Processor) => {
      Processor = processor;
    },
  });
  const processor = new Processor();
  processor.process([[[3, -3, Infinity, NaN]]]);
  expect(Array.from(sent[0]!.samples!)).toEqual([1, -1, 0, 0]);
  processor.process([
    [
      [0.5, 0.2, -0.5, 0],
      [0.7, 0.4, -0.7, 0],
    ],
  ]);
  const samples = Array.from(sent[1]!.samples!);
  expect(samples[0]).toBeCloseTo(0.6);
  expect(samples[1]).toBeCloseTo(0.3);
  expect(samples[2]).toBeCloseTo(-0.6);
  expect(samples[3]).toBe(0);
});
