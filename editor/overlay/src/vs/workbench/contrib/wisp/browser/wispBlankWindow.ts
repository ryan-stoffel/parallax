/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { mark } from '../../../../base/common/performance.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';

/**
 * Opens a window that has no workbench parts.
 *
 * The Agents window and the editor window call this from `startup()` and
 * return, so nothing after it runs: no part is constructed, no view is
 * registered, and the parts splash node is removed. The shell is the only
 * element added to the document.
 */
export function openBlankWorkbench(parent: HTMLElement, container: HTMLElement, instantiationService: IInstantiationService): void {
	mainWindow.document.getElementById('monaco-parts-splash')?.remove();

	container.classList.add('monaco-workbench');
	parent.appendChild(container);

	instantiationService.invokeFunction(accessor => {
		const lifecycleService = accessor.get(ILifecycleService);
		mark('code/didStartWorkbench');
		lifecycleService.phase = LifecyclePhase.Restored;
		void accessor.get(INativeHostService).notifyReady();
	});
}
