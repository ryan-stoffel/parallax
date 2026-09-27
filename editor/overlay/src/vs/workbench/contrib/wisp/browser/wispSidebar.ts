/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { isMacintosh } from '../../../../base/common/platform.js';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * The first sidebar. Search, New Thread, the project plus, and the footer icons
 * are visible and do nothing. The hide/show control and the section headers work.
 * Lists stay empty. Closing slides the sidebar off the left edge. The button stays.
 */
export function mountSidebar(shell: HTMLElement): void {
	shell.classList.add('wisp-shell');
	if (isMacintosh) {
		shell.classList.add('wisp-platform-mac');
	}
	const style = mainWindow.document.createElement('style');
	style.className = 'wisp-sidebar-styles';
	style.textContent = SIDEBAR_CSS;
	mainWindow.document.head.appendChild(style);

	const toggle = button('wisp-sidebar-toggle', 'Hide sidebar');
	toggle.dataset.wispSidebarToggle = '';
	toggle.append(icon(SIDEBAR_ICON));

	const sidebar = el('aside', 'wisp-sidebar');
	const main = el('div', 'wisp-main');
	const title = el('div', 'wisp-sidebar-title');
	const name = el('span', 'wisp-sidebar-name');
	name.dataset.wispAppName = '';
	name.textContent = 'Wisp';
	title.append(name);

	const body = el('div', 'wisp-sidebar-body');
	body.append(
		searchField(),
		newThreadButton(),
		section('projects', 'Projects', true, false),
		section('threads', 'Threads (0)', false, true),
	);

	const footer = el('div', 'wisp-sidebar-footer');
	footer.append(
		footerButton('Profile', avatar()),
		footerButton('Settings', icon(GEAR_ICON)),
		footerButton('Usage', bars()),
		el('span', 'wisp-sidebar-footer-spacer'),
		footerButton('Updates', icon(UPDATES_ICON)),
	);

	sidebar.append(title, body, section('settled', 'Settled (0)', false, true), footer);
	shell.append(toggle, sidebar, main);

	let open = true;
	toggle.setAttribute('aria-expanded', 'true');
	toggle.addEventListener('click', () => {
		open = !open;
		shell.classList.toggle('is-closed', !open);
		sidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
		toggle.setAttribute('aria-expanded', String(open));
		toggle.setAttribute('aria-label', open ? 'Hide sidebar' : 'Show sidebar');
	});
}

function searchField(): HTMLElement {
	const field = el('label', 'wisp-search');
	field.append(icon(SEARCH_ICON));
	const input = mainWindow.document.createElement('input');
	input.type = 'text';
	input.placeholder = 'Search';
	input.autocomplete = 'off';
	input.spellcheck = false;
	input.setAttribute('aria-label', 'Search');
	input.dataset.wispSearch = '';
	field.append(input);
	return field;
}

function newThreadButton(): HTMLButtonElement {
	const control = button('wisp-new-thread', 'New Thread');
	control.dataset.wispNewThread = '';
	control.append(icon(PLUS_ICON));
	const label = el('span', 'wisp-new-thread-label');
	label.textContent = 'New Thread';
	control.append(label);
	return control;
}

function section(id: string, label: string, plus: boolean, ruled: boolean): HTMLElement {
	const root = el('section', ruled ? 'wisp-section is-ruled' : 'wisp-section');
	root.dataset.wispSection = id;
	const row = el('div', 'wisp-section-row');
	const toggle = button('wisp-section-toggle', label);
	toggle.dataset.wispSectionToggle = '';
	toggle.setAttribute('aria-expanded', 'true');
	const chevron = el('span', 'wisp-chevron is-always');
	chevron.append(icon(CHEVRON_ICON));
	const text = el('span', 'wisp-section-text');
	text.textContent = label;
	if (ruled) {
		const line = el('span', 'wisp-section-line');
		toggle.append(text, line, chevron);
	} else {
		toggle.append(text, chevron);
	}
	row.append(toggle);
	if (plus) {
		const add = button('wisp-section-plus', 'New project');
		add.dataset.wispPlus = '';
		add.append(icon(PLUS_ICON));
		row.append(add);
	}
	const list = el('div', 'wisp-section-list');
	list.dataset.wispSectionList = '';
	root.append(row, list);

	let expanded = true;
	const direction = (): string => expanded ? 'down' : 'up';
	const paint = (): void => {
		const pointing = direction();
		root.dataset.chevron = pointing;
		chevron.dataset.direction = pointing;
		list.hidden = !expanded;
		toggle.setAttribute('aria-expanded', String(expanded));
	};
	paint();
	toggle.addEventListener('click', () => {
		expanded = !expanded;
		paint();
	});
	return root;
}

function footerButton(label: string, graphic: SVGSVGElement): HTMLButtonElement {
	const control = button('wisp-footer-button', label);
	control.dataset.wispFooter = label;
	control.append(graphic);
	return control;
}

