import type { Page } from 'playwright-core';

/**
 * The hide/show control and the section headers change the sidebar. Search,
 * New Chat, the project plus, and the footer icons do not.
 */
export async function exerciseSidebar(window: Page): Promise<void> {
  const before = await labels(window);
  await window.locator('[data-wisp-search]').fill('nothing matches');
  await window.locator('[data-wisp-new-chat]').click();
  await window.locator('[data-wisp-plus]').click();
  for (const name of ['Profile', 'Settings', 'Usage', 'Updates']) {
    await window.locator(`[data-wisp-footer="${name}"]`).click();
  }
  if ((await labels(window)) !== before || (await window.locator('[data-wisp-section-list] > *').count()) !== 0) {
    throw new Error('search, New Chat, the project plus, or a footer icon changed the sidebar');
  }
  await window.locator('[data-wisp-search]').fill('');

  await expectChevron(window, 'projects', 'down');
  await window.locator('[data-wisp-section="projects"] [data-wisp-section-toggle]').click();
  await expectChevron(window, 'projects', 'right');
  await window.locator('[data-wisp-section="projects"] [data-wisp-section-toggle]').click();
  await expectChevron(window, 'projects', 'down');

  await window.locator('[data-wisp-section="threads"] [data-wisp-section-toggle]').click();
  await expectChevron(window, 'threads', 'right');
  await window.locator('[data-wisp-section="threads"] [data-wisp-section-toggle]').click();
  await expectChevron(window, 'threads', 'down');

  await expectChevron(window, 'settled', 'up');
  await window.locator('[data-wisp-section="settled"] [data-wisp-section-toggle]').click();
  await expectChevron(window, 'settled', 'right');
  await window.locator('[data-wisp-section="settled"] [data-wisp-section-toggle]').click();
  await expectChevron(window, 'settled', 'up');

  const toggle = window.locator('[data-wisp-sidebar-toggle]');
  const name = window.locator('[data-wisp-app-name]');
  await toggle.click();
  if (await name.isVisible()) {
    throw new Error('closing the sidebar left the app name visible');
  }
  if (!(await toggle.isVisible())) {
    throw new Error('closing the sidebar hid the sidebar button');
  }
  await toggle.click();
  await name.waitFor({ state: 'visible' });
}

async function labels(window: Page): Promise<string> {
  return (await window.locator('.monaco-workbench').innerText()).replace(/\s+/g, ' ').trim();
}

async function expectChevron(window: Page, section: string, direction: string): Promise<void> {
  const root = window.locator(`[data-wisp-section="${section}"]`);
  const actual = await root.getAttribute('data-chevron');
  const hidden = await root.locator('[data-wisp-section-list]').evaluate((node) => node.hasAttribute('hidden'));
  if (actual !== direction || hidden !== (direction === 'right')) {
    throw new Error(`${section} is ${actual ?? 'unset'} and the list is ${hidden ? 'hidden' : 'shown'}`);
  }
}
