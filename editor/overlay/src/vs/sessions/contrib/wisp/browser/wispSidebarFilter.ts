/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../../base/common/observable.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { WISP_NO_REPO_FILTER } from '../../providers/wisp/common/wispThreads.js';

/** The session header's repository crumb runs this (`sessionHeader.ts`, #302). */
export const WISP_FILTER_SIDEBAR_REPOSITORY = 'wisp.filterSidebarRepository';

/**
 * The repository the sidebar is limited to: a workspace URI, {@link WISP_NO_REPO_FILTER}, or
 * `undefined` for every repository. Clicking the same crumb again clears it.
 */
export const sidebarRepositoryFilter = observableValue<string | undefined>('wisp.sidebarRepositoryFilter', undefined);

export function toggleSidebarRepositoryFilter(key: string): void {
	sidebarRepositoryFilter.set(sidebarRepositoryFilter.get() === key ? undefined : key, undefined);
}

export function clearSidebarRepositoryFilter(): void {
	sidebarRepositoryFilter.set(undefined, undefined);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WISP_FILTER_SIDEBAR_REPOSITORY,
			title: localize2('wispSidebar.filterRepository', "Filter Sidebar by Repository"),
			f1: false,
		});
	}

	run(_accessor: ServicesAccessor, key?: unknown): void {
		if (typeof key === 'string' && key.length > 0) {
			toggleSidebarRepositoryFilter(key);
		}
	}
});
