import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeClaudeEnv } from './agents.ts';
import { assertBlankWindow } from './blankWindow.ts';
import { notAvailable, screenshot, type Scenario } from './harness.ts';

const workspace = join(import.meta.dirname, '..', 'fixtures', 'workspace');
const openFile = 'tasks.ts';

/**
 * An ssh destination nothing listens on, so ssh fails at once with "connection refused" (no
 * route). An unresolvable name can take a DNS timeout of 30 s or more, longer than the handshake.
 */
const unreachableHost = 'ssh://127.0.0.1:9';

const chromeGone = notAvailable('The boot window has no chrome, so this view is not on screen.');

export const scenarios: readonly Scenario[] = [
	{
		name: 'agents-window',
		title: 'Agents window connected to this Mac',
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'startup',
		title: 'Blank window',
		async run({ app, window }) {
			await assertBlankWindow(app, window);
			return screenshot(window);
		},
	},
	{
		name: 'editor-file-open',
		title: 'Editor with a file open',
		async args(dir) {
			const folder = join(dir, 'workspace');
			await cp(workspace, folder, { recursive: true });
			return [folder, join(folder, 'src', openFile)];
		},
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-disconnected',
		title: 'Agents window with a host it cannot reach',
		settings: { 'wisp.host': unreachableHost },
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-host-menu',
		title: 'Host menu from the sidebar footer',
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-accounts',
		title: 'Customize, Accounts, with the bundled wispd and no CLIs installed',
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-project',
		title: 'A new project in the sidebar, with its Project tab',
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-project-reopened',
		title: 'The project is still listed after quitting Wisp and wispd',
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-context',
		title: 'Shared context added, listed, and open with its host bar',
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-agents-panel',
		title: 'The Agents panel, opened from the pill above the coordinator',
		env: () => fakeClaudeEnv(),
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-subagent',
		title: 'A subagent in a tab next to the coordinator, messaged directly',
		env: () => fakeClaudeEnv(),
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-new-chat',
		title: "New Chat: upstream's new-session composer for a normal thread",
		run() {
			return Promise.resolve(chromeGone);
		},
	},
	{
		name: 'agents-window-repo-thread',
		title: 'A normal thread under its repository in Repositories',
		env: () => fakeClaudeEnv(),
		run() {
			return Promise.resolve(chromeGone);
		},
	},
];
