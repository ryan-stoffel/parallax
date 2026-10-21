// The Device panel's 3D view (PLX-886): a device turned in space as CSS draws
// `perspective(p) rotateX(pitch) rotateY(yaw) rotateZ(roll)`, and a click on its screen turned back
// into a point on that screen, so the screen stays touchable at any angle.

import type { DeviceChrome } from "../protocol/generated/protocol";

/** A device's turn, in degrees: tilted back (pitch), around (yaw), and its own orientation (roll). */
export interface Turn {
  pitch: number;
  yaw: number;
  roll: number;
}

type Vec = [number, number, number];
type Mat = [Vec, Vec, Vec];

const rad = (deg: number) => (deg * Math.PI) / 180;

/** `rotateX(pitch) rotateY(yaw) rotateZ(roll)`'s matrix, in CSS's axes (y down, z toward you). */
export function rotation({ pitch, yaw, roll }: Turn): Mat {
  const [a, b, c] = [rad(pitch), rad(yaw), rad(roll)];
  const x: Mat = [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
  const y: Mat = [
    [Math.cos(b), 0, Math.sin(b)],
    [0, 1, 0],
    [-Math.sin(b), 0, Math.cos(b)],
  ];
  const z: Mat = [
    [Math.cos(c), -Math.sin(c), 0],
    [Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
  return multiply(multiply(x, y), z);
}

function multiply(m: Mat, n: Mat): Mat {
  const row = (i: number): Vec =>
    [0, 1, 2].map((j) => m[i]![0] * n[0]![j]! + m[i]![1] * n[1]![j]! + m[i]![2] * n[2]![j]!) as Vec;
  return [row(0), row(1), row(2)];
}

const apply = (m: Mat, v: Vec): Vec =>
  [0, 1, 2].map((i) => m[i]![0] * v[0] + m[i]![1] * v[1] + m[i]![2] * v[2]) as Vec;

/** Where device point (`u`, `v`), from its center, shows: from the center of the perspective. */
export function project(turn: Turn, perspective: number, u: number, v: number): [number, number] {
  const [x, y, z] = apply(rotation(turn), [u, v, 0]);
  const scale = perspective / (perspective - z);
  return [x * scale, y * scale];
}

/**
 * The device point under view point (`x`, `y`), both from the center of the perspective: where the
 * eye's ray through it meets the device's plane. Undefined when the ray runs along the plane.
 */
export function unproject(
  turn: Turn,
  perspective: number,
  x: number,
  y: number,
): [number, number] | undefined {
  const r = rotation(turn);
  const normal: Vec = [r[0][2], r[1][2], r[2][2]];
  const eye: Vec = [0, 0, perspective];
  const ray: Vec = [x, y, -perspective];
  const facing = normal[0] * ray[0] + normal[1] * ray[1] + normal[2] * ray[2];
  if (Math.abs(facing) < 1e-6 * Math.hypot(...ray)) return undefined;
  const t = -(normal[2] * eye[2]) / facing;
  const hit: Vec = [eye[0] + t * ray[0], eye[1] + t * ray[1], eye[2] + t * ray[2]];
  // A rotation's inverse is its transpose.
  const back: Mat = [
    [r[0][0], r[1][0], r[2][0]],
    [r[0][1], r[1][1], r[2][1]],
    [r[0][2], r[1][2], r[2][2]],
  ];
  const [u, v] = apply(back, hit);
  return [u, v];
}

/**
 * A plain frame for a device with no artwork on its host: a rounded slab around a screen of
 * `aspect` (width over height), in made-up units.
 */
export function plainChrome(aspect: number, ios: boolean): DeviceChrome {
  const height = 1000;
  const width = height * aspect;
  const bezel = 22;
  return {
    width: width + bezel * 2,
    height: height + bezel * 2,
    screen: { x: bezel, y: bezel, width, height },
    cornerRadius: width * (ios ? 0.13 : 0.08),
    layers: [],
  };
}
