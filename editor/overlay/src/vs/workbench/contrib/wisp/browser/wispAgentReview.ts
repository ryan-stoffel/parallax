/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

// Reviewing an agent run's changes (#157): the `wisp-agent:` file system over `agent/file`, the
// multi-diff editor's source over `agent/diff`, and commands to review, accept, and request
// changes. The Agents window's review bar and Changes tab (#105) call the same commands.

import { ValueWithChangeEvent } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { agentReviewItems, agentReviewUri, parseAgentReviewUri, reviewedCommit, WISP_AGENT_REVIEW_SCHEME, WISP_AGENT_SCHEME, WispAgentFileSystemProvider } from '../../../../platform/wisp/common/wispAgentFiles.js';
import { IWispdService, WispdState } from '../../../../platform/wisp/common/wispd.js';
import { isLocalHost, WISP_HOST_LOCAL, WISP_HOST_SETTING } from '../../../../platform/wisp/common/wispdConfiguration.js';
import type { AgentRun, RunId } from '../../../../platform/wisp/common/wispProtocol.js';
import { generateUuidV7 } from '../../../../platform/wisp/common/uuidv7.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { MultiDiffEditorInput } from '../../multiDiffEditor/browser/multiDiffEditorInput.js';
import { IMultiDiffSourceResolver, IMultiDiffSourceResolverService, IResolvedMultiDiffSource, MultiDiffEditorItem } from '../../multiDiffEditor/browser/multiDiffSourceResolverService.js';

export const WISP_REVIEW_AGENT_CHANGES = 'wisp.reviewAgentChanges';
export const WISP_ACCEPT_AGENT_CHANGES = 'wisp.acceptAgentChanges';
export const WISP_REQUEST_AGENT_CHANGES = 'wisp.requestAgentChanges';
/** Opens the run's worktree in an editor window. The finished turn's file list contributes it. */
export const WISP_OPEN_AGENT_IN_IDE = 'wisp.openAgentInIde';

/** A `wisp.agent` chat, the only transcript that contributes these buttons (#296). */
const inWispAgentChat = ContextKeyExpr.equals('chatSessionType', 'wisp.agent');

/** Whether the connected wispd reviews runs: it advertises the `agentReview` capability. */
export const WispAgentReviewContext = new RawContextKey<boolean>('wisp.agentReview', false, localize('wisp.agentReview', "Whether the connected wispd can review and accept agent runs"));

const category = localize2('wisp', "Wisp");

/** A run's task as a short title: its first line, cut to 60 characters. */
export function taskTitle(prompt: string): string {
	const first = prompt.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? '';
	return first.length > 60 ? `${first.slice(0, 57)}...` : first;
}

class WispAgentReviewResolver implements IMultiDiffSourceResolver {

	constructor(private readonly wispdService: IWispdService) { }

	canHandleUri(uri: URI): boolean {
		return uri.scheme === WISP_AGENT_REVIEW_SCHEME;
	}

	async resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource> {
		const source = parseAgentReviewUri(uri);
		if (!source) {
			throw new Error(`${uri.toString()} is not an agent run's review`);
		}
		const diff = await this.wispdService.request('agent/diff', { runId: source.runId });
		const items = agentReviewItems(source.runId, diff)
			.map(item => new MultiDiffEditorItem(item.original, item.modified, item.modified ?? item.original));
		return { resources: ValueWithChangeEvent.const(items) };
	}
}

/** Serves `wisp-agent:` files and agent reviews in this window, and tracks whether wispd can review. */
class WispAgentReviewContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.wisp.agentReview';

	constructor(
		@IWispdService wispdService: IWispdService,
		@IFileService fileService: IFileService,
		@IMultiDiffSourceResolverService resolverService: IMultiDiffSourceResolverService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const provider = this._register(new WispAgentFileSystemProvider(wispdService));
		this._register(fileService.registerProvider(WISP_AGENT_SCHEME, provider));
		this._register(resolverService.registerResolver(new WispAgentReviewResolver(wispdService)));

		const supported = WispAgentReviewContext.bindTo(contextKeyService);
		const update = (state: WispdState) => supported.set(state.kind === 'connected' && 'agentReview' in state.capabilities);
		this._register(wispdService.onDidChangeState(update));
		wispdService.getState().then(update);
	}
}

registerWorkbenchContribution2(WispAgentReviewContribution.ID, WispAgentReviewContribution, WorkbenchPhase.BlockRestore);

interface IRunPick extends IQuickPickItem {
	readonly run: AgentRun;
}

/** The runs that have a commit to review or accept. */
async function reviewableRuns(wispdService: IWispdService): Promise<AgentRun[]> {
	const { runs } = await wispdService.request('agent/list', {});
	return runs
		.filter(run => run.diff !== undefined && run.status !== 'accepted')
		.reverse();
}

