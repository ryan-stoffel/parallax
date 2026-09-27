import { forceAppearance, type Appearance } from './appearance.ts';
import { assertBlankWindow } from './blankWindow.ts';
import type { Scenario } from './harness.ts';
import { captureNativeWindow } from './nativeCapture.ts';
import { exerciseSidebar } from './sidebar.ts';

function sidebar(appearance: Appearance): Scenario {
  const name = appearance === 'dark' ? 'sidebar-dark' : 'sidebar-light';
  const title = appearance === 'dark' ? 'Sidebar, dark' : 'Sidebar, light';
  return {
    name,
    title,
    async run({ app, window }) {
      await assertBlankWindow(app, window);
      await forceAppearance(app, window, appearance);
      await exerciseSidebar(window);
      return captureNativeWindow(app, window);
    },
  };
}

export const scenarios: readonly Scenario[] = [
  sidebar('dark'),
  sidebar('light'),
];
