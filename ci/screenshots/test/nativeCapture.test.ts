import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { decorationProblem } from '../src/nativeCapture.ts';

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
  const image = png(200, 100, (x, y) => (y >= 4 && y <= 14 && x >= 168 && x <= 190 ? [236, 236, 236] : gray));
  assert.equal(decorationProblem(image, 'win32'), undefined);
  assert.match(decorationProblem(image, 'darwin') ?? '', /traffic lights/);
});

test('color in the content area is not a decoration', () => {
  const image = png(200, 100, (x, y) => (x > 70 && x < 130 && y > 40 && y < 70 ? [210, 50, 45] : gray));
  assert.match(decorationProblem(image, 'darwin') ?? '', /content is not empty/);
});
