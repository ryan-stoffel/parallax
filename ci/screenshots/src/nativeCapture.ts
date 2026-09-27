import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import type { ElectronApplication, Page } from 'playwright-core';

const execFileAsync = promisify(execFile);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Raster {
  width: number;
  height: number;
  bpp: number;
  pixels: Uint8Array;
}

type RGB = readonly [number, number, number];

interface NativeWindow {
  show(): void;
  focus(): void;
  moveTop(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  getMediaSourceId(): string;
  getNativeWindowHandle(): { toString(encoding: 'hex'): string };
}

interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Photographs the operating system's window, including its native controls.
 * A page screenshot does not include traffic lights or caption buttons.
 */
export async function captureNativeWindow(app: ElectronApplication, window: Page): Promise<Buffer> {
  const browserWindow = await app.browserWindow(window);
  // The helper runs here, not in Electron: Playwright only sends the callback source.
  const bounds = await browserWindow.evaluate((win: NativeWindow) => win.getBounds());
  const area = await app.evaluate(
    (electron: { screen: { getDisplayMatching(rect: WorkArea): { workArea: WorkArea } } }, rect: WorkArea) =>
      electron.screen.getDisplayMatching(rect).workArea,
    bounds,
  );
  const info = await browserWindow.evaluate(
    (win: NativeWindow, next: WorkArea) => {
      win.setBounds(next);
      win.show();
      win.moveTop();
      win.focus();
      return {
        mediaSourceId: win.getMediaSourceId(),
        handleHex: win.getNativeWindowHandle().toString('hex'),
      };
    },
    boundsInsideWorkArea(bounds, area),
  );
  await delay(500);

  const png = await captureForPlatform(app.process().pid, info);
  const problem = decorationProblem(png, process.platform);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  return png;
}

async function captureForPlatform(
  pid: number | undefined,
  info: { mediaSourceId: string; handleHex: string },
): Promise<Buffer> {
  if (process.platform === 'darwin') {
    if (pid === undefined) {
      throw new Error('the app process has no pid');
    }
    return captureDarwin(pid, info.mediaSourceId);
  }
  if (process.platform === 'win32') {
    return captureWin32(info.handleHex);
  }
  throw new Error(`native window decorations cannot be captured on ${process.platform}`);
}

/**
 * The capture shows the empty window plus the platform's own controls:
 * colored traffic lights at the top left on macOS, caption buttons at the
 * top right on Windows. Anything else in the content area fails the check.
 */
export function decorationProblem(png: Buffer, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'darwin' && platform !== 'win32') {
    return `native decorations cannot be checked on ${platform}`;
  }
  let raster: Raster;
  try {
    raster = decodePng(png);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `the native window capture is not a readable PNG (${message})`;
  }
  if (raster.width < 64 || raster.height < 32) {
    return `the native window capture is ${String(raster.width)}x${String(raster.height)}`;
  }

  const center = at(raster, Math.floor(raster.width / 2), Math.floor(raster.height / 2));
  const content = contentNoise(raster, center);
  if (content > 0.05) {
    return `the window content is not empty (${String(Math.round(content * 100))} percent of the center differs)`;
  }

  const band = Math.min(raster.height, Math.max(20, Math.floor(raster.height * 0.12)));
  const inset = 3;
  if (platform === 'darwin') {
    const colored = count(
      raster,
      inset,
      inset,
      Math.floor(raster.width * 0.22),
      band,
      (rgb) => chroma(rgb) > 28 && channelDelta(rgb, center) > 24,
    );
    if (colored < 24) {
      return `the native window capture has no traffic lights in the top left (${String(colored)} colored pixels, image ${String(raster.width)}x${String(raster.height)})`;
    }
    return undefined;
  }

  const transparent = trailingTransparentColumns(raster);
  if (transparent > 0) {
    return `the right edge of the native window capture is transparent (${String(transparent)} columns, image ${String(raster.width)}x${String(raster.height)})`;
  }
  const glyphs = captionGlyphs(raster, center, inset, band);
  if (glyphs !== 3) {
    return `the native window capture does not show minimize, maximize, and close as three separate caption buttons (${String(glyphs)} glyphs, image ${String(raster.width)}x${String(raster.height)})`;
  }
  return undefined;
}

/** Shrink and move a window so its whole frame, including the caption buttons, stays inside the work area. */
export function boundsInsideWorkArea(bounds: WorkArea, area: WorkArea): WorkArea {
  const margin = 8;
  const roomWidth = Math.max(64, area.width - margin * 2);
  const roomHeight = Math.max(32, area.height - margin * 2);
  const width = Math.min(bounds.width, roomWidth);
  const height = Math.min(bounds.height, roomHeight);
  let x = Math.max(bounds.x, area.x + margin);
  let y = Math.max(bounds.y, area.y + margin);
  const right = area.x + area.width - margin;
  const bottom = area.y + area.height - margin;
  if (x + width > right) {
    x = right - width;
  }
  if (y + height > bottom) {
    y = bottom - height;
  }
  return { x, y, width, height };
}

