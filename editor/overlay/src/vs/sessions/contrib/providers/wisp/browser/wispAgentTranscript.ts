/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { basename } from '../../../../../base/common/path.js';
import { localize } from '../../../../../nls.js';
import { agentFileUri } from '../../../../../platform/wisp/common/wispAgentFiles.js';
import type { AgentDiffFile, AgentOutcome, AgentOutputItem, AgentRun, DiffSummary, JsonValue, LoggedEvent, RunId, TurnId } from '../../../../../platform/wisp/common/wispProtocol.js';
import { IChatMultiDiffDataSerialized, IChatProgress, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ToolDataSource } from '../../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';

/** The command #157 registers to open a run's changes in the diff review. */
export const WISP_REVIEW_AGENT_CHANGES_COMMAND = 'wisp.reviewAgentChanges';
/** Starts a new run with a finished run's task. */
export const WISP_RETRY_AGENT_COMMAND = 'wisp.retryAgent';
/** Sends again a message that never reached the agent. */
export const WISP_SEND_AGAIN_COMMAND = 'wisp.sendAgentMessageAgain';

/** One request and its response in a subagent's chat. */
export interface IWispTranscriptTurn {
	/** The chat request's id: the turn id wispd logged, or one made from the run's id for its task. */
	readonly id: string;
	/** The `turnId` of a message sent with `agent/send`; `undefined` for the task. */
	readonly turnId: TurnId | undefined;
	/** The message. A message whose text this window doesn't know shows a placeholder. */
	readonly prompt: string;
	readonly parts: IChatProgress[];
	complete: boolean;
	startedAt: number | undefined;
	/** When wispd reported the turn finished, which can be before its response closes. */
	finishedAt: number | undefined;
	completedAt: number | undefined;
}

/** What one event changed, in order, for a chat that is already showing the transcript. */
export type WispTranscriptChange =
	| { readonly kind: 'turnStarted'; readonly turn: IWispTranscriptTurn }
	| { readonly kind: 'parts'; readonly turn: IWispTranscriptTurn; readonly parts: readonly IChatProgress[] }
	| { readonly kind: 'turnCompleted'; readonly turn: IWispTranscriptTurn }
	/** A message never reached the agent, so its turn never starts. */
	| { readonly kind: 'dropped'; readonly turnId: TurnId }
	/** A closing line needs the file list from `agent/diff` before the turn can end. */
	| { readonly kind: 'needsFiles' };

/** The files `agent/diff` listed, with the commits their `wisp-agent:` URIs name. */
export interface IWispListedDiff {
	readonly base: string;
	readonly head: string;
	readonly files: readonly AgentDiffFile[];
}

export interface IWispTranscriptOptions {
	/** The text of a message this window sent, by its turn id. */
	readonly sentText: (turnId: TurnId) => string | undefined;
	/** The run's worktree branch, once it exists. */
	readonly branch?: () => string | undefined;
	/**
	 * Files from `agent/diff` for the commit in `DiffSummary`. `undefined` means they are not
	 * loaded yet, and a turn that changed files waits. The head must be that commit.
	 */
	readonly files?: () => IWispListedDiff | undefined;
	/** A warning or an event kind this transcript does not show. */
	readonly log?: (message: string) => void;
}

interface IPendingToolCall {
	readonly name: string;
	readonly input: JsonValue;
}

/**
 * A run's transcript, built one logged event at a time (decision record 0014): the task, then a
 * turn per message sent with `agent/send`. Parts are only ever appended to a turn, so a chat that
 * is showing it can stream the same parts it would have loaded as history.
 *
 * - `text` and `textDelta` are Markdown; `reasoning` is a thinking part.
 * - A tool call shows once its result arrives, or when its turn ends without one.
 * - A vendor `notice` is a transient progress line. A wispd `warning`, and an output kind this
 *   transcript does not show, is logged and not shown. `sessionStarted` and `usage` are skipped.
 * - A turn's response stays open until the CLI ends or the next message starts. It then closes
 *   with a quiet line (docs/design/chat-v2.md, Finished): how long it took, the files from
 *   `agent/diff`, and no info or warning card. It waits for the run's new status, since wispd
 *   reports the commit (`agent.diffReady`) after `agent.finished`, and for the file list when
 *   that commit changed something.
 */
export class WispAgentTranscript {

