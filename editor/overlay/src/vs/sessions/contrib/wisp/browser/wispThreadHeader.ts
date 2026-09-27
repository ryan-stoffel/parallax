/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import './media/wispThreadHeader.css';
import { $, append } from '../../../../base/browser/dom.js';
import { BaseActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../base/common/actions.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IReader, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, IMenuService, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { AgentRun, DiffSummary } from '../../../../platform/wisp/common/wispProtocol.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { WISP_ACCEPT_AGENT_CHANGES, WISP_REQUEST_AGENT_CHANGES } from '../../../../workbench/contrib/wisp/browser/wispAgentReview.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionHeaderDecoration, setSessionHeaderDecorationReader } from '../../../browser/parts/sessionHeader.js';
import { SessionTypeContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { IWispAgentsService } from '../../providers/wisp/browser/wispAgentsService.js';
import { IWispThreadsService } from '../../providers/wisp/browser/wispThreadsService.js';
import { WISP_PROJECT_SESSION_TYPE } from '../../providers/wisp/common/wispProjects.js';
import { threadRunOf, WISP_NO_REPO_FILTER, WISP_THREAD_SESSION_TYPE } from '../../providers/wisp/common/wispThreads.js';

export const WISP_HEADER_IDE = 'wisp.header.ide';
export const WISP_HEADER_CHANGES = 'wisp.header.changes';
export const WISP_HEADER_ACCEPT = 'wisp.header.accept';
export const WISP_HEADER_REQUEST_CHANGES = 'wisp.header.requestChanges';
export const WISP_HEADER_COPY_BRANCH = 'wisp.header.copyBranch';

/** The Accept split button's menu. Accept itself is the primary half, not an item in the menu. */
export const WISP_THREAD_ACCEPT_MENU = MenuId.for('wisp.threadAccept');

const OPEN_IN_IDE = 'agents.openSessionInVSCode';
const OPEN_CHANGES_VIEW = 'workbench.action.agentSessions.openChangesView';

const inWispSession = ContextKeyExpr.or(
	SessionTypeContext.isEqualTo(WISP_THREAD_SESSION_TYPE),
	SessionTypeContext.isEqualTo(WISP_PROJECT_SESSION_TYPE),
);

export interface IThreadHeaderCrumb {
	readonly repository: string | undefined;
	readonly repositoryKey: string | undefined;
}

/** A project's name stands alone. A thread with no repo says "No repo". Otherwise the workspace label. */
export function threadHeaderCrumb(input: {
	readonly sessionType: string;
	readonly isQuickChat: boolean;
	readonly workspaceLabel: string | undefined;
	readonly workspaceKey: string | undefined;
}): IThreadHeaderCrumb {
	if (input.sessionType === WISP_PROJECT_SESSION_TYPE) {
		return { repository: undefined, repositoryKey: undefined };
	}
	if (input.isQuickChat || !input.workspaceLabel || !input.workspaceKey) {
		return { repository: localize('wispHeader.noRepo', "No repo"), repositoryKey: WISP_NO_REPO_FILTER };
	}
	return { repository: input.workspaceLabel, repositoryKey: input.workspaceKey };
}

export interface IThreadHeaderState {
	readonly word: string;
	readonly mark: 'working' | 'done' | 'stopped' | 'failed';
}

/**
 * The header's state word. Separate from the Agents panel's labels: a failed run reads
 * "Couldn't start", and both a cancelled and an interrupted run read "Stopped".
 */
export function threadHeaderState(status: string | undefined): IThreadHeaderState | undefined {
	switch (status) {
		case 'starting':
		case 'running':
			return { word: localize('wispHeader.working', "Working"), mark: 'working' };
		case 'completed':
		case 'accepted':
			return { word: localize('wispHeader.done', "Done"), mark: 'done' };
		case 'cancelled':
		case 'interrupted':
			return { word: localize('wispHeader.stopped', "Stopped"), mark: 'stopped' };
		case 'failed':
			return { word: localize('wispHeader.couldNotStart', "Couldn't start"), mark: 'failed' };
		default:
			return undefined;
	}
}

/** Insertions and deletions for the Changes label. A run that is still working shows "Changes" alone. */
export function changesStat(run: { status: string; diff?: DiffSummary } | undefined): { insertions: number; deletions: number } | undefined {
	if (!run || run.status === 'starting' || run.status === 'running' || !run.diff || run.diff.files <= 0) {
		return undefined;
	}
	return { insertions: run.diff.insertions, deletions: run.diff.deletions };
}

export function changesLabel(stat: { insertions: number; deletions: number } | undefined): string {
	return stat
		? localize('wispHeader.changesStat', "Changes +{0} −{1}", stat.insertions, stat.deletions)
		: localize('wispHeader.changes', "Changes");
}

/** Accept is the primary button only when the thread finished and has file changes. */
export function acceptIsPrimary(run: { status: string; diff?: DiffSummary } | undefined): boolean {
	return !!run && run.status === 'completed' && (run.diff?.files ?? 0) > 0;
}

export function findThreadRun<T extends { id: string }>(
	session: { sessionType: string; resource: URI } | undefined,
	threads: readonly { id: string; repo: string }[],
	runsOf: (repoId: string) => readonly T[],
	getRun: (runId: string) => T | undefined,
): T | undefined {
	if (!session || session.sessionType !== WISP_THREAD_SESSION_TYPE) {
		return undefined;
	}
	const runId = threadRunOf(session.resource);
	if (!runId) {
		return undefined;
	}
	const thread = threads.find(item => item.id === runId);
	if (!thread) {
		return getRun(runId);
	}
	return runsOf(thread.repo).find(run => run.id === runId);
}

function headerSession(value: unknown): IActiveSession | undefined {
	const session = value as IActiveSession | undefined;
	if (!session || typeof session !== 'object' || typeof session.sessionType !== 'string' || !URI.isUri(session.resource)) {
		return undefined;
	}
	return session;
}

function sessionFrom(accessor: ServicesAccessor, arg: unknown): IActiveSession | undefined {
	return headerSession(arg) ?? accessor.get(ISessionsService).activeSession.get();
}

function runIdOf(session: IActiveSession | undefined): string | undefined {
	return session && session.sessionType === WISP_THREAD_SESSION_TYPE ? threadRunOf(session.resource) : undefined;
}

function threadRun(session: IActiveSession | undefined, reader: IReader | undefined, threads: IWispThreadsService, agents: IWispAgentsService): AgentRun | undefined {
	const read = <T>(value: { read(reader: IReader | undefined): T }): T => value.read(reader);
	return findThreadRun(
		session,
		read(threads.threads),
		repo => read(agents.runs(repo)),
		id => agents.getRun(id),
	);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WISP_HEADER_IDE,
			title: localize2('wispHeader.ide', "IDE"),
			tooltip: localize('wispHeader.ideTooltip', "Open in the Editor Window"),
			f1: false,
			menu: { id: Menus.SessionBarToolbar, group: 'navigation', order: 1, when: inWispSession },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(OPEN_IN_IDE);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WISP_HEADER_CHANGES,
			title: localize2('wispHeader.changes', "Changes"),
			f1: false,
			menu: { id: Menus.SessionBarToolbar, group: 'navigation', order: 2, when: inWispSession },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(OPEN_CHANGES_VIEW);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WISP_HEADER_ACCEPT,
			title: localize2('wispHeader.accept', "Accept"),
			tooltip: localize('wispHeader.acceptTooltip', "Accept the thread's changes"),
			f1: false,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(
					IsSessionsWindowContext,
					SessionTypeContext.isEqualTo(WISP_THREAD_SESSION_TYPE),
					InputFocusedContext.toNegated(),
				),
			},
			menu: { id: WISP_THREAD_ACCEPT_MENU, group: 'navigation', order: 1 },
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const runId = runIdOf(sessionFrom(accessor, arg));
		await accessor.get(ICommandService).executeCommand(WISP_ACCEPT_AGENT_CHANGES, runId);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WISP_HEADER_REQUEST_CHANGES,
			title: localize2('wispHeader.requestChanges', "Request changes"),
			f1: false,
			menu: { id: WISP_THREAD_ACCEPT_MENU, group: 'navigation', order: 2 },
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const runId = runIdOf(sessionFrom(accessor, arg));
		await accessor.get(ICommandService).executeCommand(WISP_REQUEST_AGENT_CHANGES, runId);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WISP_HEADER_COPY_BRANCH,
			title: localize2('wispHeader.copyBranch', "Copy branch name"),
			f1: false,
			menu: { id: WISP_THREAD_ACCEPT_MENU, group: 'navigation', order: 3 },
		});
	}

	async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
		const session = sessionFrom(accessor, arg);
		const threads = accessor.get(IWispThreadsService);
		const agents = accessor.get(IWispAgentsService);
		const branch = threadRun(session, undefined, threads, agents)?.branch;
		const notificationService = accessor.get(INotificationService);
		if (!branch) {
			notificationService.info(localize('wispHeader.noBranch', "This thread has no branch name yet."));
			return;
		}
		await accessor.get(IClipboardService).writeText(branch);
		notificationService.info(localize('wispHeader.copiedBranch', "Copied {0}", branch));
	}
});

