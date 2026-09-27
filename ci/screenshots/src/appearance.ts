import type { ElectronApplication, Page } from 'playwright-core';

export type Appearance = 'dark' | 'light';

/** Computed color of a pure black or pure white shell. */
export function shellColor(appearance: Appearance): string {
  return appearance === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)';
}

function matches(actual: string, expected: string): boolean {
  return actual === expected || actual === expected.replace('rgb(', 'rgba(').replace(')', ', 1)');
}

/**
 * Points Electron at one appearance and waits until the shell, page, and
 * document background are that pure color. `nativeTheme.themeSource` is what
 * the OS theme uses, so the same path runs on macOS and Windows.
 */
export async function forceAppearance(app: ElectronApplication, window: Page, appearance: Appearance): Promise<void> {
  await app.evaluate((electron: { nativeTheme: { themeSource: string } }, source: Appearance) => {
    electron.nativeTheme.themeSource = source;
  }, appearance);
  const expected = shellColor(appearance);
  await window.waitForFunction((color) => {
    const shell = document.querySelector('.monaco-workbench');
    if (!(shell instanceof HTMLElement)) {
      return false;
    }
    const accepted = new Set([color, color.replace('rgb(', 'rgba(').replace(')', ', 1)')]);
    const same = (node: Element) => accepted.has(getComputedStyle(node).backgroundColor);
    return same(shell) && same(document.body) && same(document.documentElement);
  }, expected);
  const actual = await window.evaluate(() => {
    const shell = document.querySelector('.monaco-workbench');
    return shell ? getComputedStyle(shell).backgroundColor : '';
  });
  if (!matches(actual, expected)) {
    throw new Error(`the window background is ${actual}, not ${expected}`);
  }
}