	readonly turns: IWispTranscriptTurn[] = [];
	private readonly seen = new Set<number>();
	private readonly pendingTools = new Map<string, IPendingToolCall>();
	/** Text already shown from `textDelta`s, by message id, so a later `text` isn't shown twice. */
	private readonly streamed = new Set<string>();
	private diff: DiffSummary | undefined;
	/** How the CLI ended, held until wispd has reported the commit that follows it. */
	private outcome: AgentOutcome | undefined;
	/** Whether the task's own `turnStarted` has arrived; its id is absent. */
	private taskStarted = false;
	/** The worktree branch, from the run and from `agent.started`. */
	private branch: string | undefined;
	/** Files supplied for `listedCommit` by `acceptListed`, after `agent/diff`. */
	private listed: IWispListedDiff | undefined;
	private listedCommit: string | undefined;

	constructor(
		private readonly run: Pick<AgentRun, 'id' | 'prompt' | 'createdAt' | 'diff' | 'branch'>,
		private readonly options: IWispTranscriptOptions,
	) {
		this.diff = run.diff;
		this.branch = run.branch;
		this.turns.push({
			id: taskTurnId(run.id),
			turnId: undefined,
			prompt: run.prompt,
			parts: [],
			complete: false,
			startedAt: Date.parse(run.createdAt) || undefined,
			finishedAt: undefined,
			completedAt: undefined,
		});
	}

	/** The turn that is showing now: the newest. */
	get current(): IWispTranscriptTurn {
		return this.turns[this.turns.length - 1];
	}

	/**
	 * The commit a closing line is waiting to list, or `undefined` when it is not waiting.
	 * `acceptListed` takes this commit.
	 */
	filesCommit(): string | undefined {
		if (!this.outcome || !this.waitsForFiles(this.outcome) || this.currentFiles()) {
			return undefined;
		}
		return this.diff?.commit;
	}

	/** Applies an event once. Events of other runs and kinds this editor doesn't know are skipped. */
	accept(logged: LoggedEvent): WispTranscriptChange[] {
		if (this.seen.has(logged.seq)) {
			return [];
		}
		this.seen.add(logged.seq);
		const event = logged.event;
		if (!('runId' in event) || event.runId !== this.run.id) {
			return [];
		}
		const time = Date.parse(logged.time) || undefined;
		switch (event.kind) {
			case 'agent.output': {
				const changes: WispTranscriptChange[] = [];
				for (const item of event.items) {
					changes.push(...this.item(item, time));
				}
				return changes;
			}
			case 'agent.diffReady':
				this.diff = event.diff;
				if (this.listedCommit !== event.diff.commit) {
					this.listed = undefined;
					this.listedCommit = undefined;
				}
				return [];
			case 'agent.started':
				if (event.run?.branch) {
					this.branch = event.run.branch;
				}
				return [];
			case 'agent.finished':
				// wispd commits the worktree after the CLI ends, then reports the commit and the
				// run's new status, so the closing line waits for that status.
				this.outcome = event.outcome;
				return this.closeTools(time);
			case 'agent.updated':
				return event.state.status === 'starting' || event.state.status === 'running' ? [] : this.completeAll(time);
			default:
				return [];
		}
	}

	/**
	 * Supplies the file list `agent/diff` returned for `commit` (the value of `filesCommit`) and
	 * closes the turn that was waiting for it. A list that arrives after that wait has ended,
	 * because the next message already started, is ignored, so the new turn keeps streaming.
	 */
	acceptListed(commit: string, listed: IWispListedDiff, time?: number): WispTranscriptChange[] {
		if (this.filesCommit() !== commit) {
			return [];
		}
		const waiting = this.current;
		this.listed = listed;
		this.listedCommit = commit;
		const changes = this.flushOutcome(time, true);
		if (this.outcome || waiting.complete) {
			return changes;
		}
		changes.push(...this.complete(waiting, time));
		return changes;
	}

