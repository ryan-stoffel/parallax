/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { mark } from '../../../../base/common/performance.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { mountSidebar } from './wispSidebar.js';

/**
 * Opens a window that has no workbench parts.
 *
 * `startup()` calls this and returns the instantiation service. It does not
 * construct a part, register a view, or leave the old startup in the function.
 * The parts splash node is removed. The shell is the sidebar and an empty
 * main area, and it follows the OS appearance.
 */
export function openBlankWorkbench(parent: HTMLElement, container: HTMLElement, instantiationService: IInstantiationService): void {
	mainWindow.document.getElementById('monaco-parts-splash')?.remove();

	container.classList.add('monaco-workbench');
	// A relatively positioned empty div collapses to zero height, which is
	// hidden. Fixed inset fills the viewport.
	container.style.position = 'fixed';
	container.style.inset = '0';
	mountSidebar(container);
	const query = mainWindow.matchMedia('(prefers-color-scheme: dark)');
	// The page media query paints the first frame. After the native theme
	// reports, it owns the color: setting themeSource updates
	// shouldUseDarkColors without the media query always following (#316).
	let nativeKnown = false;
	paintAppearance(parent, container, query.matches);
	parent.appendChild(container);
	query.addEventListener('change', () => {
		if (!nativeKnown) {
			paintAppearance(parent, container, query.matches);
		}
	});

	instantiationService.invokeFunction(accessor => {
		const nativeHostService = accessor.get(INativeHostService);
		const lifecycleService = accessor.get(ILifecycleService);
		let epoch = 0;
		const applyNative = (dark: boolean): void => {
			epoch++;
			nativeKnown = true;
			paintAppearance(parent, container, dark);
		};
		nativeHostService.onDidChangeColorScheme(scheme => applyNative(scheme.dark));
		const epochAtRequest = epoch;
		void nativeHostService.getOSColorScheme().then(scheme => {
			if (epoch === epochAtRequest) {
				nativeKnown = true;
				paintAppearance(parent, container, scheme.dark);
			}
		});
		mark('code/didStartWorkbench');
		lifecycleService.phase = LifecyclePhase.Restored;
		void nativeHostService.notifyReady();
	});
}

function paintAppearance(parent: HTMLElement, container: HTMLElement, dark: boolean): void {
	const main = dark ? '#0A0A0A' : '#FDFDFD';
	const foreground = dark ? '#ECECEC' : '#1C1C1C';
	container.dataset.appearance = dark ? 'dark' : 'light';
	const { documentElement, body, head } = mainWindow.document;
	documentElement.style.backgroundColor = main;
	body.style.backgroundColor = main;
	body.style.color = foreground;
	parent.style.backgroundColor = main;
	container.style.backgroundColor = main;
	const initial = head.querySelector('.initialShellColors');
	if (initial) {
		initial.textContent = `html, body { background-color: ${main}; color: ${foreground}; margin: 0; padding: 0; }`;
	}
}
