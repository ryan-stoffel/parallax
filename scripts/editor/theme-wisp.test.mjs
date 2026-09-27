import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extension = join(repo, 'editor/overlay/extensions/theme-wisp');

/** Tokens from docs/design/chat-v2/src/wisp-theme.css (#271). Alpha is the nearest 8-bit hex. */
const spec = {
	dark: {
		'modernUI.shellBackground': '#111113',
		'sideBar.background': '#111113',
		'sideBar.foreground': '#e4e4e7',
		'activeSessionView.background': '#18181b',
		'activeSessionView.foreground': '#e4e4e7',
		'agentsPanel.background': '#18181b',
		'agentsPanel.foreground': '#e4e4e7',
		'agentsPanel.border': '#232327',
		'agentsCard.border': '#202024',
		foreground: '#e4e4e7',
		'icon.foreground': '#c4c4ca',
		descriptionForeground: '#9696a0',
		'agentsChatInput.background': '#1f1f23',
		'agentsChatInput.border': '#2c2c31',
		'agentsChatInput.foreground': '#e4e4e7',
		'agentsChatInput.placeholderForeground': '#85858f',
		'agentsNewSessionButton.border': '#2c2c31',
		'widget.border': '#27272c',
		'sideBarSectionHeader.border': '#1f1f23',
		'list.inactiveSelectionBackground': '#26262b',
		'list.hoverBackground': '#1e1e22',
		'editorWidget.background': '#1c1c20',
		'quickInput.background': '#1c1c20',
		'quickInputList.focusBackground': '#2b2840',
		'quickInputList.focusForeground': '#ffffff',
		'chat.requestBubbleBackground': '#26262b',
		'chat.statusBackground': '#e4e4e70f',
		'button.background': '#6c5ce7',
		'button.foreground': '#ffffff',
		'button.border': '#ffffff14',
		'button.secondaryBackground': '#26262b',
		'button.secondaryBorder': '#2f2f35',
		'agentsBadge.background': '#6c5ce7',
		focusBorder: '#8b7ff0',
		'textLink.foreground': '#a99ff7',
		'textPreformat.background': '#26262b',
		'agentStatusIndicator.background': '#e4e4e70f',
	},
	light: {
		'modernUI.shellBackground': '#f4f4f5',
		'sideBar.background': '#f4f4f5',
		'sideBar.foreground': '#1c1c20',
		'activeSessionView.background': '#ffffff',
		'activeSessionView.foreground': '#1c1c20',
		'agentsPanel.background': '#ffffff',
		'agentsPanel.foreground': '#1c1c20',
		'agentsPanel.border': '#ebebee',
		'agentsCard.border': '#e4e4e8',
		foreground: '#1c1c20',
		'icon.foreground': '#3f3f46',
		descriptionForeground: '#66666f',
		'agentsChatInput.background': '#ffffff',
		'agentsChatInput.border': '#dcdce1',
		'agentsChatInput.foreground': '#1c1c20',
		'agentsChatInput.placeholderForeground': '#75757e',
		'agentsNewSessionButton.border': '#dcdce1',
		'widget.border': '#e4e4e8',
		'sideBarSectionHeader.border': '#e4e4e8',
		'list.inactiveSelectionBackground': '#e7e7eb',
		'list.hoverBackground': '#ededf0',
		'editorWidget.background': '#fafafa',
		'quickInput.background': '#ffffff',
		'quickInputList.focusBackground': '#ecebfb',
		'quickInputList.focusForeground': '#1c1c20',
		'chat.requestBubbleBackground': '#f0f0f3',
		'chat.statusBackground': '#1c1c200d',
		'button.background': '#5b4ad6',
		'button.foreground': '#ffffff',
		'button.secondaryBackground': '#f0f0f3',
		'button.secondaryBorder': '#dcdce1',
		'button.secondaryForeground': '#1c1c20',
		'agentsBadge.background': '#5b4ad6',
		focusBorder: '#5b4ad6',
		'textLink.foreground': '#5b4ad6',
		'textPreformat.background': '#f0f0f3',
		'textPreformat.foreground': '#1c1c20',
		'agentStatusIndicator.background': '#1c1c200d',
	},
};

/** Real chrome the mock CSS never paints. Hover stays on the accent and still clears 4.5:1. */
const extras = {
	dark: {
		'modernUI.inactiveShellBackground': '#111113',
		'titleBar.activeBackground': '#111113',
		'titleBar.inactiveBackground': '#111113',
		'button.hoverBackground': '#7061e8',
	},
	light: {
		'modernUI.inactiveShellBackground': '#f4f4f5',
		'titleBar.activeBackground': '#f4f4f5',
		'titleBar.inactiveBackground': '#f4f4f5',
		'button.hoverBackground': '#5444c5',
	},
};

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function channel(hex, index) {
	return parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
}

function luminance(hex) {
	const linear = (value) => {
		const amount = value / 255;
		return amount <= 0.04045 ? amount / 12.92 : ((amount + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(channel(hex, 0)) + 0.7152 * linear(channel(hex, 1)) + 0.0722 * linear(channel(hex, 2));
}

function contrast(foreground, background) {
	const lighter = Math.max(luminance(foreground), luminance(background));
	const darker = Math.min(luminance(foreground), luminance(background));
	return (lighter + 0.05) / (darker + 0.05);
}

test('Wisp Dark and Wisp Light contribute the spec colors on top of the Modern themes', () => {
	const manifest = readJson(join(extension, 'package.json'));
	const themes = manifest.contributes.themes;
	assert.deepEqual(themes.map((theme) => theme.id), ['Wisp Dark', 'Wisp Light']);
	assert.deepEqual(themes.map((theme) => theme.uiTheme), ['vs-dark', 'vs']);

	const dark = readJson(join(extension, 'themes/wisp-dark.json'));
	const light = readJson(join(extension, 'themes/wisp-light.json'));
	assert.equal(dark.include, '../../theme-defaults/themes/dark_modern.json');
	assert.equal(light.include, '../../theme-defaults/themes/light_modern.json');
	assert.deepEqual(dark.colors, { ...spec.dark, ...extras.dark });
	assert.deepEqual(light.colors, { ...spec.light, ...extras.light });
});

test('white button text on the accent meets 4.5:1 at rest and on hover', () => {
	for (const name of ['dark', 'light']) {
		const colors = { ...spec[name], ...extras[name] };
		for (const background of ['button.background', 'button.hoverBackground']) {
			const ratio = contrast(colors['button.foreground'], colors[background]);
			assert.ok(ratio >= 4.5, `${name} ${background} is ${ratio.toFixed(2)}:1`);
		}
	}
});

test('both windows default a new install to Wisp Dark and keep a chosen theme', () => {
	const theme = readFileSync(join(repo, 'editor/overlay/src/vs/platform/wisp/common/wispTheme.ts'), 'utf8');
	assert.match(theme, /registerDefaultConfigurations/);
	assert.match(theme, /'workbench\.colorTheme': WISP_DARK_THEME_ID/);
	assert.match(theme, /'workbench\.preferredDarkColorTheme': WISP_DARK_THEME_ID/);
	assert.match(theme, /'workbench\.preferredLightColorTheme': WISP_LIGHT_THEME_ID/);

	for (const contribution of [
		'editor/overlay/src/vs/workbench/contrib/wisp/browser/wisp.contribution.ts',
		'editor/overlay/src/vs/sessions/contrib/wisp/browser/wisp.sessions.contribution.ts',
	]) {
		const source = readFileSync(join(repo, contribution), 'utf8');
		assert.match(source, /platform\/wisp\/common\/wispTheme\.js/, contribution);
	}
});
