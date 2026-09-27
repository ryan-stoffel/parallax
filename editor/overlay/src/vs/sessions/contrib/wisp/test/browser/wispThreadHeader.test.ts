/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { isIMenuItem, isISubmenuItem, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Menus } from '../../../../browser/menus.js';
import { WISP_PROJECT_SESSION_TYPE } from '../../../providers/wisp/common/wispProjects.js';
import { WISP_NO_REPO_FILTER, WISP_THREAD_SESSION_TYPE } from '../../../providers/wisp/common/wispThreads.js';
import { acceptIsPrimary, changesLabel, changesStat, findThreadRun, threadHeaderCrumb, threadHeaderState, WISP_HEADER_ACCEPT, WISP_HEADER_CHANGES, WISP_HEADER_COPY_BRANCH, WISP_HEADER_IDE, WISP_HEADER_REQUEST_CHANGES, WISP_THREAD_ACCEPT_MENU } from '../../browser/wispThreadHeader.js';

suite('wisp: thread header', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the state word follows the run', () => {
		assert.deepStrictEqual(threadHeaderState('starting'), { word: 'Working', mark: 'working' });
		assert.deepStrictEqual(threadHeaderState('running'), { word: 'Working', mark: 'working' });
		assert.deepStrictEqual(threadHeaderState('completed'), { word: 'Done', mark: 'done' });
		assert.deepStrictEqual(threadHeaderState('accepted'), { word: 'Done', mark: 'done' });
		assert.deepStrictEqual(threadHeaderState('cancelled'), { word: 'Stopped', mark: 'stopped' });
		assert.deepStrictEqual(threadHeaderState('interrupted'), { word: 'Stopped', mark: 'stopped' });
		assert.deepStrictEqual(threadHeaderState('failed'), { word: "Couldn't start", mark: 'failed' });
		assert.strictEqual(threadHeaderState(undefined), undefined);
	});

	test('the crumb is the repository, No repo, or nothing for a project', () => {
		assert.deepStrictEqual(threadHeaderCrumb({ sessionType: WISP_THREAD_SESSION_TYPE, isQuickChat: false, workspaceLabel: 'wisp', workspaceKey: 'file:///src/wisp' }), {
			repository: 'wisp',
			repositoryKey: 'file:///src/wisp',
		});
		assert.deepStrictEqual(threadHeaderCrumb({ sessionType: WISP_THREAD_SESSION_TYPE, isQuickChat: true, workspaceLabel: 'scratch', workspaceKey: 'file:///scratch' }), {
			repository: 'No repo',
			repositoryKey: WISP_NO_REPO_FILTER,
		});
		assert.deepStrictEqual(threadHeaderCrumb({ sessionType: WISP_THREAD_SESSION_TYPE, isQuickChat: false, workspaceLabel: undefined, workspaceKey: undefined }), {
			repository: 'No repo',
			repositoryKey: WISP_NO_REPO_FILTER,
		});
		assert.deepStrictEqual(threadHeaderCrumb({ sessionType: WISP_PROJECT_SESSION_TYPE, isQuickChat: false, workspaceLabel: 'wisp', workspaceKey: 'file:///src/wisp' }), {
			repository: undefined,
			repositoryKey: undefined,
		});
	});

	test('Changes names the diff, and Accept is primary only when the thread is done with changes', () => {
		const diff = { commit: 'abc', files: 2, insertions: 14, deletions: 3 };
		assert.strictEqual(changesStat({ status: 'running', diff }), undefined);
		assert.strictEqual(changesStat({ status: 'completed' }), undefined);
		assert.deepStrictEqual(changesStat({ status: 'completed', diff }), { insertions: 14, deletions: 3 });
		assert.strictEqual(changesLabel(undefined), 'Changes');
		assert.strictEqual(changesLabel({ insertions: 14, deletions: 3 }), 'Changes +14 −3');
		assert.strictEqual(acceptIsPrimary({ status: 'completed', diff }), true);
		assert.strictEqual(acceptIsPrimary({ status: 'accepted', diff }), false);
		assert.strictEqual(acceptIsPrimary({ status: 'completed', diff: { ...diff, files: 0 } }), false);
		assert.strictEqual(acceptIsPrimary({ status: 'running', diff }), false);
		assert.strictEqual(acceptIsPrimary(undefined), false);
	});

	test('the header finds the thread\'s run through its repo entry', () => {
		const session = { sessionType: WISP_THREAD_SESSION_TYPE, resource: URI.from({ scheme: WISP_THREAD_SESSION_TYPE, path: '/run-1' }) };
		const run = { id: 'run-1', status: 'completed' };
		assert.strictEqual(findThreadRun(session, [{ id: 'run-1', repo: 'repo-1' }], repo => repo === 'repo-1' ? [run] : [], () => undefined), run);
		assert.strictEqual(findThreadRun({ sessionType: WISP_PROJECT_SESSION_TYPE, resource: session.resource }, [{ id: 'run-1', repo: 'repo-1' }], () => [run], () => run), undefined);
	});

	test('the session toolbar offers IDE, Changes, and an Accept split button', () => {
		const items = MenuRegistry.getMenuItems(Menus.SessionBarToolbar);
		const commands = items.filter(isIMenuItem).map(item => item.command.id);
		assert.ok(commands.includes(WISP_HEADER_IDE));
		assert.ok(commands.includes(WISP_HEADER_CHANGES));
		const accept = items.find(item => isISubmenuItem(item) && item.submenu === WISP_THREAD_ACCEPT_MENU);
		assert.ok(accept && isISubmenuItem(accept));
		assert.strictEqual(accept.isSplitButton, true);
		const menu = MenuRegistry.getMenuItems(WISP_THREAD_ACCEPT_MENU).filter(isIMenuItem).map(item => item.command.id).sort();
		assert.deepStrictEqual(menu, [WISP_HEADER_ACCEPT, WISP_HEADER_COPY_BRANCH, WISP_HEADER_REQUEST_CHANGES].sort());
	});
});
