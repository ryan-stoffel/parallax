import { forceAppearance, type Appearance } from './appearance.ts';
import { assertBlankWindow } from './blankWindow.ts';
import type { Scenario } from './harness.ts';
import { captureNativeWindow } from './nativeCapture.ts';

function blankWindow(appearance: Appearance): Scenario {
  const name = appearance === 'dark' ? 'startup-dark' : 'startup-light';
  const title = appearance === 'dark' ? 'Blank window, dark' : 'Blank window, light';
  return {
    name,
    title,
    async run({ app, window }) {
      await assertBlankWindow(app, window);
      await forceAppearance(app, window, appearance);
      return captureNativeWindow(app, window);
    },
  };
}

export const scenarios: readonly Scenario[] = [
  blankWindow('dark'),
  blankWindow('light'),
];