async function findRun(wispdService: IWispdService, runId: RunId): Promise<AgentRun | undefined> {
	const { runs } = await wispdService.request('agent/list', {});
	return runs.find(run => run.id === runId);
}

/** The source of the agent run review open in the active editor, if one is. */
function activeReview(editorService: IEditorService): URI | undefined {
	const editor = editorService.activeEditor;
	return editor instanceof MultiDiffEditorInput && editor.multiDiffSource.scheme === WISP_AGENT_REVIEW_SCHEME
		? editor.multiDiffSource
		: undefined;
}

/**
 * A run id passed to a command, or the one in a `wisp.agent` chat resource. The finished turn's
 * file-list toolbar passes that resource, marshalled, as the menu argument.
 */
export function runIdFromArgument(arg: unknown): RunId | undefined {
	if (typeof arg === 'string') {
		return arg;
	}
	if (!arg || typeof arg !== 'object') {
		return undefined;
	}
	const uri = URI.isUri(arg) ? arg : URI.revive(arg);
	if (uri.scheme !== 'wisp.agent') {
		return undefined;
	}
	const match = /^\/[^/]+\/([^/]+)$/.exec(uri.path);
	return match ? match[1] : undefined;
}

/** The run a command was given, else the one whose review is open, else one the user picks. */
async function chooseRun(accessor: ServicesAccessor, runId: unknown, placeHolder: string): Promise<AgentRun | undefined> {
	const wispdService = accessor.get(IWispdService);
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const open = activeReview(accessor.get(IEditorService));
	if (typeof runId !== 'string') {
		runId = runIdFromArgument(runId) ?? (open ? parseAgentReviewUri(open)?.runId : undefined);
	}
	if (typeof runId === 'string') {
		const run = await findRun(wispdService, runId);
		if (!run) {
			notificationService.error(localize('wispAgentReview.noRun', "No agent run has id {0}.", runId));
		}
		return run;
	}
	const runs = await reviewableRuns(wispdService);
	const picks: IRunPick[] = runs.map(run => ({
		label: taskTitle(run.prompt),
		description: run.diff ? localize('wispAgentReview.stat', "{0} files, +{1} -{2}", run.diff.files, run.diff.insertions, run.diff.deletions) : undefined,
		detail: run.branch,
		run,
	}));
	if (!picks.length) {
		notificationService.info(localize('wispAgentReview.none', "No agent run has changes to review."));
		return undefined;
	}
	return (await quickInputService.pick(picks, { placeHolder }))?.run;
}

function failed(notificationService: INotificationService, what: string, error: unknown): void {
	notificationService.error(localize('wispAgentReview.failed', "{0}: {1}", what, error instanceof Error ? error.message : String(error)));
}