MenuRegistry.appendMenuItem(Menus.SessionBarToolbar, {
	submenu: WISP_THREAD_ACCEPT_MENU,
	title: localize2('wispHeader.accept', "Accept"),
	group: 'navigation',
	order: 3,
	when: inWispSession,
	isSplitButton: true,
});

class WispHeaderChangesItem extends BaseActionViewItem {

	private readonly session = observableValue<IActiveSession | undefined>(this, undefined);

	constructor(
		action: IAction,
		@IWispThreadsService private readonly threadsService: IWispThreadsService,
		@IWispAgentsService private readonly agentsService: IWispAgentsService,
	) {
		super(undefined, action);
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		this.session.set(headerSession(context), undefined);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('wisp-header-changes');
		const label = append(container, $('span.action-label'));
		this._register(autorun(reader => {
			const run = threadRun(this.session.read(reader), reader, this.threadsService, this.agentsService);
			const text = changesLabel(changesStat(run));
			label.textContent = text;
			container.setAttribute('aria-label', text);
		}));
	}
}

/** Accept, plus a menu of Request changes and Copy branch name. Primary only when the thread is done with changes. */
class WispHeaderAcceptItem extends BaseActionViewItem {

	private readonly session = observableValue<IActiveSession | undefined>(this, undefined);
	private acceptButton: HTMLButtonElement | undefined;