function button(className: string, label: string): HTMLButtonElement {
	const control = mainWindow.document.createElement('button');
	control.type = 'button';
	control.className = className;
	control.setAttribute('aria-label', label);
	return control;
}

function el(tag: string, className: string): HTMLElement {
	const node = mainWindow.document.createElement(tag);
	node.className = className;
	return node;
}

function icon(paths: readonly string[]): SVGSVGElement {
	const graphic = mainWindow.document.createElementNS(SVG, 'svg');
	graphic.setAttribute('viewBox', '0 0 24 24');
	graphic.setAttribute('fill', 'none');
	graphic.setAttribute('stroke', 'currentColor');
	graphic.setAttribute('stroke-width', '1.75');
	graphic.setAttribute('stroke-linecap', 'round');
	graphic.setAttribute('stroke-linejoin', 'round');
	graphic.setAttribute('aria-hidden', 'true');
	for (const d of paths) {
		const path = mainWindow.document.createElementNS(SVG, 'path');
		path.setAttribute('d', d);
		graphic.append(path);
	}
	return graphic;
}

function avatar(): SVGSVGElement {
	const graphic = mainWindow.document.createElementNS(SVG, 'svg');
	graphic.setAttribute('viewBox', '0 0 16 16');
	graphic.setAttribute('aria-hidden', 'true');
	const ring = mainWindow.document.createElementNS(SVG, 'circle');
	ring.setAttribute('cx', '8');
	ring.setAttribute('cy', '8');
	ring.setAttribute('r', '6.25');
	ring.setAttribute('fill', 'none');
	ring.setAttribute('stroke', 'currentColor');
	ring.setAttribute('stroke-width', '1.4');
	graphic.append(ring);
	return graphic;
}

function bars(): SVGSVGElement {
	const graphic = mainWindow.document.createElementNS(SVG, 'svg');
	graphic.setAttribute('viewBox', '0 0 16 16');
	graphic.setAttribute('aria-hidden', 'true');
	for (const [x, y, width, height] of [[1.6, 9, 3, 5], [6.5, 5.5, 3, 8.5], [11.4, 2.5, 3, 11.5]] as const) {
		const rect = mainWindow.document.createElementNS(SVG, 'rect');
		rect.setAttribute('x', String(x));
		rect.setAttribute('y', String(y));
		rect.setAttribute('width', String(width));
		rect.setAttribute('height', String(height));
		rect.setAttribute('rx', '0.7');
		rect.setAttribute('fill', 'currentColor');
		graphic.append(rect);
	}
	return graphic;
}

const SIDEBAR_ICON = [
	'M5 3.5h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z',
	'M9 3.5v17',
];
const SEARCH_ICON = [
	'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
	'M21 21l-4.3-4.3',
];
const PLUS_ICON = ['M12 5v14', 'M5 12h14'];
const CHEVRON_ICON = ['M6 9l6 6 6-6'];
const GEAR_ICON = [
	'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
	'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
];
const UPDATES_ICON = [
	'M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
	'M3 3v5h5',
	'M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16',
	'M16 16h5v5',
];

