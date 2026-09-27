import { assertBlankWindow } from './blankWindow.ts';
import type { Scenario } from './harness.ts';
import { captureNativeWindow } from './nativeCapture.ts';

export const scenarios: readonly Scenario[] = [
	{
		name: 'startup',
		title: 'Blank window',
		async run({ app, window }) {
			await assertBlankWindow(app, window);
			return captureNativeWindow(app, window);
		},
	},
];
