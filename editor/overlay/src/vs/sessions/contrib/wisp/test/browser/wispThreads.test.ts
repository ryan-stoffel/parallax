/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { WispdError, WispdUnavailableError, type WispdState } from '../../../../../platform/wisp/common/wispd.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { AgentListParams, AgentRun, Repo, RepoAddParams, Thread, ThreadStartParams } from '../../../../../platform/wisp/common/wispProtocol.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { EMPTY_THREAD_PLACEHOLDER, emptyThreadPresentation } from '../../../providers/wisp/browser/wispEmptyThread.js';
import { WispThreadSession } from '../../../providers/wisp/browser/wispThreadSession.js';
import { WISP_PROJECT_SESSION_TYPE } from '../../../providers/wisp/common/wispProjects.js';
import { agentRunOf } from '../../../providers/wisp/common/wispAgentRuns.js';
import { filterThreadPlacement, placeThreadSessions, repoPathOf, repoUri, threadChatResource, threadResource, threadRunOf, WISP_NO_REPO_FILTER, WISP_REPO_SCHEME, WISP_THREAD_SESSION_TYPE } from '../../../providers/wisp/common/wispThreads.js';
import { clearSidebarRepositoryFilter, toggleSidebarRepositoryFilter } from '../../browser/wispSidebarFilter.js';
import { WISP_BASE_DIRTY_NOTICE_ID } from '../../browser/wispStartSubagent.js';
import { WispThreadSections } from '../../browser/wispThreadSections.js';
import { agentsWindowServices, IAgentsWindowServices, settle } from './wispAgentsTestServices.js';
import { connected, SSH_COMMAND } from './wispHostTestUtils.js';

const APP: Repo = { id: '0192f0c4-0000-7000-8000-00000000a001', name: 'wisp', path: '/Users/ryan/src/wisp', createdAt: '2026-09-26T10:00:00Z' };
const SCRATCH: Repo = { id: '0192f0c4-0000-7000-8000-00000000a002', name: 'No Repo', path: '/Users/ryan/Library/Application Support/wisp/scratch', scratch: true, createdAt: '2026-09-26T10:00:00Z' };
const IN_REPO = '0192f0c4-0000-7000-8000-00000000b001';
const QUICK = '0192f0c4-0000-7000-8000-00000000b002';
const ARCHIVED = '0192f0c4-0000-7000-8000-00000000b003';

function thread(id: string, repo: Repo, options: Partial<Thread> = {}): Thread {
	return { id, repo: repo.id, createdAt: '2026-09-26T10:00:00Z', ...options };
}

function run(id: string, repo: Repo, prompt: string, options: Partial<AgentRun> = {}): AgentRun {
	return {
		id,
		project: repo.id,
		prompt,
		policy: 'workspaceWrite',
		status: 'running',
		backend: 'claude',
		accountId: 'claude',
		branch: `wisp/${id.slice(-4)}`,
		createdAt: '2026-09-26T10:00:00Z',
		updatedAt: '2026-09-26T10:00:00Z',
		...options,
	};
}

function withCapabilities(state: WispdState, capabilities: Record<string, Record<string, never>>): WispdState {
	return state.kind === 'connected' ? { ...state, capabilities } : state;
}

interface IThreadServices extends IAgentsWindowServices {
	readonly repos: Repo[];
	readonly threadList: Thread[];
	readonly runs: AgentRun[];
}