	constructor(
		action: IAction,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWispThreadsService private readonly threadsService: IWispThreadsService,
		@IWispAgentsService private readonly agentsService: IWispAgentsService,
	) {
		super(undefined, action);
	}

	override setActionContext(context: unknown): void {
		super.setActionContext(context);
		this.session.set(headerSession(context), undefined);
	}

	override onClick(): void {
		// The Accept button and the chevron handle their own clicks.
	}

	override focus(): void {
		if (this.acceptButton) {
			this.acceptButton.tabIndex = 0;
			this.acceptButton.focus();
			return;
		}
		super.focus();
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('wisp-header-accept', 'dimmed');
		const split = append(container, $('.wisp-header-accept-split'));
		const accept = this.acceptButton = append(split, $<HTMLButtonElement>('button.action-label', { type: 'button' }));
		accept.textContent = localize('wispHeader.accept', "Accept");
		const moreLabel = localize('wispHeader.acceptActions', "Accept actions");
		const more = append(split, $<HTMLButtonElement>('button.action-label.codicon.codicon-chevron-down', { type: 'button', 'aria-label': moreLabel }));
		this._register(autorun(reader => {
			const run = threadRun(this.session.read(reader), reader, this.threadsService, this.agentsService);
			const primary = acceptIsPrimary(run);
			container.classList.toggle('primary', primary);
			container.classList.toggle('dimmed', !primary);
			const keybinding = this.keybindingService.lookupKeybinding(WISP_HEADER_ACCEPT)?.getLabel();
			const label = localize('wispHeader.accept', "Accept");
			accept.setAttribute('aria-label', keybinding ? localize('wispHeader.acceptWithKey', "{0} ({1})", label, keybinding) : label);
		}));
		this._register(this.addClick(accept, () => this.commandService.executeCommand(WISP_HEADER_ACCEPT, this.session.get())));
		this._register(this.addClick(more, () => this.showMenu(more)));
	}

	private addClick(element: HTMLElement, run: () => void): { dispose(): void } {
		const listener = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			run();
		};
		element.addEventListener('click', listener);
		return { dispose: () => element.removeEventListener('click', listener) };
	}

	private showMenu(anchor: HTMLElement): void {
		const session = this.session.get();
		const menu = this.menuService.createMenu(WISP_THREAD_ACCEPT_MENU, this.contextKeyService);
		const actions = menu.getActions({ shouldForwardArgs: true, arg: session }).flatMap(([, group]) => group).filter(action => action.id !== WISP_HEADER_ACCEPT);
		menu.dispose();
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => actions,
		});
	}
}

export function threadHeaderDecoration(session: IActiveSession, reader: IReader, threads: IWispThreadsService, agents: IWispAgentsService): ISessionHeaderDecoration {
	const workspace = session.workspace.read(reader);
	const crumb = threadHeaderCrumb({
		sessionType: session.sessionType,
		isQuickChat: session.isQuickChat?.read(reader) ?? false,
		workspaceLabel: workspace?.label,
		workspaceKey: workspace?.uri.toString(),
	});
	const run = threadRun(session, reader, threads, agents);
	return {
		repository: crumb.repository,
		repositoryKey: crumb.repositoryKey,
		state: run ? threadHeaderState(run.status) : undefined,
	};
}

export class WispThreadHeaderContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.wispThreadHeader';

	constructor(
		@IWispThreadsService threadsService: IWispThreadsService,
		@IWispAgentsService agentsService: IWispAgentsService,
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		setSessionHeaderDecorationReader((session, reader) => threadHeaderDecoration(session, reader, threadsService, agentsService));
		this._register(toDisposable(() => setSessionHeaderDecorationReader(undefined)));
		this._register(actionViewItemService.register(Menus.SessionBarToolbar, WISP_HEADER_CHANGES, action => instantiationService.createInstance(WispHeaderChangesItem, action)));
		this._register(actionViewItemService.register(Menus.SessionBarToolbar, WISP_THREAD_ACCEPT_MENU, action => instantiationService.createInstance(WispHeaderAcceptItem, action)));
	}
}

registerWorkbenchContribution2(WispThreadHeaderContribution.ID, WispThreadHeaderContribution, WorkbenchPhase.BlockStartup);
