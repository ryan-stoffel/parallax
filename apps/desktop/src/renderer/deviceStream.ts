// The Device panel's live view of a simulator or emulator (PLX-886), ported from T3 Code's
// `packages/client-runtime/src/device/stream.ts` (MIT, T3 Tools Inc.) to plxd's relay of Expo's
// device hub. iOS sends H.264 as AVCC envelopes on a video stream, and takes HID input and sends
// its screen size on a control stream; Android sends SEMU-framed H.264 and takes JSON input on one
// control stream. Frames decode with WebCodecs onto a canvas.

import type { DevicePlatform, DeviceStreamKind } from "../protocol/generated/protocol";

export type DeviceStreamStatus = "connecting" | "streaming" | "error";

export type DeviceOrientation =
  | "portrait"
  | "portrait_upside_down"
  | "landscape_left"
  | "landscape_right";

/** The device's screen in pixels, as its stream reports it. */
export interface DeviceScreen {
  width: number;
  height: number;
  orientation: DeviceOrientation;
  /** A folding iPhone Duo's live display, 1 the cover and 3 the inside, and its hinge in degrees. */
  fold?: { display: number; angle: number };
}

/** How an iPhone Duo can be folded: shut on its cover, half open as a book, or flat open. */
export type DuoPose = "closed" | "book" | "open";

export interface DeviceStreamEvents {
  onStatus: (status: DeviceStreamStatus, detail?: string) => void;
  onScreen: (screen: DeviceScreen) => void;
  /** Whether input reaches the device. */
  onInput: (connected: boolean) => void;
  /** A new frame is on the canvas, for a view that copies it, such as the 3D view's screen. */
  onFrame?: () => void;
}

export type DeviceButton = "home" | "back" | "recents" | "power" | "appSwitcher";

export interface DeviceStream {
  start(): void;
  stop(): void;
  /** A touch at `x` and `y` from 0 to 1 across the shown screen. */
  touch(phase: "begin" | "move" | "end", x: number, y: number): void;
  /** A touch at `x` and `y` from 0 to 1 across the device's own screen, however it's turned. */
  touchRaw(phase: "begin" | "move" | "end", x: number, y: number): void;
  key(event: KeyboardEvent, phase: "down" | "up"): void;
  /** Types `text`: as text on Android, as US keyboard keys on iOS. */
  text(text: string): void;
  button(button: DeviceButton): void;
  /** iOS: turns the simulator to its next orientation. */
  rotate(): void;
  /** iOS: turns the simulator to `orientation`. */
  orient(orientation: DeviceOrientation): void;
  /** iPhone Duo: folds it to `pose`. */
  fold(pose: DuoPose): void;
}

const RETRY_MS = 1_000;
const FIRST_FRAME_MS = 15_000;
const FRAME_US = 16_667;
/** Frames the decoder may queue before the stream restarts at a keyframe. */
const DECODE_QUEUE = 8;
const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER = 16;
// serve-emu's input takes at most 300 UTF-8 bytes of text per message.
const ANDROID_TEXT_BYTES = 300;
/** The most characters one paste types on iOS, a key at a time. */
const IOS_TEXT_CHARS = 2_000;

const IOS_TOUCH = 0x03;
const IOS_BUTTON = 0x04;
const IOS_KEY = 0x06;
const IOS_ORIENTATION = 0x07;
const IOS_HINGE = 0x10;
const IOS_SCREEN = 0x82;
const IOS_ADMITTED = 0x83;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function tagged(tag: number, payload: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
}

