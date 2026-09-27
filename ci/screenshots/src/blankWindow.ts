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
 * A plain launch is a visible empty window. The shell fills the viewport, and
 * the in-page title bar, sidebar, tabs, status bar, editor, and sessions UI
 * are absent. Native window controls belong to the operating system.
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
  if (text.length > 0) {
    throw new Error(`the window is not blank: ${JSON.stringify(text.slice(0, 200))}`);
  }

  const browserWindow = await app.browserWindow(window);
  const handleBytes = await browserWindow.evaluate(
    (win: NativeWindowHandle) => win.getNativeWindowHandle().length,
  );
  if (handleBytes < 4) {
    throw new Error('the page is not hosted in a native window');
  }
}