registerAction2(class ReviewAgentChangesAction extends Action2 {
	constructor() {
		super({
			id: WISP_REVIEW_AGENT_CHANGES,
			title: localize2('wispAgentReview.review', "Review Agent Changes"),
			category,
			f1: true,
			precondition: WispAgentReviewContext,
		});
	}

	async run(accessor: ServicesAccessor, runId?: unknown): Promise<void> {
		const wispdService = accessor.get(IWispdService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		try {
			const run = await chooseRun(accessor, runId, localize('wispAgentReview.pickReview', "Choose an agent run to review"));
			if (!run) {
				return;
			}
			const diff = await wispdService.request('agent/diff', { runId: run.id });
			if (!diff.files.length) {
				notificationService.info(localize('wispAgentReview.empty', "{0} has no changes to review yet.", taskTitle(run.prompt)));
				return;
			}
			await editorService.openEditor({
				multiDiffSource: agentReviewUri(run.id, diff.head),
				label: localize('wispAgentReview.label', "Review: {0}", taskTitle(run.prompt)),
				isTransient: true,
			});
		} catch (error) {
			failed(notificationService, localize('wispAgentReview.reviewFailed', "Couldn't open the agent's changes"), error);
		}
	}
});

// The file list's toolbar shows every contributed action. `navigation` is its first group, and
// order 1 puts Review changes ahead of Open in IDE: Review is the primary button (#296).
MenuRegistry.appendMenuItem(MenuId.ChatMultiDiffContext, {
	command: {
		id: WISP_REVIEW_AGENT_CHANGES,
		title: localize('wispAgentReview.reviewChanges', "Review changes"),
		precondition: WispAgentReviewContext,
	},
	group: 'navigation',
	order: 1,
	when: ContextKeyExpr.and(inWispAgentChat, WispAgentReviewContext),
});

registerAction2(class AcceptAgentChangesAction extends Action2 {
	constructor() {
		super({
			id: WISP_ACCEPT_AGENT_CHANGES,
			title: localize2('wispAgentReview.accept', "Accept Agent Changes"),
			category,
			f1: true,
			precondition: WispAgentReviewContext,
		});
	}

	/** `commit` is the head the caller's review showed; the review bar (#105) passes it. */
	async run(accessor: ServicesAccessor, runId?: unknown, commit?: unknown): Promise<void> {
		const wispdService = accessor.get(IWispdService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const open = activeReview(accessor.get(IEditorService));
		try {
			const run = await chooseRun(accessor, runId, localize('wispAgentReview.pickAccept', "Choose an agent run to accept"));
			if (!run?.diff) {
				return;
			}
			const { confirmed } = await dialogService.confirm({
				message: localize('wispAgentReview.confirm', "Accept the changes from {0}?", taskTitle(run.prompt)),
				detail: localize('wispAgentReview.confirmDetail', "Wisp merges {0} into the project's current branch on its host, fast-forward when it can, then removes the agent's worktree and branch. Nothing is pushed. Uncommitted changes to the same files stop the merge.", run.branch ?? run.id),
				primaryButton: localize({ key: 'wispAgentReview.acceptButton', comment: ['&& denotes a mnemonic'] }, "&&Accept"),
			});
			if (!confirmed) {
				return;
			}
			const reviewed = reviewedCommit(run, open, typeof commit === 'string' ? commit : undefined);
			const { merge } = await wispdService.request('agent/accept', reviewed ? { runId: run.id, id: generateUuidV7(), commit: reviewed } : { runId: run.id, id: generateUuidV7() });
			const message = merge.how === 'upToDate'
				? localize('wispAgentReview.upToDate', "{0} already had the changes from {1}.", merge.into, taskTitle(run.prompt))
				: localize('wispAgentReview.accepted', "Merged {0} into {1} ({2}).", taskTitle(run.prompt), merge.into, merge.commit.slice(0, 8));
			notificationService.info(message);
		} catch (error) {
			failed(notificationService, localize('wispAgentReview.acceptFailed', "Couldn't accept the agent's changes"), error);
		}
	}
});

registerAction2(class RequestAgentChangesAction extends Action2 {
	constructor() {
		super({
			id: WISP_REQUEST_AGENT_CHANGES,
			title: localize2('wispAgentReview.requestChanges', "Request Changes from Agent"),
			category,
			f1: true,
			precondition: WispAgentReviewContext,
		});
	}

	async run(accessor: ServicesAccessor, runId?: unknown, text?: unknown): Promise<void> {
		const wispdService = accessor.get(IWispdService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		try {
			const run = await chooseRun(accessor, runId, localize('wispAgentReview.pickRequest', "Choose an agent run to send changes to"));
			if (!run) {
				return;
			}
			const message = typeof text === 'string' && text.trim()
				? text
				: await quickInputService.input({
					prompt: localize('wispAgentReview.requestPrompt', "What should {0} change?", taskTitle(run.prompt)),
					placeHolder: localize('wispAgentReview.requestPlaceholder', "Describe the changes you want"),
				});
			if (!message?.trim()) {
				return;
			}
			await wispdService.request('agent/requestChanges', { runId: run.id, turnId: generateUuidV7(), text: message });
		} catch (error) {
			failed(notificationService, localize('wispAgentReview.requestFailed', "Couldn't send the requested changes"), error);
		}
	}
});

registerAction2(class OpenAgentInIdeAction extends Action2 {
	constructor() {
		super({
			id: WISP_OPEN_AGENT_IN_IDE,
			title: localize2('wispAgentReview.openInIde', "Open in IDE"),
			category,
			f1: false,
			menu: {
				id: MenuId.ChatMultiDiffContext,
				group: 'navigation',
				order: 2,
				when: inWispAgentChat,
			},
		});
	}

	/** Opens the run's worktree when it is on this Mac. Otherwise the session's IDE action. */
	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const hostService = accessor.get(IHostService);
		const wispdService = accessor.get(IWispdService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const runId = runIdFromArgument(arg);
		try {
			const run = runId ? await findRun(wispdService, runId) : undefined;
			const state = await wispdService.getState();
			const local = state.target ? state.target === WISP_HOST_LOCAL : isLocalHost(configurationService.getValue(WISP_HOST_SETTING));
			if (run?.worktreePath && local) {
				await hostService.openWindow([{ folderUri: URI.file(run.worktreePath) }], { forceNewWindow: true });
				return;
			}
		} catch (error) {
			failed(notificationService, localize('wispAgentReview.openInIdeFailed', "Couldn't open the agent's worktree"), error);
			return;
		}
		await commandService.executeCommand('agents.openSessionInVSCode');
	}
});