async function captureDarwin(pid: number, mediaSourceId: string): Promise<Buffer> {
  const ids: string[] = [];
  const notes: string[] = [];
  const fromMedia = /^window:(\d+):/.exec(mediaSourceId);
  if (fromMedia?.[1] !== undefined) {
    ids.push(fromMedia[1]);
  } else {
    notes.push(`media source id ${JSON.stringify(mediaSourceId)} has no window id`);
  }
  try {
    const fromPid = await windowIdForPid(pid);
    if (!ids.includes(fromPid)) {
      ids.push(fromPid);
    }
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error));
  }
  if (ids.length === 0) {
    throw new Error(`no macOS window id (${notes.join('; ')})`);
  }

  let lastProblem = 'native window capture produced no image';
  for (const id of ids) {
    try {
      const png = await screencapture(id);
      const problem = decorationProblem(png, 'darwin');
      if (problem === undefined) {
        return png;
      }
      lastProblem = problem;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
  }
  const detail = notes.length > 0 ? ` (${notes.join('; ')})` : '';
  throw new Error(`${lastProblem}${detail}`);
}

async function screencapture(windowId: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'wisp-window-'));
  const file = join(dir, 'window.png');
  try {
    await execFileAsync('screencapture', ['-x', '-o', '-l', windowId, file]);
    const png = await readFile(file);
    if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error(`screencapture did not write a PNG for window ${windowId}`);
    }
    return png;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if (stderr) {
      throw new Error(`screencapture failed for window ${windowId}: ${stderr}`, { cause: error });
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function windowIdForPid(pid: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wisp-window-id-'));
  const source = join(dir, 'main.swift');
  const binary = join(dir, 'window-id');
  try {
    await writeFile(source, swiftWindowId);
    await execFileAsync('swiftc', ['-O', '-o', binary, source]);
    const { stdout } = await execFileAsync(binary, [String(pid)], { encoding: 'utf8' });
    const id = stdout.trim();
    if (!/^\d+$/.test(id)) {
      throw new Error(`window id for pid ${String(pid)} was ${JSON.stringify(stdout.trim())}`);
    }
    return id;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr !== undefined && stderr.length > 0 ? stderr : message;
    throw new Error(`could not find a window for pid ${String(pid)}: ${detail}`, { cause: error });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const swiftWindowId = `import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
  fputs("usage: window-id <pid>\\n", stderr)
  exit(2)
}
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktop], kCGNullWindowID) as? [[String: Any]] ?? []
var bestId = 0
var bestArea = 0
for window in info {
  guard let owner = window[kCGWindowOwnerPID as String] as? Int32, owner == pid else { continue }
  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  if layer != 0 { continue }
  guard let number = window[kCGWindowNumber as String] as? Int else { continue }
  let bounds = window[kCGWindowBounds as String] as? [String: Any]
  let width = bounds?["Width"] as? Double ?? 0
  let height = bounds?["Height"] as? Double ?? 0
  let area = Int(width * height)
  if area > bestArea {
    bestArea = area
    bestId = number
  }
}
if bestId == 0 {
  fputs("no on-screen window for pid \\(pid)\\n", stderr)
  exit(1)
}
print(bestId)
`;

async function captureWin32(handleHex: string): Promise<Buffer> {
  if (!/^[0-9a-fA-F]+$/.test(handleHex) || handleHex.length < 8 || handleHex.length % 2 !== 0) {
    throw new Error('the native window handle is not a hex HWND');
  }
  const dir = await mkdtemp(join(tmpdir(), 'wisp-window-'));
  const script = join(dir, 'capture.ps1');
  const file = join(dir, 'window.png');
  try {
    await writeFile(script, powershellCapture);
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-HandleHex', handleHex, '-Out', file],
      { windowsHide: true },
    );
    const png = await readFile(file);
    if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('Windows window capture did not write a PNG');
    }
    return png;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if (stderr) {
      throw new Error(`Windows window capture failed: ${stderr}`, { cause: error });
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const powershellCapture = `param(
  [Parameter(Mandatory = $true)][string]$HandleHex,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct WispRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class WispCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out WispRect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out WispRect pvAttribute, int cbAttribute);
}
"@
$bytes = New-Object byte[] 8
$pairs = [Math]::Min(8, [Math]::Floor($HandleHex.Length / 2))
for ($i = 0; $i -lt $pairs; $i++) {
  $bytes[$i] = [Convert]::ToByte($HandleHex.Substring($i * 2, 2), 16)
}
$ptr = [IntPtr]::new([System.BitConverter]::ToInt64($bytes, 0))
if (-not [WispCap]::IsWindow($ptr)) { throw "hwnd is not a window" }
[WispCap]::ShowWindow($ptr, 9) | Out-Null
[WispCap]::SetForegroundWindow($ptr) | Out-Null
Start-Sleep -Milliseconds 400
$rect = New-Object WispRect
if (-not [WispCap]::GetWindowRect($ptr, [ref]$rect)) { throw "GetWindowRect failed" }
# The visible frame excludes the DWM shadow, whose pixels stay transparent and can hide the close button.
$visible = New-Object WispRect
$visibleSize = [Runtime.InteropServices.Marshal]::SizeOf([type][WispRect])
if ([WispCap]::DwmGetWindowAttribute($ptr, 9, [ref]$visible, $visibleSize) -eq 0) {
  $visibleWidth = $visible.Right - $visible.Left
  $visibleHeight = $visible.Bottom - $visible.Top
  if ($visibleWidth -ge 32 -and $visibleHeight -ge 32) { $rect = $visible }
}
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -lt 32 -or $h -lt 32) { throw "window rect is $w x $h" }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$graphics.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`;

function decodePng(png: Buffer): Raster {
  if (png.length < pngSignature.length || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let sawHeader = false;
  const idat: Buffer[] = [];
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length) {
      throw new Error('truncated PNG');
    }
    const data = png.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (data.length < 13) {
        throw new Error('truncated IHDR');
      }
      sawHeader = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      const interlace = data[12] ?? 1;
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(
          `unsupported PNG (bit depth ${String(bitDepth)}, color ${String(colorType)}, interlace ${String(interlace)})`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!sawHeader || idat.length === 0 || width < 1 || height < 1) {
    throw new Error('PNG is missing an image');
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const expected = (width * bpp + 1) * height;
  if (raw.length < expected) {
    throw new Error('PNG image data is short');
  }
  return { width, height, bpp, pixels: unfilter(raw, width, height, bpp) };
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const pixels = new Uint8Array(rowBytes * height);
  let previous = new Uint8Array(rowBytes);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source] ?? 0;
    source += 1;
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[source + i] ?? 0;
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
      row[i] = (x + predictor(filter, left, up, upLeft)) & 0xff;
    }
    source += rowBytes;
    previous = row;
  }
  return pixels;
}

function predictor(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`unsupported PNG filter ${String(filter)}`);
  }
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  return upDistance <= upLeftDistance ? up : upLeft;
}

