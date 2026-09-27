// A plain launch opens a window with no workbench parts (#316).
import { check } from '../check.ts';
import { launchSmoke, ready } from '../harness.ts';

const removedChrome = [
	'.part',
	'.part.titlebar',
	'.part.activitybar',
	'.part.sidebar',
	'.part.panel',
	'.part.statusbar',
	'.tabs-container',
	'.command-center',
	'.monaco-parts-splash',
	'textarea',
	'h1',
	'h2',
];

export const agentsWindowChecks = [
	check('plain launch opens a blank window', async () => {
		const session = await launchSmoke();
		try {
			const { app, window } = session;
			await ready({ app, window });

			for (const selector of removedChrome) {
				const count = await window.locator(selector).count();
				if (count !== 0) {
					throw new Error(`${selector} is still in the document (${String(count)})`);
				}
			}
		} finally {
			await session.close();
		}
	}),
];