	private item(item: AgentOutputItem, time: number | undefined): WispTranscriptChange[] {
		switch (item.kind) {
			case 'turnStarted':
				return this.turnStarted(item.turnId, time);
			case 'turnFinished': {
				// The turn's response stays open until the CLI ends or the next message starts, so the
				// closing line lands in it. The task's turn has no id.
				const turn = this.turns.find(candidate => candidate.turnId === item.turnId);
				if (turn && turn.finishedAt === undefined) {
					turn.finishedAt = time;
				}
				return [];
			}
			case 'textDelta':
				if (item.messageId) {
					this.streamed.add(item.messageId);
				}
				return this.append([markdown(item.text)]);
			case 'text':
				if (item.messageId && this.streamed.has(item.messageId)) {
					return [];
				}
				return this.append([markdown(item.text)]);
			case 'reasoning':
				return this.append([{ kind: 'thinking', value: item.text, ...(item.messageId ? { id: item.messageId } : {}) }]);
			case 'toolCall':
				this.pendingTools.set(item.callId, { name: item.name, input: item.input });
				return [];
			case 'toolResult': {
				const call = this.pendingTools.get(item.callId);
				this.pendingTools.delete(item.callId);
				return this.append([toolPart(item.callId, call?.name ?? localize('wispAgent.tool', "Tool"), call?.input ?? null, item.status, item.output)]);
			}
			case 'todoList':
				return this.append([{
					kind: 'toolInvocationSerialized',
					toolCallId: `todo-${this.current.id}-${this.current.parts.length}`,
					toolId: 'TodoWrite',
					source: ToolDataSource.Internal,
					invocationMessage: localize('wispAgent.todoUpdating', "Updating the checklist"),
					originMessage: undefined,
					pastTenseMessage: localize('wispAgent.todoUpdated', "Updated the checklist"),
					isConfirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
					isComplete: true,
					presentation: undefined,
					toolSpecificData: {
						kind: 'todoList',
						todoList: item.items.map((todo, index) => ({
							id: String(index),
							title: todo.text,
							status: todo.status === 'completed' ? 'completed' : todo.status === 'inProgress' ? 'in-progress' : 'not-started',
						})),
					},
				}]);
			case 'notice':
				return this.append([{ kind: 'progressMessage', content: new MarkdownString().appendText(item.detail) }]);
			case 'warning':
				this.options.log?.(localize('wispAgent.warningSkipped', "Skipped a warning from the agent: {0}", item.detail));
				return [];
			case 'followUpDropped':
				return [...this.append(droppedEnding(this.run.id, item.turnId)), { kind: 'dropped', turnId: item.turnId }];
			default: {
				// A newer wispd can send a kind this type doesn't list. `sessionStarted` and `usage` are known and skipped.
				const kind = item.kind as string;
				if (kind !== 'sessionStarted' && kind !== 'usage') {
					this.options.log?.(localize('wispAgent.unknownEvent', "Skipped an agent event ({0}).", kind));
				}
				return [];
			}
		}
	}

	private turnStarted(turnId: TurnId | undefined, time: number | undefined): WispTranscriptChange[] {
		if (turnId === undefined && !this.taskStarted && this.turns.length === 1) {
			this.taskStarted = true;
			return [];
		}
		if (turnId !== undefined && this.turns.some(turn => turn.turnId === turnId)) {
			return [];
		}
		// The next message does not wait for the file list: the previous line closes with the
		// summary, and chips only if the list is already here.
		const changes = this.flushOutcome(time, false);
		changes.push(...this.closeTools(time));
		const previous = this.current;
		if (!previous.complete) {
			changes.push(...this.complete(previous, time));
		}
		const turn: IWispTranscriptTurn = {
			id: turnId ?? `${taskTurnId(this.run.id)}-${this.turns.length}`,
			turnId,
			prompt: (turnId && this.options.sentText(turnId)) || localize('wispAgent.unknownMessage', "A message sent to this agent"),
			parts: [],
			complete: false,
			startedAt: time,
			finishedAt: undefined,
			completedAt: undefined,
		};
		this.turns.push(turn);
		changes.push({ kind: 'turnStarted', turn });
		return changes;
	}

	/** Shows the closing line of the CLI that just ended, if one hasn't been shown. */
	private flushOutcome(time: number | undefined, waitForFiles: boolean): WispTranscriptChange[] {
		const outcome = this.outcome;
		if (!outcome) {
			return [];
		}
		if (waitForFiles && this.waitsForFiles(outcome) && !this.currentFiles()) {
			return [{ kind: 'needsFiles' }];
		}
		this.outcome = undefined;
		return [...this.closeTools(time), ...this.append(this.ending(outcome, time))];
	}

	/**
	 * Shows the closing line, then closes every open turn. It runs when the run stops running,
	 * and the chat calls it when the run is no longer running but no `agent.updated` came, as for
	 * a run wispd found interrupted after a crash. A line that still needs `agent/diff` leaves the
	 * turn open and reports `needsFiles`.
	 */
	completeAll(time: number | undefined): WispTranscriptChange[] {
		const changes: WispTranscriptChange[] = this.flushOutcome(time, true);
		if (this.outcome) {
			return changes;
		}
		for (const turn of this.turns) {
			if (!turn.complete) {
				changes.push(...this.complete(turn, time));
			}
		}
		return changes;
	}