/** The WebCodecs codec string of an SPS or an `avcC` record: profile, compatibility, level. */
export function avcCodec(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

/** serve-emu's frame: a 16-byte SEMU header, when it has one, then an Annex B access unit. */
export function parseSemu(raw: Uint8Array): {
  data: Uint8Array;
  key: boolean | null;
  timestamp: number | null;
} {
  if (raw.byteLength > SEMU_HEADER) {
    const view = new DataView(raw.buffer, raw.byteOffset, SEMU_HEADER);
    if (view.getUint32(0) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8);
      return {
        data: raw.subarray(SEMU_HEADER),
        key: (view.getUint8(5) & 1) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: raw, key: null, timestamp: null };
}

/** Whether an Annex B access unit has an IDR slice, and its SPS. */
export function scanAccessUnit(buf: Uint8Array): { key: boolean; sps: Uint8Array | null } {
  let key = false;
  let sps: Uint8Array | null = null;
  let i = 0;
  while (i + 2 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      const start = buf[i + 2] === 1 ? 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? 4 : 0;
      if (start) {
        const type = buf[i + start]! & 0x1f;
        if (type === 7 && !sps) sps = buf.subarray(i + start);
        if (type === 5) key = true;
        i += start + 1;
        continue;
      }
    }
    i++;
  }
  return { key, sps };
}

export type AvccChunk = {
  type: "description" | "keyframe" | "delta" | "seed";
  payload: Uint8Array;
};
const AVCC_TAGS: Record<number, AvccChunk["type"]> = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed",
};

/**
 * Splits serve-sim's video body into its envelopes: a 4-byte big-endian length, then a tag byte
 * (`avcC` description, keyframe, delta, or a JPEG seed frame) and its payload.
 */
export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;

  push(bytes: Uint8Array): AvccChunk[] {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
    const chunks: AvccChunk[] = [];
    const view = new DataView(this.buffer.buffer);
    let offset = 0;
    while (this.length - offset >= 4) {
      const size = view.getUint32(offset);
      if (this.length - offset - 4 < size) break;
      const type = size >= 1 ? AVCC_TAGS[this.buffer[offset + 4]!] : undefined;
      if (type) chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + size) });
      offset += 4 + size;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return chunks;
  }
}

const HID_BY_CODE: Record<string, number> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

/** The HID usage of a physical key, by its `KeyboardEvent.code`. */
export function hidUsage(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + code.charCodeAt(3) - 65;
  if (/^Digit[1-9]$/.test(code)) return 0x1e + code.charCodeAt(5) - 49;
  if (code === "Digit0") return 0x27;
  return HID_BY_CODE[code] ?? null;
}

const SHIFTED_DIGITS = ")!@#$%^&*(";
const PUNCTUATION: Record<string, [string, string]> = {
  "-": ["Minus", "_"],
  "=": ["Equal", "+"],
  "[": ["BracketLeft", "{"],
  "]": ["BracketRight", "}"],
  "\\": ["Backslash", "|"],
  ";": ["Semicolon", ":"],
  "'": ["Quote", '"'],
  "`": ["Backquote", "~"],
  ",": ["Comma", "<"],
  ".": ["Period", ">"],
  "/": ["Slash", "?"],
};

/** The US-keyboard key that types `char`, and whether it needs Shift, or null. */
export function keyFor(char: string): { usage: number; shift: boolean } | null {
  if (/^[a-z]$/.test(char)) return { usage: 0x04 + char.charCodeAt(0) - 97, shift: false };
  if (/^[A-Z]$/.test(char)) return { usage: 0x04 + char.charCodeAt(0) - 65, shift: true };
  if (/^[0-9]$/.test(char)) return { usage: hidUsage(`Digit${char}`)!, shift: false };
  const shiftedDigit = SHIFTED_DIGITS.indexOf(char);
  if (shiftedDigit >= 0) return { usage: hidUsage(`Digit${shiftedDigit}`)!, shift: true };
  if (char === " ") return { usage: 0x2c, shift: false };
  if (char === "\n") return { usage: 0x28, shift: false };
  if (char === "\t") return { usage: 0x2b, shift: false };
  for (const [plain, [code, shifted]] of Object.entries(PUNCTUATION)) {
    if (char === plain) return { usage: HID_BY_CODE[code]!, shift: false };
    if (char === shifted) return { usage: HID_BY_CODE[code]!, shift: true };
  }
  return null;
}

const ANDROID_KEYCODES: Record<string, number> = {
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
};

/** serve-sim's names for the buttons a simulator has. */
const IOS_BUTTONS: Partial<Record<DeviceButton, string>> = {
  home: "home",
  appSwitcher: "app_switcher",
  power: "lock",
};

export const ORIENTATIONS: DeviceOrientation[] = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
];

