/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { WISP_PROJECT_SESSION_TYPE } from '../common/wispProjects.js';

/**
 * What the empty-thread patch in `newChatWidget.ts` asks a provider for (#298).
 * The field names match that patch's context; the widget reads them structurally.
 */
export interface IEmptyThreadContext {
	readonly quickChat: boolean;
	readonly sessionTypeId: string | undefined;
	readonly workspaceLabel: string | undefined;
	readonly sessionTitle: string | undefined;
}

export interface IEmptyThreadSegment {
	readonly text: string;
	/** Set on the repository name. Clicking it opens the repository picker. */
	readonly link?: boolean;
}

export interface IEmptyThreadPresentation {
	readonly heading: readonly IEmptyThreadSegment[];
	readonly placeholder: string;
	readonly hidePickerRow: true;
}

/** The empty composer's placeholder, from the chat v2 spec. */
export const EMPTY_THREAD_PLACEHOLDER = localize('wispEmptyThread.placeholder', "Describe a change or a task. Paste an error, a file, or a link.");

/**
 * The heading above a new thread. A repository names itself and links it. No repository asks
 * what to work on. A project's coordinator (M4) names the project. The placeholder is the same
 * for all three.
 */
export function emptyThreadPresentation(context: IEmptyThreadContext): IEmptyThreadPresentation {
	if (context.sessionTypeId === WISP_PROJECT_SESSION_TYPE) {
		const name = named(context.sessionTitle) ?? named(context.workspaceLabel) ?? localize('wispEmptyThread.thisProject', "this project");
		return presentation([
			{ text: localize('wispEmptyThread.projectBefore', "What's the goal for ") },
			{ text: name },
			{ text: '?' },
		]);
	}
	const repository = context.quickChat ? undefined : named(context.workspaceLabel);
	if (!repository) {
		return presentation([{ text: localize('wispEmptyThread.noRepo', "What do you want to work on?") }]);
	}
	return presentation([
		{ text: localize('wispEmptyThread.repoBefore', "What should we build in ") },
		{ text: repository, link: true },
		{ text: '?' },
	]);
}

function presentation(heading: readonly IEmptyThreadSegment[]): IEmptyThreadPresentation {
	return { heading, placeholder: EMPTY_THREAD_PLACEHOLDER, hidePickerRow: true };
}

function named(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