	private ending(outcome: AgentOutcome, time: number | undefined): IChatProgress[] {
		const retry = { id: WISP_RETRY_AGENT_COMMAND, title: localize('wispAgent.retry', "Retry"), arguments: [this.run.id] };
		const files = this.currentFiles();
		switch (outcome.status) {
			case 'completed':
				return [quietLine('check', this.doneText(this.duration(time))), ...this.fileList(files)];
			case 'failed':
				// #297 rewrites this copy. It is a quiet line until then, not a warning card.
				return [
					quietLine(undefined, localize('wispAgent.failedLine', "Failed: {0}", outcome.message)),
					...this.fileList(files),
					{ kind: 'command', command: retry },
				];
			case 'cancelled':
				return [
					quietLine('primitive-square', this.stoppedText()),
					...this.fileList(files),
					{ kind: 'command', command: retry },
				];
			case 'interrupted':
				return [quietLine(undefined, localize('wispAgent.interruptedLine', "wispd restarted before the agent finished. Send a message to pick up where it left off."))];
			default:
				return [];
		}
	}

	/** Tool calls whose turn ended without a result show as they are. */
	private closeTools(_time: number | undefined): WispTranscriptChange[] {
		const parts: IChatProgress[] = [];
		for (const [callId, call] of this.pendingTools) {
			parts.push(toolPart(callId, call.name, call.input, undefined, undefined));
		}
		this.pendingTools.clear();
		return parts.length ? this.append(parts) : [];
	}

	private complete(turn: IWispTranscriptTurn, time: number | undefined): WispTranscriptChange[] {
		if (turn.complete) {
			return [];
		}
		const changes = turn === this.current ? this.closeTools(time) : [];
		turn.complete = true;
		turn.completedAt = turn.finishedAt ?? time;
		changes.push({ kind: 'turnCompleted', turn });
		return changes;
	}

	private append(parts: IChatProgress[]): WispTranscriptChange[] {
		const turn = this.current;
		turn.parts.push(...parts);
		return [{ kind: 'parts', turn, parts }];
	}

	private get changed(): boolean {
		return !!this.diff && this.diff.files > 0;
	}

	/** Interrupted turns have no file list: the spec gives them no button, and Review lives on the list. */
	private waitsForFiles(outcome: AgentOutcome): boolean {
		return this.changed && outcome.status !== 'interrupted';
	}

	private currentFiles(): IWispListedDiff | undefined {
		const commit = this.diff?.commit;
		if (!commit) {
			return undefined;
		}
		if (this.listed && this.listedCommit === commit) {
			return this.listed;
		}
		const fromOption = this.options.files?.();
		return fromOption && fromOption.head === commit ? fromOption : undefined;
	}

	private fileList(files: IWispListedDiff | undefined): IChatProgress[] {
		if (!this.changed || !files || files.files.length === 0) {
			return [];
		}
		return [multiDiff(this.run.id, files)];
	}

	private branchName(): string | undefined {
		return this.options.branch?.() || this.branch;
	}

	private duration(time: number | undefined): string | undefined {
		const start = this.current.startedAt;
		const end = this.current.finishedAt ?? time;
		if (start === undefined || end === undefined) {
			return undefined;
		}
		return formatTurnDuration(end - start);
	}

	private doneText(duration: string | undefined): string {
		if (!this.changed || !this.diff) {
			return duration
				? localize('wispAgent.doneUnchanged', "Done in {0}. No files changed.", duration)
				: localize('wispAgent.doneUnchangedNoTime', "Done. No files changed.");
		}
		const stat = fileStat(this.diff);
		const branch = this.branchName();
		if (duration && branch) {
			return localize('wispAgent.done', "Done in {0} · {1} · committed to {2}", duration, stat, branch);
		}
		if (duration) {
			return localize('wispAgent.doneNoBranch', "Done in {0} · {1}", duration, stat);
		}
		if (branch) {
			return localize('wispAgent.doneNoTime', "Done · {0} · committed to {1}", stat, branch);
		}
		return localize('wispAgent.doneBare', "Done · {0}", stat);
	}

	private stoppedText(): string {
		if (!this.changed || !this.diff) {
			return localize('wispAgent.stoppedUnchanged', "Stopped. No files changed.");
		}
		return localize('wispAgent.stopped', "Stopped · {0}", fileStat(this.diff));
	}
}

