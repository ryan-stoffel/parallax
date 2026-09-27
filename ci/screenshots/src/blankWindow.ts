import type { ElectronApplication, Page } from 'playwright-core';

/** Chrome that must not exist in the document. A hidden node still counts. */
export const removedChrome = [
  '.part',
  '.part.titlebar',
  '.part.activitybar',
  '.part.sidebar',
  '.part.panel',
  '.part.auxiliarybar',
  '.part.statusbar',
  '.part.editor',
  '.tabs-container',
  '.command-center',
  '.editor-group-watermark',
  '.monaco-parts-splash',
  '.welcome',
  'textarea',
  'h1',
  'h2',
] as const;

interface NativeWindowHandle {
  getNativeWindowHandle(): { length: number };
}

/**
 * A plain launch shows the sidebar and an empty main area. Workbench parts,
 * tabs, the status bar, the editor, and the sessions UI are absent. Native
 * window controls belong to the operating system.
 */
export async function assertBlankWindow(app: ElectronApplication, window: Page): Promise<void> {
  const shell = window.locator('.monaco-workbench');
  await shell.waitFor({ state: 'visible' });

  const box = await shell.boundingBox();
  const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (box === null || box.width < viewport.width - 2 || box.height < viewport.height - 2) {
    throw new Error(
      `the empty window is not visible (${JSON.stringify(box)} in ${String(viewport.width)}x${String(viewport.height)})`,
    );
  }

  for (const selector of removedChrome) {
    const count = await window.locator(selector).count();
    if (count !== 0) {
      throw new Error(`${selector} is still in the document (${String(count)})`);
    }
  }

  const text = (await shell.innerText()).replace(/\s+/g, ' ').trim();
  if (text !== 'Wisp New Chat Projects Threads Settled (0)') {
    throw new Error(`the sidebar text is ${JSON.stringify(text.slice(0, 200))}`);
  }

  const lists = await window.locator('[data-wisp-section-list]').count();
  const items = await window.locator('[data-wisp-section-list] > *').count();
  if (lists !== 3 || items !== 0) {
    throw new Error(`the sidebar lists are not empty (${String(lists)} lists, ${String(items)} rows)`);
  }

  const colors = await window.evaluate(() => {
    const sidebar = document.querySelector('.wisp-sidebar');
    const main = document.querySelector('.wisp-main');
    return {
      sidebar: sidebar ? getComputedStyle(sidebar).backgroundColor : '',
      main: main ? getComputedStyle(main).backgroundColor : '',
    };
  });
  const dark = colors.sidebar === 'rgb(0, 0, 0)' && colors.main === 'rgb(10, 10, 10)';
  const light = colors.sidebar === 'rgb(255, 255, 255)' && colors.main === 'rgb(253, 253, 253)';
  if (!dark && !light) {
    throw new Error(`the sidebar is ${colors.sidebar} and the main area is ${colors.main}`);
  }

  const browserWindow = await app.browserWindow(window);
  const handleBytes = await browserWindow.evaluate(
    (win: NativeWindowHandle) => win.getNativeWindowHandle().length,
  );
  if (handleBytes < 4) {
    throw new Error('the page is not hosted in a native window');
  }
}