suite('wisp: threads', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => clearSidebarRepositoryFilter());

	/** Services whose wispd has the `threads` capability, two repo entries, and three threads. */
	async function services(host = 'local', withThreads = true, configure?: (instantiationService: IThreadServices['instantiationService']) => void): Promise<IThreadServices> {
		const context = agentsWindowServices(disposables, true, host, configure);
		const repos = withThreads ? [APP, SCRATCH] : [];
		const threadList = withThreads ? [
			thread(IN_REPO, APP),
			thread(QUICK, SCRATCH),
			thread(ARCHIVED, APP, { archived: true }),
		] : [];
		const runs = [
			run(IN_REPO, APP, 'Fix the flaky attach test', { updatedAt: '2026-09-26T10:05:00Z' }),
			run(QUICK, SCRATCH, 'What is a git worktree?', { status: 'completed', diff: { commit: 'c0ffee', files: 2, insertions: 3, deletions: 1 } }),
			run(ARCHIVED, APP, 'Old work', { status: 'completed' }),
		];
		context.wispd.handler = async (method, params) => {
			switch (method) {
				case 'project/list':
					return { projects: [], seq: 1 };
				case 'thread/list':
					return { repos, threads: threadList, seq: 3 };
				case 'agent/list':
					return { runs: runs.filter(candidate => candidate.project === (params as AgentListParams).project), seq: 3 };
				case 'agent/events':
					return { events: [], more: false };
				case 'agent/diff':
					return {
						base: 'ba5e', head: 'c0ffee', truncated: false, stats: { files: 2, insertions: 3, deletions: 1 },
						files: [
							{ path: 'NOTES.md', status: 'added', insertions: 2, deletions: 0 },
							{ path: 'README.md', status: 'modified', insertions: 1, deletions: 1 },
						],
					};
				case 'accounts/defaults/get':
					return { worker: { kind: 'subscription', backend: 'claude' } };
				case 'repo/add': {
					const { id, path } = params as RepoAddParams;
					return { repo: { id, name: path.split('/').pop()!, path, createdAt: '2026-09-26T11:00:00Z' } };
				}
				case 'thread/start': {
					const { runId, repo, prompt } = params as ThreadStartParams;
					const entry = repo ? { ...APP, id: repo } : SCRATCH;
					return { thread: thread(runId, entry), run: run(runId, entry, prompt, { status: 'starting' }) };
				}
				case 'thread/archive':
					return { thread: thread(IN_REPO, APP, { archived: true }) };
				case 'thread/delete':
					return {};
				case 'agent/cancel':
					return { run: run(IN_REPO, APP, 'Fix the flaky attach test', { status: 'cancelled' }) };
			}
			throw new Error(`unexpected ${method}`);
		};
		context.wispd.setState(withCapabilities(connected(host === 'local' ? undefined : SSH_COMMAND), { agents: {}, threads: {} }));
		await settle();
		return { ...context, repos, threadList, runs };
	}

	function threadSessions(context: IAgentsWindowServices): WispThreadSession[] {
		return context.provider.getSessions().filter((session): session is WispThreadSession => session.sessionType === WISP_THREAD_SESSION_TYPE);
	}

	suite('catalog', () => {

		test('resources name the thread and its run, and repositories map to workspace URIs', () => {
			assert.strictEqual(threadRunOf(threadResource(IN_REPO)), IN_REPO);
			assert.strictEqual(threadRunOf(URI.file('/x')), undefined);
			assert.deepStrictEqual(agentRunOf(threadChatResource(IN_REPO)), { projectId: 'thread', runId: IN_REPO });
			assert.strictEqual(repoUri('/src/app', true).scheme, 'file');
			assert.strictEqual(repoUri('/src/app', false).scheme, WISP_REPO_SCHEME);
			assert.strictEqual(repoPathOf(repoUri('/src/app', false), false), '/src/app');
			assert.strictEqual(repoPathOf(URI.file('/src/app'), false), undefined, 'a local folder is not a remote host\'s');
		});

		test('the provider publishes one wisp.thread session per thread, with its repo as its workspace', async () => {
			const context = await services();
			const sessions = threadSessions(context);
			assert.deepStrictEqual(sessions.map(session => [session.runId, session.title.get(), session.isQuickChat.get(), session.workspace.get()?.uri.toString(), session.isArchived.get()]), [
				[IN_REPO, 'Fix the flaky attach test', false, URI.file(APP.path).toString(), false],
				[QUICK, 'What is a git worktree?', true, undefined, false],
				[ARCHIVED, 'Old work', false, URI.file(APP.path).toString(), true],
			]);
			const [inRepo, quick] = sessions;
			assert.strictEqual(inRepo.resource.toString(), threadResource(IN_REPO).toString());
			assert.strictEqual(inRepo.mainChat.get().resource.toString(), threadChatResource(IN_REPO).toString());
			assert.strictEqual(inRepo.mainChat.get().origin, undefined, 'a thread\'s chat has no coordinator');
			assert.strictEqual(inRepo.status.get(), SessionStatus.InProgress);
			assert.strictEqual(quick.status.get(), SessionStatus.NeedsInput, 'a finished run with a commit needs review');
			assert.strictEqual(inRepo.workspace.get()?.label, 'wisp');
			assert.strictEqual(inRepo.workspace.get()?.isVirtualWorkspace, true, 'a local thread reports a virtual workspace so the title bar hides Run');
			assert.ok(inRepo.capabilities.get().supportsDelete);
			assert.deepStrictEqual(context.provider.sessionTypes.map(type => type.id), [WISP_THREAD_SESSION_TYPE]);
			assert.ok(context.provider.supportsQuickChats);
			assert.strictEqual(context.agents.getRun(IN_REPO)?.project, APP.id, 'the runs come from each repo entry\'s agent/list');
		});

		test('the Changes tab lists the files of the run\'s latest commit, from agent/diff', async () => {
			const context = await services();
			const quick = threadSessions(context).find(session => session.runId === QUICK)!;
			quick.changes.get();
			await settle();
			const changes = quick.mainChat.get().changes.get();
			assert.deepStrictEqual(changes.map(change => [change.originalUri?.toString(), change.modifiedUri?.toString(), change.insertions, change.deletions]), [
				[undefined, `wisp-agent://${QUICK}/head/NOTES.md?c0ffee`, 2, 0],
				[`wisp-agent://${QUICK}/base/README.md?ba5e`, `wisp-agent://${QUICK}/head/README.md?c0ffee`, 1, 1],
			]);
			assert.strictEqual(quick.changes.get(), changes);
			const inRepo = threadSessions(context).find(session => session.runId === IN_REPO)!;
			assert.deepStrictEqual(inRepo.changes.get(), [], 'a run with no commit has no changes');
		});

		test('a thread on another host names its repository without a local folder', async () => {
			const context = await services('mac-mini');
			const [inRepo] = threadSessions(context);
			const workspace = inRepo.workspace.get()!;
			assert.strictEqual(workspace.uri.scheme, WISP_REPO_SCHEME);
			assert.strictEqual(workspace.uri.path, APP.path);
			assert.ok(workspace.isVirtualWorkspace);
			assert.strictEqual(context.provider.supportsLocalWorkspaces, false);
		});

		test('without the threads capability, the provider offers no thread type or quick chats', async () => {
			const context = agentsWindowServices(disposables, true);
			context.wispd.handler = async method => method === 'project/list' ? { projects: [], seq: 1 } : Promise.reject(new Error(method));
			context.wispd.setState(withCapabilities(connected(), { agents: {} }));
			await settle();
			assert.deepStrictEqual(context.provider.sessionTypes, []);
			assert.strictEqual(context.provider.supportsQuickChats, false);
			assert.strictEqual(context.provider.resolveWorkspace(URI.file(APP.path)), undefined);
			assert.throws(() => context.provider.createQuickChat(WISP_THREAD_SESSION_TYPE));
		});
	});

	suite('placement', () => {

		test('repo threads go under their repository and quick chats under No Repo, leaving out archived ones', async () => {
			const context = await services();
			const placement = placeThreadSessions(context.provider.getSessions());
			assert.deepStrictEqual(placement.repositories.map(group => [group.label, group.sessions.map(session => (session as WispThreadSession).runId)]), [['wisp', [IN_REPO]]]);
			assert.deepStrictEqual(placement.noRepo.map(session => (session as WispThreadSession).runId), [QUICK]);
		});

		test('a repository filter keeps that repository and hides the rest', async () => {
			const context = await services();
			const placement = placeThreadSessions(context.provider.getSessions());
			const key = placement.repositories[0].key;
			assert.deepStrictEqual(filterThreadPlacement(placement, key).repositories.map(group => group.label), ['wisp']);
			assert.deepStrictEqual(filterThreadPlacement(placement, key).noRepo, []);
			assert.strictEqual(filterThreadPlacement(placement, undefined), placement);
			assert.deepStrictEqual(filterThreadPlacement(placement, WISP_NO_REPO_FILTER).repositories, []);
			assert.strictEqual(filterThreadPlacement(placement, WISP_NO_REPO_FILTER).noRepo.length, 1);

			toggleSidebarRepositoryFilter(key);
			const container = mainWindow.document.createElement('div');
			mainWindow.document.body.appendChild(container);
			try {
				disposables.add(context.instantiationService.createInstance(WispThreadSections, container, 'filtered'));
				const sections = [...container.querySelectorAll<HTMLElement>('section')];
				assert.deepStrictEqual(sections.map(section => section.hidden), [false, true]);
				assert.deepStrictEqual([...container.querySelectorAll('.wisp-threads-repo-name')].map(heading => heading.textContent), ['wisp']);
			} finally {
				clearSidebarRepositoryFilter();
				container.remove();
			}
		});

		test('the sidebar lists them in Repositories and No Repo', async () => {
			const context = await services();
			const container = mainWindow.document.createElement('div');
			mainWindow.document.body.appendChild(container);
			try {
				disposables.add(context.instantiationService.createInstance(WispThreadSections, container, 'test'));
				const sections = [...container.querySelectorAll<HTMLElement>('section')];
				const read = (section: HTMLElement) => ({
					title: section.querySelector('h2')?.textContent,
					hidden: section.hidden,
					repos: [...section.querySelectorAll('.wisp-threads-repo-name')].map(heading => heading.textContent),
					rows: [...section.querySelectorAll('button.wisp-threads-row')].map(row => row.getAttribute('aria-label')?.split(',').slice(0, 2).join(',')),
				});
				assert.deepStrictEqual(sections.map(read), [
					{ title: 'Repositories', hidden: false, repos: ['wisp'], rows: ['Fix the flaky attach test, chat in wisp'] },
					{ title: 'No Repo', hidden: false, repos: [], rows: ['What is a git worktree?, chat'] },
				]);
				const rows = [...container.querySelectorAll<HTMLButtonElement>('button.wisp-threads-row')];
				assert.deepStrictEqual(rows.map(row => row.tabIndex), [0, 0], 'one tab stop per section');
				rows[0].click();
				assert.deepStrictEqual(context.opened.map(uri => uri.toString()), [threadResource(IN_REPO).toString()]);
			} finally {
				container.remove();
			}
		});
	});

	suite('empty sidebar', () => {

		test('Repositories and No Repo stay hidden while there are no threads', async () => {
			const empty = await services('local', false);
			const bare = mainWindow.document.createElement('div');
			disposables.add(empty.instantiationService.createInstance(WispThreadSections, bare, 'empty'));
			assert.deepStrictEqual([...bare.querySelectorAll<HTMLElement>('section')].map(section => section.hidden), [true, true]);
		});
	});

	suite('new chat', () => {

		test('a draft in a repository registers it and starts the thread with the draft\'s run id', async () => {
			const context = await services();
			const path = '/Users/ryan/src/other';
			assert.ok(context.provider.resolveWorkspace(URI.file(path)));
			assert.deepStrictEqual(context.provider.getSessionTypes(URI.file(path)).map(type => type.id), [WISP_THREAD_SESSION_TYPE]);
			const draft = context.provider.createNewSession(URI.file(path), WISP_THREAD_SESSION_TYPE) as WispThreadSession;
			assert.strictEqual(draft.status.get(), SessionStatus.Untitled);
			assert.strictEqual(draft.workspace.get()?.uri.path, path);
			assert.ok(!context.provider.getSessions().includes(draft), 'a draft is not listed until it is sent');
			const chat = await context.provider.createNewChat(draft.sessionId);
			const sent = await context.provider.sendRequest(draft.sessionId, chat.resource, { query: 'Add a changelog' });
			await settle();
			assert.strictEqual(sent, draft, 'the draft becomes the thread');
			assert.ok(context.provider.getSessions().includes(draft));
			const starts = context.wispd.requests.filter(([method]) => method === 'repo/add' || method === 'thread/start');
			assert.deepStrictEqual(starts.map(([method]) => method), ['repo/add', 'thread/start']);
			const params = starts[1][1] as ThreadStartParams;
			assert.strictEqual(params.runId, draft.runId);
			assert.strictEqual(params.prompt, 'Add a changelog');
			assert.ok(params.repo);
			assert.strictEqual(draft.title.get(), 'Add a changelog');
			assert.strictEqual(draft.status.get(), SessionStatus.InProgress);
		});

		test('a known repository is not registered again, and a quick chat starts with no repo', async () => {
			const context = await services();
			const draft = context.provider.createNewSession(URI.file(APP.path), WISP_THREAD_SESSION_TYPE);
			await context.provider.sendRequest(draft.sessionId, draft.mainChat.get().resource, { query: 'Tidy the README' });
			const quick = context.provider.createQuickChat(WISP_THREAD_SESSION_TYPE);
			assert.ok(quick.isQuickChat?.get());
			assert.strictEqual(quick.workspace.get(), undefined);
			await context.provider.sendRequest(quick.sessionId, quick.mainChat.get().resource, { query: 'Explain rebase' });
			const starts = context.wispd.requests.filter(([method]) => method === 'repo/add' || method === 'thread/start').map(([method, params]) => [method, (params as ThreadStartParams).repo]);
			assert.deepStrictEqual(starts, [['thread/start', APP.id], ['thread/start', undefined]]);
		});

		test('the empty thread names a repository, no repository, and a project (#298)', async () => {
			const repo = emptyThreadPresentation({ quickChat: false, sessionTypeId: WISP_THREAD_SESSION_TYPE, workspaceLabel: 'wisp', sessionTitle: 'draft' });
			assert.strictEqual(repo.placeholder, EMPTY_THREAD_PLACEHOLDER);
			assert.strictEqual(repo.placeholder, 'Describe a change or a task. Paste an error, a file, or a link.');
			assert.strictEqual(repo.hidePickerRow, true);
			assert.deepStrictEqual(repo.heading, [
				{ text: 'What should we build in ' },
				{ text: 'wisp', link: true },
				{ text: '?' },
			]);
			assert.deepStrictEqual(
				emptyThreadPresentation({ quickChat: true, sessionTypeId: WISP_THREAD_SESSION_TYPE, workspaceLabel: 'wisp', sessionTitle: undefined }).heading,
				[{ text: 'What do you want to work on?' }],
			);
			assert.deepStrictEqual(
				emptyThreadPresentation({ quickChat: false, sessionTypeId: WISP_THREAD_SESSION_TYPE, workspaceLabel: '  ', sessionTitle: undefined }).heading,
				[{ text: 'What do you want to work on?' }],
			);
			assert.deepStrictEqual(
				emptyThreadPresentation({ quickChat: false, sessionTypeId: WISP_PROJECT_SESSION_TYPE, workspaceLabel: 'wisp', sessionTitle: 'billing-migration' }).heading,
				[
					{ text: "What's the goal for " },
					{ text: 'billing-migration' },
					{ text: '?' },
				],
			);
			const context = await services();
			const fromProvider = context.provider.getEmptyThread({ quickChat: false, sessionTypeId: WISP_THREAD_SESSION_TYPE, workspaceLabel: 'wisp', sessionTitle: undefined });
			assert.deepStrictEqual(fromProvider, repo);
		});

		test('a deleted draft is forgotten', async () => {
			const context = await services();
			const draft = context.provider.createQuickChat(WISP_THREAD_SESSION_TYPE);
			context.provider.deleteNewSession(draft.sessionId);
			await assert.rejects(() => context.provider.sendRequest(draft.sessionId, draft.mainChat.get().resource, { query: 'x' }));
		});
	});

	suite('local changes (#257)', () => {

		function send(context: IThreadServices): Promise<ISession> {
			const draft = context.provider.createNewSession(URI.file(APP.path), WISP_THREAD_SESSION_TYPE);
			return context.provider.sendRequest(draft.sessionId, draft.mainChat.get().resource, { query: 'Tidy the README' });
		}

		/**
		 * Records `INotificationService.prompt` calls. Returns a `configure` hook for `services()`:
		 * `WispSessionsProvider` (and the `WispThreadSessions` inside it) reads `INotificationService`
		 * at construction, so stubbing it on `context.instantiationService` afterward would leave the
		 * already-injected instance in place and the stub would never be called.
		 */
		function capturePrompts(respond: (choices: ReadonlyArray<{ label: string; run: () => void }>, options?: { onCancel?: () => void; neverShowAgain?: { id: string } }) => void): { readonly prompts: Array<[string, unknown]>; readonly configure: (instantiationService: IThreadServices['instantiationService']) => void } {
			const prompts: Array<[string, unknown]> = [];
			const configure = (instantiationService: IThreadServices['instantiationService']) => instantiationService.stub(INotificationService, {
				prompt: (_severity: Severity, message: string, choices: ReadonlyArray<{ label: string; run: () => void }>, options?: { onCancel?: () => void; neverShowAgain?: { id: string } }) => {
					prompts.push([message, options?.neverShowAgain?.id]);
					respond(choices, options);
					return undefined;
				},
			} as unknown as INotificationService);
			return { prompts, configure };
		}

		test('a tracked-dirty run shows a notice naming the repository, with a "don\'t show again" choice', async () => {
			const { prompts, configure } = capturePrompts(() => { });
			const context = await services('local', true, configure);
			const handler = context.wispd.handler!;
			context.wispd.handler = async (method, params) => {
				if (method !== 'thread/start') {
					return handler(method, params);
				}
				const started = await handler(method, params) as { readonly thread: Thread; readonly run: AgentRun };
				return { ...started, run: { ...started.run, baseDirty: true } };
			};
			await send(context);
			assert.deepStrictEqual(prompts, [["This run started from wisp's last commit. Uncommitted changes there aren't in it.", WISP_BASE_DIRTY_NOTICE_ID]]);
		});

		test('a run that is not flagged dirty shows no notice', async () => {
			const { prompts, configure } = capturePrompts(() => { });
			const context = await services('local', true, configure);
			await send(context);
			assert.deepStrictEqual(prompts, []);
		});

		test('a lost connection is retried, idempotently on the run id', async () => {
			const { prompts, configure } = capturePrompts(choices => choices[0].run());
			const context = await services('local', true, configure);
			const handler = context.wispd.handler!;
			let failures = 1;
			context.wispd.handler = async (method, params) => {
				if (method === 'thread/start' && failures-- > 0) {
					throw new WispdUnavailableError('the connection to wispd was lost');
				}
				return handler(method, params);
			};
			await send(context);
			assert.strictEqual(prompts.length, 1);
			const starts = context.wispd.requests.filter(([method]) => method === 'thread/start').map(([, params]) => (params as ThreadStartParams).runId);
			assert.strictEqual(starts.length, 2);
			assert.strictEqual(starts[0], starts[1], 'the retry sends the same run id');
		});

		test('a transient worktree failure is retried, but a deterministic error is not', async () => {
			const { prompts, configure } = capturePrompts(choices => choices[0].run());
			const context = await services('local', true, configure);
			const handler = context.wispd.handler!;
			let failures = 1;
			context.wispd.handler = async (method, params) => {
				if (method === 'thread/start' && failures-- > 0) {
					throw new WispdError(-32000, 'git timed out', 'worktreeFailed');
				}
				return handler(method, params);
			};
			await send(context);
			assert.strictEqual(prompts.length, 1, 'a transient git failure offers Retry');

			context.wispd.handler = async (method, params) => method === 'thread/start' ? Promise.reject(new WispdError(-32602, 'no repo entry has id x', 'repoNotFound')) : handler(method, params);
			await assert.rejects(
				() => send(context),
				(error: unknown) => error instanceof WispdError && error.kind === 'repoNotFound',
			);
			assert.strictEqual(prompts.length, 1, 'a deterministic error is thrown straight through, with no Retry offered');
		});

		test('declining Retry cancels instead of showing the error again', async () => {
			const { prompts, configure } = capturePrompts((_choices, options) => options?.onCancel?.());
			const context = await services('local', true, configure);
			const handler = context.wispd.handler!;
			context.wispd.handler = async (method, params) => method === 'thread/start' ? Promise.reject(new WispdError(-32000, 'git timed out', 'worktreeFailed')) : handler(method, params);
			await assert.rejects(() => send(context), CancellationError);
			assert.strictEqual(prompts.length, 1, 'no further retry after declining');
		});
	});

	suite('archive and delete', () => {

		test('go through the provider to wispd, which stops a running agent itself', async () => {
			const context = await services();
			const [inRepo] = threadSessions(context);
			await context.provider.archiveSession(inRepo.sessionId);
			assert.ok(inRepo.isArchived.get());
			await context.provider.deleteSession(inRepo.sessionId);
			await settle();
			const calls = context.wispd.requests.map(([method]) => method).filter(method => method.startsWith('thread/') && method !== 'thread/list' || method === 'agent/cancel');
			assert.deepStrictEqual(calls, ['thread/archive', 'thread/delete']);
			assert.ok(!threadSessions(context).some((session: ISession) => session === inRepo), 'the deleted thread leaves the list');
			await assert.rejects(() => context.provider.archiveSession('wisp:wisp.project:/nope'));
		});
	});
});