export function taskTurnId(runId: RunId): string {
	return `task-${runId}`;
}

/** A quiet line and **Send again**, for a message that never reached the agent. */
export function droppedEnding(runId: RunId, turnId: TurnId): IChatProgress[] {
	return [
		quietLine(undefined, localize('wispAgent.followUpDropped', "Your message didn't reach the agent before it stopped")),
		{
			kind: 'command',
			command: {
				id: WISP_SEND_AGAIN_COMMAND,
				title: localize('wispAgent.sendAgain', "Send again"),
				arguments: [runId, turnId],
			},
		},
	];
}

/** `3m 04s` once a turn takes a minute, otherwise `40s`. Hours keep the minutes. */
export function formatTurnDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	}
	return `${seconds}s`;
}

function fileStat(diff: DiffSummary): string {
	const files = diff.files === 1
		? localize('wispAgent.oneFile', "1 file changed")
		: localize('wispAgent.manyFiles', "{0} files changed", diff.files);
	return localize('wispAgent.fileStat', "{0} +{1} -{2}", files, diff.insertions, diff.deletions);
}

/** A status line that stays. `icon` is a codicon id, drawn as an icon rather than typed. */
function quietLine(icon: string | undefined, text: string): IChatProgress {
	const content = new MarkdownString('', { supportThemeIcons: true });
	if (icon) {
		content.appendMarkdown(`$(${icon}) `);
	}
	content.appendText(text);
	return { kind: 'markdownContent', content };
}

function markdown(text: string): IChatProgress {
	return { kind: 'markdownContent', content: new MarkdownString(text) };
}

/** One chip per file. Review changes and Open in IDE are menu items on this part, not buttons here. */
function multiDiff(runId: RunId, listed: IWispListedDiff): IChatMultiDiffDataSerialized {
	return {
		kind: 'multiDiffData',
		collapsed: false,
		multiDiffData: {
			title: listed.files.length === 1
				? localize('wispAgent.diffOne', "Changed 1 file")
				: localize('wispAgent.diffMany', "Changed {0} files", listed.files.length),
			resources: listed.files.map(file => {
				const basePath = file.oldPath ?? file.path;
				const originalUri = file.status === 'added' ? undefined : agentFileUri({ runId, side: 'base', path: basePath, commit: listed.base });
				const modifiedUri = file.status === 'deleted' ? undefined : agentFileUri({ runId, side: 'head', path: file.path, commit: listed.head });
				return {
					originalUri,
					modifiedUri,
					goToFileUri: modifiedUri ?? originalUri,
					added: file.insertions,
					removed: file.deletions,
				};
			}),
		},
	};
}

function toolPart(callId: string, name: string, input: JsonValue, status: 'ok' | 'error' | 'denied' | undefined, output: string | undefined): IChatToolInvocationSerialized {
	const subject = toolSubject(input);
	const invocation = subject
		? localize('wispAgent.toolRunning', "{0} {1}", name, subject)
		: name;
	const past = status === 'denied'
		? localize('wispAgent.toolDenied', "{0} was denied", invocation)
		: status === 'error'
			? localize('wispAgent.toolFailed', "{0} failed", invocation)
			: invocation;
	return {
		kind: 'toolInvocationSerialized',
		toolCallId: callId,
		toolId: name,
		source: ToolDataSource.Internal,
		invocationMessage: invocation,
		originMessage: undefined,
		pastTenseMessage: past,
		isConfirmed: status === 'denied' ? { type: ToolConfirmKind.Denied } : { type: ToolConfirmKind.ConfirmationNotNeeded },
		isComplete: true,
		presentation: undefined,
		toolSpecificData: {
			kind: 'simpleToolInvocation',
			input: typeof input === 'string' ? input : JSON.stringify(input, undefined, 2),
			output: output ?? '',
		},
	};
}

/** What a tool call is about, for its one-line summary: a file's name, a command, or a pattern. */
export function toolSubject(input: JsonValue): string | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	for (const key of ['file_path', 'path', 'notebook_path']) {
		const value = input[key];
		if (typeof value === 'string' && value) {
			return basename(value);
		}
	}
	for (const key of ['command', 'pattern', 'url', 'query', 'description']) {
		const value = input[key];
		if (typeof value === 'string' && value) {
			const line = value.split('\n')[0];
			return line.length > 60 ? `${line.slice(0, 59)}…` : line;
		}
	}
	return undefined;
}
