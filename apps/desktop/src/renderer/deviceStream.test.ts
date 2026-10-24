import { afterEach, expect, test, vi } from "vite-plus/test";

import {
  AvccDemuxer,
  avcCodec,
  createDeviceStream,
  hidUsage,
  keyFor,
  parseSemu,
  scanAccessUnit,
} from "./deviceStream";

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

test("pasted text types as US keyboard keys on iOS", () => {
  expect(keyFor("a")).toEqual({ usage: 0x04, shift: false });
  expect(keyFor("Z")).toEqual({ usage: 0x1d, shift: true });
  expect(keyFor("0")).toEqual({ usage: 0x27, shift: false });
  expect(keyFor("@")).toEqual({ usage: 0x1f, shift: true });
  expect(keyFor("?")).toEqual({ usage: 0x38, shift: true });
  expect(keyFor("\n")).toEqual({ usage: 0x28, shift: false });
  expect(keyFor("é")).toBeNull();
  expect(hidUsage("KeyA")).toBe(0x04);
  expect(hidUsage("Digit1")).toBe(0x1e);
  expect(hidUsage("F13")).toBeNull();
});

/** A VideoDecoder that records what it's given. */
class FakeDecoder {
  static made: FakeDecoder[] = [];
  static isConfigSupported = async () => ({ supported: true });
  state = "unconfigured";
  decodeQueueSize = 0;
  configs: VideoDecoderConfig[] = [];
  decoded: string[] = [];
  constructor() {
    FakeDecoder.made.push(this);
  }
  configure(config: VideoDecoderConfig) {
    this.state = "configured";
    this.configs.push(config);
  }
  decode(chunk: { type: string }) {
    this.decoded.push(chunk.type);
  }
  close() {
    this.state = "closed";
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeDecoder.made = [];
});

test("iOS video without a description reopens for one, then reuses it", async () => {
  const opened: { id: string; kind: string; send: (data: Uint8Array) => void }[] = [];
  const closed: string[] = [];
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(public init: { type: string }) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal("window", {
    parallax: {
      openDeviceStream: async (
        _host: string,
        params: { streamId: string; kind: string },
        listener: (message: { type: "data"; data: Uint8Array }) => void,
      ) => {
        opened.push({
          id: params.streamId,
          kind: params.kind,
          send: (data) => listener({ type: "data", data }),
        });
        return undefined;
      },
      sendDeviceStream: () => {},
      closeDeviceStream: (id: string) => closed.push(id),
    },
  });
  const events = { onStatus: () => {}, onScreen: () => {}, onInput: () => {} };
  const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
  const stream = createDeviceStream(
    { hostId: "h", deviceId: "d", platform: "ios" },
    canvas,
    events,
  );
  stream.start();
  const videos = () => opened.filter((each) => each.kind === "video");
  const decoder = () => FakeDecoder.made.at(-1)!;

  // A new capture session's first stream: a keyframe, and no description.
  videos()[0]!.send(envelope(2, [1]));
  expect(closed).toEqual([videos()[0]!.id]);
  expect(videos()).toHaveLength(2);

  // The reopened stream's keyframe lands right behind its description, while it's configured.
  videos()[1]!.send(new Uint8Array([...envelope(1, [1, 0x64, 0, 0x33]), ...envelope(2, [2])]));
  await vi.waitFor(() => expect(decoder().decoded).toEqual(["key"]));

  // Restarted behind: the new stream sends no description, and the last one still holds.
  decoder().decodeQueueSize = 9;
  videos()[1]!.send(envelope(3, [3]));
  expect(videos()).toHaveLength(3);
  videos()[2]!.send(envelope(2, [4]));
  expect(decoder().configs.at(-1)!.codec).toBe("avc1.640033");
  expect(decoder().decoded).toEqual(["key"]);
  stream.stop();
});
