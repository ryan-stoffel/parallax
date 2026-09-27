import type { Page } from 'playwright-core';

/**
 * The hide/show control and the section headers change the sidebar. Search,
 * New Thread, the project plus, and the footer icons do not.
 */
export async function exerciseSidebar(window: Page): Promise<void> {
  const before = await labels(window);
  await window.locator('[data-wisp-search]').fill('nothing matches');
  await window.locator('[data-wisp-new-thread]').click();
  await window.locator('[data-wisp-plus]').click();
  for (const name of ['Profile', 'Settings', 'Usage', 'Updates']) {
    await window.locator(`[data-wisp-footer="${name}"]`).click();
  }
  if ((await labels(window)) !== before || (await window.locator('[data-wisp-section-list] > *').count()) !== 0) {
    throw new Error('search, New Thread, the project plus, or a footer icon changed the sidebar');
  }
  await window.locator('[data-wisp-search]').fill('');

  for (const section of ['projects', 'threads', 'settled']) {
    await expectChevron(window, section, 'down');
    await window.locator(`[data-wisp-section="${section}"] [data-wisp-section-toggle]`).click();
    await expectChevron(window, section, 'up');
    await window.locator(`[data-wisp-section="${section}"] [data-wisp-section-toggle]`).click();
    await expectChevron(window, section, 'down');
  }

  const toggle = window.locator('[data-wisp-sidebar-toggle]');
  const name = window.locator('[data-wisp-app-name]');
  const parked = await toggle.boundingBox();
  await toggle.click();
  await window.waitForFunction(() => {
    const sidebar = document.querySelector('.wisp-sidebar');
    const title = document.querySelector('[data-wisp-app-name]');
    if (!(sidebar instanceof HTMLElement) || !(title instanceof HTMLElement)) {
      return false;
    }
    return sidebar.getBoundingClientRect().right <= 1 && title.getBoundingClientRect().right <= 1;
  });
  const stayed = await toggle.boundingBox();
  if (parked === null || stayed === null || Math.abs(parked.x - stayed.x) > 1 || Math.abs(parked.y - stayed.y) > 1) {
    throw new Error('closing the sidebar moved the sidebar button');
  }
  if (!(await toggle.isVisible())) {
    throw new Error('closing the sidebar hid the sidebar button');
  }
  await toggle.click();
  await window.waitForFunction(() => {
    const sidebar = document.querySelector('.wisp-sidebar');
    const title = document.querySelector('[data-wisp-app-name]');
    if (!(sidebar instanceof HTMLElement) || !(title instanceof HTMLElement)) {
      return false;
    }
    return sidebar.getBoundingClientRect().left >= -1 && title.getBoundingClientRect().left > 0;
  });
  await name.waitFor({ state: 'visible' });
}

async function labels(window: Page): Promise<string> {
  return (await window.locator('.monaco-workbench').innerText()).replace(/\s+/g, ' ').trim();
}

async function expectChevron(window: Page, section: string, direction: string): Promise<void> {
  const root = window.locator(`[data-wisp-section="${section}"]`);
  const actual = await root.getAttribute('data-chevron');
  const hidden = await root.locator('[data-wisp-section-list]').evaluate((node) => node.hasAttribute('hidden'));
  if (actual !== direction || hidden !== (direction === 'up')) {
    throw new Error(`${section} is ${actual ?? 'unset'} and the list is ${hidden ? 'hidden' : 'shown'}`);
  }
}
