// Normal-thread steps for the scenarios and smoke checks of #110: New Chat opens upstream's
// new-session composer, and a first message starts a thread that wisp's sidebar lists under its
// repository in Repositories. The agent is the fake Claude Code of ./agents.ts.
import type { Page } from 'playwright-core';
import { projectName } from './projects.ts';

/** The first message the checks start a thread with, and the title its row shows. */
export const threadTask = 'Fix the flaky attach test';

/** The sidebar's New Chat action. */
export function newChatAction(window: Page) {
  return window.locator('.part.sidebar .wisp-threads-action', { hasText: 'New Chat' }).first();
}

/** Clicks New Chat once it is enabled, and waits for the empty-thread heading and composer (#298). */
export async function openNewChat(window: Page): Promise<void> {
  const action = newChatAction(window);
  await window.locator('.part.sidebar .wisp-threads-action:not(.disabled)', { hasText: 'New Chat' }).waitFor({ state: 'visible', timeout: 30_000 });
  await action.click();
  const part = sessionsPart(window);
  const heading = part.locator('h1.new-chat-empty-heading');
  await heading.waitFor({ state: 'visible', timeout: 30_000 });
  const text = (await heading.innerText()).replace(/\s+/g, ' ').trim();
  if (!/^What do you want to work on\?$/.test(text) && !/^What should we build in .+?\?$/.test(text)) {
    throw new Error(`unexpected empty-thread heading: ${JSON.stringify(text)}`);
  }
  await composer(window).waitFor({ state: 'visible', timeout: 30_000 });
  const maxWidth = await part.locator('.new-chat-widget-content').last().evaluate(el => getComputedStyle(el).maxWidth);
  if (maxWidth !== '760px') {
    throw new Error(`the composer column's max width is ${maxWidth}, not 760px`);
  }
  const editorHeight = await part.locator('.sessions-chat-editor').last().evaluate(el => el.getBoundingClientRect().height);
  if (editorHeight < 70) {
    throw new Error(`the composer is ${editorHeight}px tall, shorter than three lines`);
  }
  for (const selector of ['.new-session-workspace-picker-container', '.new-session-quick-chat-header']) {
    if (await part.locator(selector).first().isVisible()) {
      throw new Error(`${selector} is visible on the empty thread`);
    }
  }
}

/** The Agents window's main part, which holds the new-session composer. */
export function sessionsPart(window: Page) {
  return window.locator('.part.sessionspart').last();
}

/** The new-session composer's input: upstream's `NewChatInput` editor. */
export function composer(window: Page) {
  return sessionsPart(window).locator('.sessions-chat-editor .monaco-editor').last();
}

/** A thread's row under its repository in the sidebar's Repositories section. */
export function repoThreadRow(window: Page, task = threadTask, repo = projectName) {
  return window.locator(`.part.sidebar .wisp-threads-thread-section button.wisp-threads-row[aria-label^="${task}, chat in ${repo}"]`).first();
}

/**
 * Types the first message into the new-session composer and sends it. A fresh wispd has no default
 * account for agents, so it then picks Claude Code, as Start Subagent does.
 */
export async function sendFirstMessage(window: Page, text = threadTask): Promise<void> {
  await composer(window).click();
  await window.keyboard.type(text);
  await window.keyboard.press('Enter');
  const row = window.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Claude Code' }).first();
  await row.waitFor({ state: 'visible', timeout: 20_000 });
  await row.click();
}
