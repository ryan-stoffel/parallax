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
  getTitle(): string;
  getContentSize(): [number, number];
  getSize(): [number, number];
}

/**
 * A plain launch is a visible empty window: the shell fills the viewport, and
 * the title bar, traffic lights, sidebar, and the rest of the chrome are absent.
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
  const native = await browserWindow.evaluate((win: NativeWindowHandle) => {
    const [contentWidth, contentHeight] = win.getContentSize();
    const [width, height] = win.getSize();
    return { title: win.getTitle(), contentWidth, contentHeight, width, height };
  });
  if (native.title.trim().length > 0) {
    throw new Error(`the native title bar still shows ${JSON.stringify(native.title)}`);
  }
  const extraHeight = native.height - native.contentHeight;
  const extraWidth = native.width - native.contentWidth;
  if (extraHeight > 8 || extraWidth > 8) {
    throw new Error(
      `a native title bar or frame is outside the content (${String(native.width)}x${String(native.height)} window, ${String(native.contentWidth)}x${String(native.contentHeight)} content)`,
    );
  }
}