/**
 * A live view of `deviceId` on host `hostId`, drawn onto `canvas`. It reconnects a second after
 * its streams end, until `stop`.
 */
export function createDeviceStream(
  target: { hostId: string; deviceId: string; platform: DevicePlatform },
  canvas: HTMLCanvasElement,
  events: DeviceStreamEvents,
): DeviceStream {
  const { hostId, deviceId, platform } = target;
  const bridge = window.parallax;
  const ios = platform === "ios";
  let stopped = true;
  let generation = 0;
  let control: string | undefined;
  let video: string | undefined;
  let decoderEpoch = 0;
  let videoDecoder: VideoDecoder | null = null;
  let awaitingKey = true;
  let configuring = false;
  let timestamp = 0;
  let decoded = false;
  let firstFrame = false;
  let admitted = false;
  let screen: DeviceScreen | null = null;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const retries = new Map<DeviceStreamKind, ReturnType<typeof setTimeout>>();

  const status = (next: DeviceStreamStatus, detail?: string) => {
    if (!stopped) events.onStatus(next, detail);
  };
  const fail = (detail: string) => {
    if (stopped) return;
    stop();
    events.onInput(false);
    events.onStatus("error", detail);
  };
  const connecting = (detail?: string) => {
    firstFrame = false;
    frameTimer ??= setTimeout(
      () => fail("No video came from the device. Try again."),
      FIRST_FRAME_MS,
    );
    status("connecting", detail);
  };

  const context = canvas.getContext("2d");
  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped || !context) return;
    if (!ios && (screen?.width !== width || screen.height !== height)) {
      screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      events.onScreen(screen);
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(source, 0, 0, width, height);
    events.onFrame?.();
    if (firstFrame) return;
    firstFrame = true;
    clearTimeout(frameTimer);
    frameTimer = undefined;
    status("streaming");
  };

  const closeDecoder = () => {
    decoderEpoch++;
    try {
      videoDecoder?.close();
    } catch {}
    videoDecoder = null;
    awaitingKey = true;
  };

  const configure = async (config: VideoDecoderConfig, current: () => boolean) => {
    const epoch = decoderEpoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (!current() || epoch !== decoderEpoch) return false;
    if (!support.supported) {
      fail(`This computer can't decode the device's ${config.codec} video.`);
      return false;
    }
    if (!videoDecoder || videoDecoder.state === "closed") {
      const decoder: VideoDecoder = new VideoDecoder({
        output: (frame) => {
          try {
            if (videoDecoder === decoder) {
              decoded = true;
              paint(frame, frame.displayWidth, frame.displayHeight);
            }
          } finally {
            frame.close();
          }
        },
        error: () => {
          if (!stopped && videoDecoder === decoder) restartVideo();
        },
      });
      videoDecoder = decoder;
    }
    videoDecoder.configure(full);
    return true;
  };

  const decode = (key: boolean, data: Uint8Array, pts?: number | null) => {
    if (videoDecoder?.state !== "configured") return;
    if (awaitingKey) {
      if (!key) return;
      awaitingKey = false;
    }
    // Behind: start again at a keyframe rather than show old frames late.
    if (videoDecoder.decodeQueueSize > DECODE_QUEUE) return restartVideo();
    try {
      videoDecoder.decode(
        new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: pts ?? timestamp, data }),
      );
      timestamp += FRAME_US;
    } catch {
      restartVideo();
    }
  };

  /** A new iOS video stream starts with a keyframe; Android's socket asks for one. */
  const restartVideo = () => {
    closeDecoder();
    if (ios) {
      if (video) bridge.closeDeviceStream(video);
      video = undefined;
      openVideo();
    } else {
      configuring = false;
      requestKeyframe();
    }
  };

  const requestKeyframe = () => {
    if (!ios && control) bridge.sendDeviceStream(control, JSON.stringify({ type: "reset-video" }));
  };

  const retry = (kind: DeviceStreamKind, run: () => void) => {
    if (stopped || retries.has(kind)) return;
    retries.set(
      kind,
      setTimeout(() => {
        retries.delete(kind);
        run();
      }, RETRY_MS),
    );
  };

  /** Opens a stream of `kind`, whose messages go to `onData` while it's current. */
  const open = (
    kind: DeviceStreamKind,
    onData: (data: Uint8Array | string, current: () => boolean) => void,
    onEnd: (error?: string) => void,
  ) => {
    const session = generation;
    // Unique across reloads too, so a late close for a stream from before one never meets it.
    const id = `${kind}:${deviceId}:${crypto.randomUUID()}`;
    const current = () =>
      !stopped && session === generation && (kind === "video" ? video : control) === id;
    if (kind === "video") video = id;
    else control = id;
    void bridge
      .openDeviceStream(hostId, { streamId: id, deviceId, platform, kind }, (message) => {
        if (!current()) return;
        if (message.type === "data") onData(message.data, current);
        else onEnd(message.error);
      })
      .then((error) => {
        if (error && current()) onEnd(error);
      });
    return id;
  };

  const openVideo = () => {
    const demuxer = new AvccDemuxer();
    decoded = false;
    open(
      "video",
      (data, current) => {
        if (typeof data === "string") return;
        for (const chunk of demuxer.push(data)) {
          if (chunk.type === "seed") {
            // A still of the screen, until the first decoded frame.
            void createImageBitmap(new Blob([chunk.payload as BlobPart], { type: "image/jpeg" }))
              .then((bitmap) => {
                if (current() && !decoded) paint(bitmap, bitmap.width, bitmap.height);
                bitmap.close();
              })
              .catch(() => {});
          } else if (chunk.type === "description") {
            awaitingKey = true;
            void configure({ codec: avcCodec(chunk.payload), description: chunk.payload }, current);
          } else decode(chunk.type === "keyframe", chunk.payload);
        }
      },
      (error) => {
        video = undefined;
        closeDecoder();
        connecting(error);
        retry("video", openVideo);
      },
    );
  };

  const openIosControl = () => {
    admitted = false;
    open(
      "control",
      (data) => {
        if (typeof data === "string" || data.length < 1) return;
        if (data[0] === IOS_ADMITTED) {
          admitted = true;
          return events.onInput(true);
        }
        if (data[0] !== IOS_SCREEN) return;
        try {
          const config = JSON.parse(decoder.decode(data.subarray(1))) as DeviceScreen & {
            inputUnavailable?: boolean;
            supportsHingeAngle?: boolean;
            screenId?: number;
            hingeAngle?: number;
          };
          if (config.inputUnavailable) events.onInput(false);
          screen = { width: config.width, height: config.height, orientation: config.orientation };
          if (config.supportsHingeAngle && config.screenId !== undefined)
            screen.fold = {
              display: config.screenId,
              angle: config.hingeAngle ?? (config.screenId === 1 ? 0 : 180),
            };
          events.onScreen(screen);
        } catch {}
      },
      () => {
        control = undefined;
        admitted = false;
        events.onInput(false);
        retry("control", openIosControl);
      },
    );
  };

  const openAndroid = () => {
    configuring = false;
    connecting();
    open(
      "control",
      (data, current) => {
        if (typeof data === "string") {
          // The encoder restarts at the new size when the device rotates.
          if (data.includes('"video-session"')) {
            closeDecoder();
            configuring = false;
            requestKeyframe();
          }
          return;
        }
        events.onInput(true);
        const packet = parseSemu(data);
        const ready = videoDecoder?.state === "configured";
        const scanned =
          packet.key === null || (packet.key && !ready) ? scanAccessUnit(packet.data) : null;
        const key = packet.key ?? scanned?.key ?? false;
        if (scanned?.sps && !ready) {
          if (configuring) return;
          configuring = true;
          const epoch = decoderEpoch;
          void configure({ codec: avcCodec(scanned.sps) }, current).then((configured) => {
            if (!current() || epoch !== decoderEpoch) return;
            configuring = false;
            awaitingKey = true;
            if (configured) requestKeyframe();
          });
          return;
        }
        if (!ready) {
          if (!key) requestKeyframe();
          return;
        }
        decode(key, packet.data, packet.timestamp);
      },
      (error) => {
        control = undefined;
        closeDecoder();
        events.onInput(false);
        connecting(error);
        retry("control", openAndroid);
      },
    );
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    generation++;
    if (!("VideoDecoder" in globalThis)) {
      return fail("This window can't decode video.");
    }
    connecting();
    if (ios) {
      openIosControl();
      openVideo();
    } else openAndroid();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    clearTimeout(frameTimer);
    frameTimer = undefined;
    for (const timer of retries.values()) clearTimeout(timer);
    retries.clear();
    for (const id of [video, control]) if (id) bridge.closeDeviceStream(id);
    video = control = undefined;
    closeDecoder();
  };

  const send = (data: Uint8Array | string) => {
    if (!stopped && control && (!ios || admitted)) bridge.sendDeviceStream(control, data);
  };

  /** serve-sim streams the raw framebuffer, so a turned simulator's touches turn back to it. */
  const raw = (x: number, y: number) => {
    if (!ios || !screen || screen.width > screen.height) return { x, y };
    switch (screen.orientation) {
      case "landscape_left":
        return { x: y, y: 1 - x };
      case "landscape_right":
        return { x: 1 - y, y: x };
      case "portrait_upside_down":
        return { x: 1 - x, y: 1 - y };
      default:
        return { x, y };
    }
  };

  // The hub answers each hinge command by its id; the next screen it reports shows the fold.
  let hinge = 0;
  const hidKey = (usage: number, type: "down" | "up") => send(tagged(IOS_KEY, { type, usage }));

  return {
    start,
    stop,
    touchRaw(phase, x, y) {
      if (ios) return send(tagged(IOS_TOUCH, { type: phase, x, y }));
      const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
      send(JSON.stringify({ type: "touch", action, x, y }));
    },
    touch(phase, x, y) {
      if (ios) return send(tagged(IOS_TOUCH, { type: phase, ...raw(x, y) }));
      const action = phase === "begin" ? "down" : phase === "move" ? "move" : "up";
      send(JSON.stringify({ type: "touch", action, x, y }));
    },
    key(event, phase) {
      if (ios) {
        const usage = hidUsage(event.code);
        if (usage !== null) hidKey(usage, phase);
        return;
      }
      if (phase !== "down") return;
      if (event.key === "Escape") return send(JSON.stringify({ type: "back" }));
      const keycode = ANDROID_KEYCODES[event.key];
      if (keycode !== undefined) return send(JSON.stringify({ type: "key", keycode }));
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey)
        send(JSON.stringify({ type: "text", text: event.key }));
    },
    text(text) {
      if (ios) {
        for (const char of text.slice(0, IOS_TEXT_CHARS)) {
          const key = keyFor(char);
          if (!key) continue;
          if (key.shift) hidKey(0xe1, "down");
          hidKey(key.usage, "down");
          hidKey(key.usage, "up");
          if (key.shift) hidKey(0xe1, "up");
        }
        return;
      }
      let chunk = "";
      let bytes = 0;
      for (const char of text) {
        const size = encoder.encode(char).length;
        if (bytes + size > ANDROID_TEXT_BYTES) {
          send(JSON.stringify({ type: "text", text: chunk }));
          chunk = "";
          bytes = 0;
        }
        chunk += char;
        bytes += size;
      }
      if (chunk) send(JSON.stringify({ type: "text", text: chunk }));
    },
    button(button) {
      if (ios) {
        const name = IOS_BUTTONS[button];
        if (name) send(tagged(IOS_BUTTON, { button: name }));
        return;
      }
      send(JSON.stringify({ type: button === "appSwitcher" ? "recents" : button }));
    },
    rotate() {
      if (!ios) return;
      const current = screen?.orientation ?? "portrait";
      const next = ORIENTATIONS[(ORIENTATIONS.indexOf(current) + 1) % ORIENTATIONS.length];
      send(tagged(IOS_ORIENTATION, { orientation: next }));
    },
    orient(orientation) {
      if (ios) send(tagged(IOS_ORIENTATION, { orientation }));
    },
    fold(pose) {
      if (ios && screen?.fold)
        send(tagged(IOS_HINGE, { requestId: ++hinge, command: { control: "pose", value: pose } }));
    },
  };
}
