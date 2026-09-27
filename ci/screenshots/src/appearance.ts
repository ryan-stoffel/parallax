import type { ElectronApplication, Page } from 'playwright-core';

export type Appearance = 'dark' | 'light';

export interface AppearanceColors {
  sidebar: string;
  main: string;
}

/** Computed colors of the sidebar and the main area. */
export function appearanceColors(appearance: Appearance): AppearanceColors {
  return appearance === 'dark'
    ? { sidebar: 'rgb(0, 0, 0)', main: 'rgb(10, 10, 10)' }
    : { sidebar: 'rgb(255, 255, 255)', main: 'rgb(253, 253, 253)' };
}

function accepted(color: string): Set<string> {
  return new Set([color, color.replace('rgb(', 'rgba(').replace(')', ', 1)')]);
}

/**
 * Points Electron at one appearance and waits until the sidebar and the main
 * area are that pair of colors. `nativeTheme.themeSource` is what the OS
 * theme uses, so the same path runs on macOS and Windows.
 */
export async function forceAppearance(app: ElectronApplication, window: Page, appearance: Appearance): Promise<void> {
  await app.evaluate((electron: { nativeTheme: { themeSource: string } }, source: Appearance) => {
    electron.nativeTheme.themeSource = source;
  }, appearance);
  const expected = appearanceColors(appearance);
  await window.waitForFunction((colors: AppearanceColors) => {
    const sidebar = document.querySelector('.wisp-sidebar');
    const main = document.querySelector('.wisp-main');
    if (!(sidebar instanceof HTMLElement) || !(main instanceof HTMLElement)) {
      return false;
    }
    const sidebarOk = new Set([colors.sidebar, colors.sidebar.replace('rgb(', 'rgba(').replace(')', ', 1)')]);
    const mainOk = new Set([colors.main, colors.main.replace('rgb(', 'rgba(').replace(')', ', 1)')]);
    return sidebarOk.has(getComputedStyle(sidebar).backgroundColor) && mainOk.has(getComputedStyle(main).backgroundColor);
  }, expected);
  const actual = await window.evaluate(() => {
    const sidebar = document.querySelector('.wisp-sidebar');
    const main = document.querySelector('.wisp-main');
    return {
      sidebar: sidebar ? getComputedStyle(sidebar).backgroundColor : '',
      main: main ? getComputedStyle(main).backgroundColor : '',
    };
  });
  if (!accepted(expected.sidebar).has(actual.sidebar) || !accepted(expected.main).has(actual.main)) {
    throw new Error(`the sidebar is ${actual.sidebar} and the main area is ${actual.main}`);
  }
}
