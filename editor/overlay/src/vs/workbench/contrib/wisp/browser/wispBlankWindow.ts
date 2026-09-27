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
 * The parts splash node is removed. The shell fills the viewport and follows
 * the OS appearance: pure black in dark mode, pure white in light mode.
 */
export function openBlankWorkbench(parent: HTMLElement, container: HTMLElement, instantiationService: IInstantiationService): void {
	mainWindow.document.getElementById('monaco-parts-splash')?.remove();

	container.classList.add('monaco-workbench');
	// A relatively positioned empty div collapses to zero height, which is
	// hidden. Fixed inset fills the viewport.
	container.style.position = 'fixed';
	container.style.inset = '0';
	paintAppearance(parent, container);
	parent.appendChild(container);

	const query = mainWindow.matchMedia('(prefers-color-scheme: dark)');
	query.addEventListener('change', () => paintAppearance(parent, container));

	instantiationService.invokeFunction(accessor => {
		const lifecycleService = accessor.get(ILifecycleService);
		mark('code/didStartWorkbench');
		lifecycleService.phase = LifecyclePhase.Restored;
		void accessor.get(INativeHostService).notifyReady();
	});
}

function paintAppearance(parent: HTMLElement, container: HTMLElement): void {
	const dark = mainWindow.matchMedia('(prefers-color-scheme: dark)').matches;
	const background = dark ? '#000000' : '#ffffff';
	const foreground = dark ? '#ffffff' : '#000000';
	const { documentElement, body, head } = mainWindow.document;
	documentElement.style.backgroundColor = background;
	body.style.backgroundColor = background;
	body.style.color = foreground;
	parent.style.backgroundColor = background;
	container.style.backgroundColor = background;
	const initial = head.querySelector('.initialShellColors');
	if (initial) {
		initial.textContent = `html, body { background-color: ${background}; color: ${foreground}; margin: 0; padding: 0; }`;
	}
}
