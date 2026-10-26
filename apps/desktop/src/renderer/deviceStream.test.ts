import { expect, test } from "vite-plus/test";

import { AvccDemuxer, avcCodec, parseSemu, scanAccessUnit } from "./deviceStream";

const envelope = (tag: number, payload: number[]) => {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1);
  out[4] = tag;
  out.set(payload, 5);
  return out;
};

test("AVCC envelopes come out whole however the body splits them", () => {
  const body = new Uint8Array([
    ...envelope(1, [1, 0x64, 0, 0x1f]),
    ...envelope(2, [9, 9, 9]),
    ...envelope(9, [0]),
    ...envelope(3, [7]),
  ]);
  for (let split = 0; split <= body.length; split++) {
    const demuxer = new AvccDemuxer();
    const chunks = [
      ...demuxer.push(body.subarray(0, split)),
      ...demuxer.push(body.subarray(split)),
    ];
    expect(chunks.map((c) => [c.type, [...c.payload]])).toEqual([
      ["description", [1, 0x64, 0, 0x1f]],
      ["keyframe", [9, 9, 9]],
      ["delta", [7]],
    ]);
  }
  expect(avcCodec(new Uint8Array([1, 0x64, 0, 0x1f]))).toBe("avc1.64001f");
});

test("a SEMU frame gives its key flag and timestamp, and a bare access unit is scanned", () => {
  const frame = new Uint8Array(20);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0x53454d55);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setBigUint64(8, 1234n);
  frame.set([0, 0, 1, 0x65], 16);
  const parsed = parseSemu(frame);
  expect([parsed.key, parsed.timestamp, [...parsed.data]]).toEqual([true, 1234, [0, 0, 1, 0x65]]);

  const bare = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0x1f, 0, 0, 1, 0x65, 0xaa]);
  expect(parseSemu(bare).key).toBeNull();
  const { key, sps } = scanAccessUnit(bare);
  expect(key).toBe(true);
  expect(avcCodec(sps!)).toBe("avc1.64001f");
});
