import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { boundsInsideWorkArea, decorationProblem } from '../src/nativeCapture.ts';

const gray: [number, number, number] = [30, 30, 30];

function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = paint(x, y);
      const index = row + 1 + x * 3;
      raw[index] = red;
      raw[index + 1] = green;
      raw[index + 2] = blue;
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', header(width, height)), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function pngRgba(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [red, green, blue, alpha] = paint(x, y);
      const index = row + 1 + x * 4;
      raw[index] = red;
      raw[index + 1] = green;
      raw[index + 2] = blue;
      raw[index + 3] = alpha;
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 2;
  return data;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
}

function captionGlyph(x: number, y: number, starts: readonly number[]): boolean {
  return y >= 8 && y <= 18 && starts.some((start) => x >= start && x <= start + 8);
}

function fill(color: [number, number, number]): (x: number, y: number) => [number, number, number] {
  return () => color;
}

test('a flat window has no native decorations', () => {
  const image = png(200, 100, fill(gray));
  assert.match(decorationProblem(image, 'darwin') ?? '', /traffic lights/);
  assert.match(decorationProblem(image, 'win32') ?? '', /caption buttons/);
});

test('macOS traffic lights are the colored controls at the top left', () => {
  const image = png(200, 100, (x, y) => {
    if (y >= 4 && y <= 14 && x >= 8 && x <= 16) {
      return [210, 50, 45];
    }
    if (y >= 4 && y <= 14 && x >= 20 && x <= 28) {
      return [220, 180, 40];
    }
    if (y >= 4 && y <= 14 && x >= 32 && x <= 40) {
      return [40, 180, 60];
    }
    return gray;
  });
  assert.equal(decorationProblem(image, 'darwin'), undefined);
  assert.match(decorationProblem(image, 'win32') ?? '', /caption buttons/);
});

test('Windows caption buttons are the contrasting controls at the top right', () => {
  const image = png(400, 120, (x, y) => (captionGlyph(x, y, [330, 360, 390]) ? [236, 236, 236] : gray));
  assert.equal(decorationProblem(image, 'win32'), undefined);
  assert.match(decorationProblem(image, 'darwin') ?? '', /traffic lights/);
});

test('a hole inside one icon does not count as another caption button', () => {
  const image = png(400, 120, (x, y) => {
    const splitClose = y >= 8 && y <= 18 && x >= 390 && x <= 398 && !(x >= 393 && x <= 395);
    return captionGlyph(x, y, [330, 360]) || splitClose ? [236, 236, 236] : gray;
  });
  assert.equal(decorationProblem(image, 'win32'), undefined);
});

test('one caption mark is not minimize, maximize, and close', () => {
  const image = png(400, 120, (x, y) => (captionGlyph(x, y, [390]) ? [236, 236, 236] : gray));
  assert.match(decorationProblem(image, 'win32') ?? '', /three separate caption buttons/);
});

test('minimize and maximize without close are not the three caption buttons', () => {
  const image = png(400, 120, (x, y) => (captionGlyph(x, y, [330, 360]) ? [236, 236, 236] : gray));
  assert.match(decorationProblem(image, 'win32') ?? '', /three separate caption buttons/);
});

test('caption buttons still count when the desktop shows through the frame', () => {
  const image = png(400, 120, (x, y) => {
    if (x >= 396) {
      return [180, 40, 90];
    }
    return captionGlyph(x, y, [260, 300, 340]) ? [236, 236, 236] : gray;
  });
  assert.equal(decorationProblem(image, 'win32'), undefined);
});

test('the desktop strip is not the close button', () => {
  const image = png(400, 120, (x, y) => {
    if (x >= 396) {
      return [180, 40, 90];
    }
    return captionGlyph(x, y, [300, 340]) ? [236, 236, 236] : gray;
  });
  assert.match(decorationProblem(image, 'win32') ?? '', /three separate caption buttons/);
});

test('a mark to the left of minimize is not one of the three caption buttons', () => {
  const image = png(400, 120, (x, y) => (captionGlyph(x, y, [250, 300, 340, 380]) ? [236, 236, 236] : gray));
  assert.equal(decorationProblem(image, 'win32'), undefined);
});

test('a transparent strip on the right is a clipped window', () => {
  const image = pngRgba(420, 120, (x, y) => {
    if (x >= 400) {
      return [0, 0, 0, 0];
    }
    const glyph = captionGlyph(x, y, [330, 360, 390]);
    return glyph ? [236, 236, 236, 255] : [gray[0], gray[1], gray[2], 255];
  });
  assert.match(decorationProblem(image, 'win32') ?? '', /right edge/);
});

test('a window that hangs off the work area is moved inside it', () => {
  assert.deepEqual(boundsInsideWorkArea({ x: 48, y: 48, width: 1040, height: 648 }, { x: 0, y: 0, width: 1024, height: 768 }), {
    x: 8,
    y: 48,
    width: 1008,
    height: 648,
  });
});

test('color in the content area is not a decoration', () => {
  const image = png(200, 100, (x, y) => (x > 70 && x < 130 && y > 40 && y < 70 ? [210, 50, 45] : gray));
  assert.match(decorationProblem(image, 'darwin') ?? '', /content is not empty/);
});