function trailingTransparentColumns(raster: Raster): number {
  if (raster.bpp < 4) {
    return 0;
  }
  let columns = 0;
  for (let x = raster.width - 1; x >= 0; x -= 1) {
    let columnTransparent = true;
    for (let y = 0; y < raster.height; y += 1) {
      if (alphaAt(raster, x, y) !== 0) {
        columnTransparent = false;
        break;
      }
    }
    if (!columnTransparent) {
      break;
    }
    columns += 1;
  }
  return columns;
}

/** Minimize, maximize, and close are three horizontal runs of contrasting pixels in the top right. */
function captionGlyphs(raster: Raster, center: RGB, inset: number, band: number): number {
  const x0 = Math.floor(raster.width * 0.78);
  let glyphs = 0;
  let inGlyph = false;
  let pixels = 0;
  let gap = 0;
  const finish = (): void => {
    if (inGlyph && pixels >= 8) {
      glyphs += 1;
    }
    inGlyph = false;
    pixels = 0;
    gap = 0;
  };
  for (let x = x0; x < raster.width; x += 1) {
    let columnPixels = 0;
    for (let y = inset; y < band; y += 1) {
      if (alphaAt(raster, x, y) === 0) {
        continue;
      }
      if (channelDelta(at(raster, x, y), center) > 48) {
        columnPixels += 1;
      }
    }
    if (columnPixels > 0) {
      inGlyph = true;
      pixels += columnPixels;
      gap = 0;
    } else if (inGlyph) {
      gap += 1;
      if (gap >= 2) {
        finish();
      }
    }
  }
  finish();
  return glyphs;
}

function alphaAt(raster: Raster, x: number, y: number): number {
  if (raster.bpp < 4) {
    return 255;
  }
  const index = (y * raster.width + x) * raster.bpp;
  return raster.pixels[index + 3] ?? 0;
}

function at(raster: Raster, x: number, y: number): RGB {
  const index = (y * raster.width + x) * raster.bpp;
  return [raster.pixels[index] ?? 0, raster.pixels[index + 1] ?? 0, raster.pixels[index + 2] ?? 0];
}

function chroma(rgb: RGB): number {
  return Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
}

function channelDelta(left: RGB, right: RGB): number {
  return Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]));
}

function count(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  accept: (rgb: RGB) => boolean,
): number {
  let found = 0;
  const right = Math.min(raster.width, Math.max(x0, x1));
  const bottom = Math.min(raster.height, Math.max(y0, y1));
  for (let y = Math.max(0, y0); y < bottom; y++) {
    for (let x = Math.max(0, x0); x < right; x++) {
      if (accept(at(raster, x, y))) {
        found += 1;
      }
    }
  }
  return found;
}

function contentNoise(raster: Raster, center: RGB): number {
  const x0 = Math.floor(raster.width * 0.3);
  const x1 = Math.floor(raster.width * 0.7);
  const y0 = Math.floor(raster.height * 0.3);
  const y1 = Math.floor(raster.height * 0.7);
  let seen = 0;
  let different = 0;
  for (let y = y0; y < y1; y += 4) {
    for (let x = x0; x < x1; x += 4) {
      seen += 1;
      if (channelDelta(at(raster, x, y), center) > 18) {
        different += 1;
      }
    }
  }
  return seen === 0 ? 1 : different / seen;
}
