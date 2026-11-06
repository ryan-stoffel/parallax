import { expect, test } from "vite-plus/test";

import { project, unproject } from "./deviceSpace";

test("a point on a turned device comes back where it was clicked", () => {
  for (const turn of [
    { pitch: 0, yaw: 0, roll: 0 },
    { pitch: 25, yaw: -40, roll: 0 },
    { pitch: -50, yaw: 70, roll: 90 },
    { pitch: 10, yaw: 160, roll: -90 },
  ]) {
    for (const [u, v] of [
      [0, 0],
      [120, -300],
      [-90, 410],
    ] as const) {
      const [x, y] = project(turn, 1800, u, v);
      const back = unproject(turn, 1800, x, y)!;
      expect(back[0]).toBeCloseTo(u, 6);
      expect(back[1]).toBeCloseTo(v, 6);
    }
  }
});
