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
 * `startup()` calls this and returns the instantiation service. It does not
 * construct a part, register a view, or leave the old startup in the function.
 * The parts splash node is removed. The shell fills the viewport so the empty
 * window is a visible surface.
 */
export function openBlankWorkbench(parent: HTMLElement, container: HTMLElement, instantiationService: IInstantiationService): void {
	mainWindow.document.getElementById('monaco-parts-splash')?.remove();

	container.classList.add('monaco-workbench');
	// A relatively positioned empty div collapses to zero height, which is
	// hidden. Fixed inset fills the viewport and paints the shell background.
	const background = mainWindow.getComputedStyle(parent).backgroundColor;
	container.style.position = 'fixed';
	container.style.inset = '0';
	container.style.backgroundColor = background && background !== 'rgba(0, 0, 0, 0)' ? background : '#1e1e1e';
	parent.appendChild(container);

	instantiationService.invokeFunction(accessor => {
		const lifecycleService = accessor.get(ILifecycleService);
		mark('code/didStartWorkbench');
		lifecycleService.phase = LifecyclePhase.Restored;
		void accessor.get(INativeHostService).notifyReady();
	});
}