const SIDEBAR_CSS = `
.wisp-shell {
	position: relative;
	display: flex;
	box-sizing: border-box;
	height: 100%;
	overflow: hidden;
	background: var(--wisp-main);
	color: var(--wisp-text);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 13px;
	line-height: 1.3;
	user-select: none;
}
.wisp-shell[data-appearance="dark"] {
	--wisp-sidebar: #000000;
	--wisp-main: #0A0A0A;
	--wisp-text: #ECECEC;
	--wisp-muted: #8D8D8D;
	--wisp-faint: #6F6F6F;
	--wisp-field: #141414;
	--wisp-line: #3A3A3A;
	--wisp-edge: #3A3A3A;
	--wisp-hover: #1A1A1A;
	--wisp-icon: #C6C6C6;
	color-scheme: dark;
}
.wisp-shell[data-appearance="light"] {
	--wisp-sidebar: #FFFFFF;
	--wisp-main: #FDFDFD;
	--wisp-text: #1C1C1C;
	--wisp-muted: #6E6E6E;
	--wisp-faint: #8A8A8A;
	--wisp-field: #F5F5F5;
	--wisp-line: #E3E3E3;
	--wisp-edge: #D0D0D0;
	--wisp-hover: #F2F2F2;
	--wisp-icon: #3C3C3C;
	color-scheme: light;
}
.wisp-shell *, .wisp-shell *::before, .wisp-shell *::after { box-sizing: border-box; }
.wisp-sidebar {
	position: absolute;
	z-index: 1;
	top: 0;
	bottom: 0;
	left: 0;
	display: flex;
	flex-direction: column;
	width: 260px;
	background: var(--wisp-sidebar);
	color: var(--wisp-text);
	border-right: 1px solid var(--wisp-edge);
	transform: translateX(0);
	transition: transform 80ms linear;
}
.wisp-shell.is-closed .wisp-sidebar { transform: translateX(-100%); }
.wisp-main {
	flex: 1 1 auto;
	min-width: 0;
	margin-left: 260px;
	background: var(--wisp-main);
	-webkit-app-region: drag;
}
.wisp-shell.is-closed .wisp-main { margin-left: 0; }
.wisp-sidebar-title {
	display: flex;
	align-items: center;
	height: 40px;
	padding: 0 12px 0 46px;
	flex: 0 0 auto;
	-webkit-app-region: drag;
}
.wisp-platform-mac .wisp-sidebar-title { padding-left: 114px; }
.wisp-sidebar-title span { -webkit-app-region: no-drag; }
.wisp-sidebar-toggle {
	position: absolute;
	z-index: 2;
	top: 6px;
	left: 10px;
	-webkit-app-region: no-drag;
}
.wisp-platform-mac .wisp-sidebar-toggle { left: 78px; }
.wisp-sidebar-toggle, .wisp-section-plus, .wisp-footer-button, .wisp-section-toggle, .wisp-new-thread {
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	padding: 0;
}
.wisp-sidebar-toggle, .wisp-section-toggle { cursor: pointer; }
.wisp-new-thread, .wisp-section-plus, .wisp-footer-button, .wisp-search input { cursor: default; }
.wisp-sidebar-toggle, .wisp-section-plus, .wisp-footer-button {
	display: grid;
	place-items: center;
	width: 28px;
	height: 28px;
	border-radius: 6px;
	color: var(--wisp-icon);
}
.wisp-sidebar-toggle:hover, .wisp-section-plus:hover, .wisp-footer-button:hover {
	background: var(--wisp-hover);
}
.wisp-sidebar-toggle svg, .wisp-search svg, .wisp-new-thread svg, .wisp-section-plus svg, .wisp-footer-button svg {
	width: 16px;
	height: 16px;
	display: block;
}
.wisp-sidebar-name {
	font-size: 13px;
	font-weight: 600;
	letter-spacing: -0.01em;
}
.wisp-sidebar-body {
	display: flex;
	flex-direction: column;
	flex: 1 1 auto;
	min-height: 0;
	overflow: auto;
	padding-bottom: 8px;
}
.wisp-search {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 32px;
	margin: 6px 12px 8px;
	padding: 0 10px;
	border-radius: 8px;
	background: var(--wisp-field);
	color: var(--wisp-faint);
}
.wisp-search input {
	flex: 1 1 auto;
	min-width: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: var(--wisp-text);
	font: inherit;
	user-select: text;
}
.wisp-search input::placeholder { color: var(--wisp-faint); }
.wisp-new-thread {
	display: flex;
	align-items: center;
	gap: 8px;
	height: 32px;
	margin: 0 12px 14px;
	padding: 0 10px;
	border-radius: 8px;
	background: var(--wisp-field);
	color: var(--wisp-text);
	text-align: left;
}
.wisp-section { margin: 0 8px 2px; flex: 0 0 auto; }
.wisp-section-row { display: flex; align-items: center; min-height: 28px; }
.wisp-section-toggle {
	display: flex;
	align-items: center;
	gap: 4px;
	min-height: 28px;
	padding: 0 6px;
	border-radius: 0;
	background: transparent;
	color: var(--wisp-muted);
	font-size: 12px;
	font-weight: 500;
}
.wisp-section-toggle:hover, .wisp-section-toggle:focus-visible { background: transparent; }
.wisp-section:not(.is-ruled) .wisp-section-toggle { flex: 0 1 auto; }
.wisp-section.is-ruled .wisp-section-toggle { width: 100%; }
.wisp-section-text { white-space: nowrap; }
.wisp-chevron {
	display: grid;
	place-items: center;
	width: 12px;
	height: 12px;
	flex: 0 0 12px;
	opacity: 1;
}
.wisp-chevron svg { width: 12px; height: 12px; display: block; }
.wisp-chevron[data-direction="down"] { transform: none; }
.wisp-chevron[data-direction="up"] { transform: rotate(180deg); }
.wisp-section-plus { margin-left: auto; color: var(--wisp-muted); }
.wisp-section-line { flex: 1 1 auto; height: 1px; margin: 0 8px; background: var(--wisp-line); }
.wisp-section-list[hidden] { display: none; }
.wisp-sidebar-footer {
	display: flex;
	align-items: center;
	gap: 2px;
	flex: 0 0 auto;
	padding: 8px 10px 10px;
}
.wisp-sidebar-footer-spacer { flex: 1 1 auto; }
.wisp-footer-button[data-wisp-footer="Profile"] svg { width: 18px; height: 18px; }
`;
