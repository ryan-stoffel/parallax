// Builds one mock page from URL parameters:
//   ?scene=<name>&theme=wisp-dark|wisp-light
// Scenes: setup-host, setup-agents, setup-repo, empty, model-picker, running, finished, error,
// settings-general, settings-providers. docs/design/chat-v2.md describes each one.
// Agents show as neutral monograms (CC, Cx, Cu), never a vendor's mark.
'use strict';

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'empty';
const theme = params.get('theme') ?? 'wisp-dark';

// Line icons drawn as inline SVG, in the spirit of codicons. No icon font, no emoji.
const ICON = {
	edit: '<path d="M3 13l1-3 7-7 2 2-7 7-3 1z"/>',
	search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
	plus: '<path d="M8 3v10M3 8h10"/>',
	folderPlus: '<path d="M2 4.5h4l1 1.5h7v6.5H2z"/><path d="M9.5 9h3M11 7.5v3"/>',
	folder: '<path d="M2 4.5h4l1 1.5h7v6.5H2z"/>',
	gear: '<circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4"/>',
	chevron: '<path d="M6 4l4 4-4 4"/>',
	down: '<path d="M4 6l4 4 4-4"/>',
	branch: '<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5c0 2-6 1.5-6 3"/>',
	worktree: '<path d="M3 3h4v4H3zM9 9h4v4H9z"/><path d="M5 7v3.5c0 .3.2.5.5.5H9"/>',
	server: '<rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><path d="M5 5h.01M5 11h.01"/>',
	monitor: '<rect x="2" y="3" width="12" height="8" rx="1"/><path d="M6 14h4M8 11v3"/>',
	more: '<path d="M4 8h.01M8 8h.01M12 8h.01"/>',
	arrowUp: '<path d="M8 13V3M4 7l4-4 4 4"/>',
	arrowRight: '<path d="M3 8h10M9 4l4 4-4 4"/>',
	check: '<path d="M3 8.5l3 3 7-7"/>',
	checkCircle: '<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.8 1.8 3.2-3.5"/>',
	sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
	panel: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
	code: '<path d="M6 4L2 8l4 4M10 4l4 4-4 4"/>',
	doc: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/>',
	lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>',
	eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
	star: '<path d="M8 2.2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/>',
	gauge: '<path d="M2.5 11a5.5 5.5 0 1111 0"/><path d="M8 11l2.5-3"/>',
	link: '<path d="M7 9l2-2M6 5.5l1-1a2.5 2.5 0 013.5 3.5l-1 1M10 10.5l-1 1a2.5 2.5 0 01-3.5-3.5l1-1"/>',
	sliders: '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.5"/><circle cx="10" cy="11" r="1.5"/>',
	box: '<path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11z"/><path d="M2.5 5L8 7.5 13.5 5M8 7.5v6"/>',
	file: '<path d="M4 2h5l3 3v9H4z"/>',
	terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10.5H11"/>',
	pencil: '<path d="M3 13l1-3 7-7 2 2-7 7-3 1z"/>',
	merge: '<circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="12" r="1.5"/><path d="M5 5.5v5M5 5.5c0 3 6 2 6 5"/>',
	info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.5V11M8 5h.01"/>',
	refresh: '<path d="M13 8a5 5 0 11-1.5-3.5M13 3v2.5h-2.5"/>',
};
const ic = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 16 16">${ICON[name]}</svg>`;
const mm = (text) => `<span class="mono-mark">${text}</span>`;

// Sidebar (wisp's own view): search and three actions, then Projects, Repositories, No Repo.
function sidebar({ selected = '', empty = false, extraThread = '' } = {}) {
	const top = `<div class="traffic"><span></span><span></span><span></span><span class="spacer"></span>${ic('sidebar')}</div>
		<div class="sbar"><div class="search">${ic('search')}Search<span class="kbd">&#8984;K</span></div>
			<span class="iconbtn" title="Add repository">${ic('folderPlus')}</span><span class="iconbtn" title="New chat">${ic('edit')}</span></div>`;
	const foot = `<div class="foot"><span class="avatar">RS</span><span class="grow"></span><span class="hostchip"><span class="dot connected"></span>this Mac</span><span class="iconbtn">${ic('gear')}</span></div>`;
	if (empty) {
		return `<div class="sidebar">${top}<div class="lists"><div class="sb-empty">No threads yet<span class="link">Start a chat</span></div></div>${foot}</div>`;
	}
	const thread = (name, age, mark = '') => `<div class="item thread${selected === name ? ' selected' : ''}"><span class="mark">${mark}</span><span class="name">${name}</span><span class="age">${age}</span></div>`;
	return `<div class="sidebar">${top}
		<div class="lists">
			<div class="sec">Projects<span class="tools">${ic('plus', 'sm')}</span></div>
			<div class="item"><span class="glyph">B</span><span class="name">billing-migration</span><span class="age">2m</span></div>
			<div class="sec">Repositories</div>
			<div class="item repo">${ic('folder', 'sm')}<span class="name">wisp</span></div>
			${extraThread}
			${thread('Fix the flaky attach test', selected === 'Fix the flaky attach test' && scene === 'running' ? 'now' : '4m', selected === 'Fix the flaky attach test' && scene === 'running' ? '<span class="dot running"></span>' : '')}
			${thread('Explain the LaunchAgent plist', '2d')}
			${thread('Add --json to wispd status', '1d', '<span class="dot failed"></span>')}
			<div class="item repo">${ic('folder', 'sm')}<span class="name">dotfiles</span></div>
			${thread('Audit macOS 27 defaults', '6d', '<span class="dot review"></span>')}
			<div class="sec">No Repo</div>
			${thread('Compare Stripe and Paddle fees', '1w')}
		</div>${foot}</div>`;
}

function header({ repo = 'wisp', title, state = '', actions = 'full' }) {
	const right = actions === 'none' ? '' : actions === 'new'
		? `<span class="hbtn dim">${ic('code', 'sm')}IDE</span><span class="iconbtn">${ic('panel')}</span>`
		: actions === 'settings'
			? `<span class="hbtn">${ic('refresh', 'sm')}Restore defaults</span>`
			: `<span class="hbtn">${ic('code', 'sm')}IDE</span>
				<span class="hbtn${actions === 'running' ? ' dim' : ''}">${ic('doc', 'sm')}Changes${actions === 'running' ? '' : ' <span class="added">+14</span> <span class="removed">-3</span>'}</span>
				<span class="hbtn${actions === 'finished' ? ' primary' : ' dim'}">${ic('merge', 'sm')}Accept<span class="split">${ic('down', 'sm')}</span></span>
				<span class="iconbtn">${ic('more')}</span><span class="iconbtn">${ic('panel')}</span>`;
	return `<div class="header"><div class="crumb"><span class="repo">${repo}</span><span class="sep">/</span><span class="title">${title}</span>${state}</div><span class="grow"></span>${right}</div>`;
}

// The composer: text, then model, effort, and permissions inside it; the workspace bar under it.
function composer({ placeholder, tall = false, sendState = 'off', focus = false, model = 'Opus 5.5', modelOpen = false, bar = true, branch = 'from develop', mode = 'New worktree' }) {
	const send = sendState === 'stop' ? '<span class="send stop" title="Stop"><i></i></span>' : `<span class="send${sendState === 'off' ? ' off' : ''}">${ic('arrowUp', 'sm')}</span>`;
	return `<div class="composer${tall ? ' tall' : ''}${focus ? ' focus' : ''}" id="composer">
			<div class="ph">${placeholder}</div>
			<div class="ctools">
				<span class="ctl${modelOpen ? ' on' : ''}" id="model">${mm('CC')}<span class="v">${model}</span>${ic('down', 'sm')}</span>
				<span class="ctl-sep"></span>
				<span class="ctl">${ic('gauge', 'sm')}<span class="v">Medium</span>${ic('down', 'sm')}</span>
				<span class="ctl-sep"></span>
				<span class="ctl">${ic('lock', 'sm')}<span class="v">Edit files</span>${ic('down', 'sm')}</span>
				<span class="grow"></span>${send}
			</div>
			${modelOpen ? modelPicker() : ''}
		</div>
		${bar ? `<div class="wbar"><span class="ctl">${ic('worktree', 'sm')}${mode}${ic('down', 'sm')}</span><span class="grow"></span><span class="ctl">${ic('branch', 'sm')}${branch}${ic('down', 'sm')}</span><span class="ctl">${ic('monitor', 'sm')}this Mac</span></div>` : ''}`;
}

function frame(side, card, overlay = '') {
	return `<div class="window">${side}<div class="main"><div class="card" id="session">${card}</div></div>${overlay}</div>`;
}

// First-run setup: a card over the empty window, three steps.
function setup(step) {
	const steps = ['Host', 'Providers', 'Repository'].map((label, index) => {
		const n = index + 1;
		const cls = n === step ? ' on' : n < step ? ' done' : '';
		return `<div class="step${cls}"><span class="n">${n < step ? ic('check', 'sm') : n}</span>${label}</div>`;
	}).join('');
	let body;
	if (step === 1) {
		body = `<h2>Where should agents run?</h2>
			<p>Wisp runs agents on a host: this Mac, or a machine you reach over SSH. You can add more later.</p>
			<div class="opt sel"><span class="radio on"></span>${ic('monitor', 'lg')}<span class="t"><b>This Mac</b><span>wispd is running, version 0.3.0</span></span><span class="r ok">${ic('check', 'sm')}Connected</span></div>
			<div class="opt"><span class="radio"></span>${ic('server', 'lg')}<span class="t"><b>A host over SSH</b><span>Uses your own ssh config, such as mac-mini or a dev box</span></span><span class="r">${ic('chevron', 'sm')}</span></div>
			<div class="setup-foot"><span class="grow"></span><span class="btn">Continue ${ic('arrowRight', 'sm')}</span></div>`;
	} else if (step === 2) {
		body = `<h2>Your coding CLIs</h2>
			<p>These are the coding CLIs Wisp found on this Mac. Wisp runs them with your own subscriptions.</p>
			<div class="opt sel">${mm('CC')}<span class="t"><b>Claude Code</b><span>Signed in with Claude Max · version 2.1.267</span></span><span class="r ok">${ic('check', 'sm')}Ready</span></div>
			<div class="opt">${mm('Cx')}<span class="t"><b>Codex</b><span>Signed in with ChatGPT Plus · version 0.157.1</span><span class="warn">Wisp can't run Codex agents yet. It will show here once it can.</span></span><span class="r">Not yet</span></div>
			<div class="opt">${mm('Cu')}<span class="t"><b>Cursor</b><span>Not installed on this Mac</span></span><span class="r" style="color:var(--vscode-textLink-foreground)">How to install</span></div>
			<div class="setup-foot"><span class="link">Back</span><span class="grow"></span><span class="btn">Continue ${ic('arrowRight', 'sm')}</span></div>`;
	} else {
		body = `<h2>Pick a repository</h2>
			<p>Each thread works in its own worktree of the repository, so your checkout stays as it is.</p>
			<div class="opt sel">${ic('folder', 'lg')}<span class="t"><b>wisp</b><span class="mono">~/Developer/personal/wisp · develop</span></span><span class="r ok">${ic('check', 'sm')}Git repository</span></div>
			<div class="opt">${ic('folderPlus', 'lg')}<span class="t"><b>Choose another folder on this Mac</b><span>Any git repository wispd can read</span></span><span class="r">${ic('chevron', 'sm')}</span></div>
			<div class="setup-foot"><span class="link">Skip, start a quick chat</span><span class="grow"></span><span class="btn">Start ${ic('arrowRight', 'sm')}</span></div>`;
	}
	const card = `<div class="setup"><div class="setup-top"><div class="brand"><span class="glyph">W</span>Welcome to Wisp</div><div class="steps">${steps}</div></div><div class="setup-body">${body}</div></div>`;
	return frame(sidebar({ empty: true }), '', `<div class="scrim">${card}</div>`);
}

function emptyThread({ picker = false } = {}) {
	const card = `${header({ title: 'New thread', actions: 'new' })}
		<div class="empty"><div class="dock-col" style="position:relative">
			<h1>What should we build in <span class="repo">wisp</span>?</h1>
			${composer({ placeholder: 'Describe a change or a task. Paste an error, a file, or a link.', tall: true, focus: true, modelOpen: picker })}
			<div class="note-line dock-note">${ic('info', 'sm')}<span>Your uncommitted changes stay in your checkout. The agent starts from <b style="font-weight:500;color:var(--vscode-foreground)">develop</b>.</span></div>
		</div></div>`;
	return frame(sidebar({ selected: 'New thread', extraThread: '<div class="item thread selected"><span class="mark"></span><span class="name">New thread</span><span class="age"></span></div>' }), card);
}

function modelPicker() {
	const row = (name, agent, fav, focused = false) => `<div class="mrow${focused ? ' focused' : ''}"><span class="t"><span>${name}</span><span class="s">${mm('CC')}${agent}</span></span><span class="grow"></span><span class="star${fav ? ' fav' : ''}">${ic('star')}</span></div>`;
	return `<div class="pop" style="left:8px;top:calc(100% - 6px);width:420px" id="picker"><div class="pbody">
		<div class="psearch">${ic('search')}Search models</div>
		<div class="sec" style="margin-top:4px">Favorites</div>
		${row('Opus 5.5', 'Claude Code', true, true)}
		<div class="sec">Claude Code</div>
		${row('Sonnet 5.5', 'Claude Code', false)}
		${row('Haiku 5', 'Claude Code', false)}
		<div class="mrow"><span class="t"><span>Older models</span><span class="s">4 models</span></span><span class="grow"></span>${ic('chevron')}</div>
		<div class="psep"></div>
		<div class="mrow off"><span class="t"><span>Codex</span><span class="s">${mm('Cx')}Wisp can't run Codex agents yet</span></span></div>
	</div><div class="pfoot">Default for new threads: Opus 5.5, Medium<span class="link">Manage providers</span></div></div>`;
}

const ask = `<div class="bubble">The attach test in <code>daemon/tests/attach.rs</code> fails about one run in ten on CI. Find out why and fix it.</div>`;
const firstWork = `<div class="work"><div class="work-head"><span class="chev">${ic('chevron', 'sm')}</span><b>Worked for 48s</b> · read 7 files, searched 3 times</div></div>`;
const firstReply = `<div class="reply"><p>The test connects as soon as it spawns wispd, before the socket exists. On a slow runner the first connect fails and the test doesn't retry. I'll make it wait for the ready line wispd prints, the way the smoke check already does.</p></div>`;

function running() {
	const card = `${header({ title: 'Fix the flaky attach test', state: '<span class="state"><span class="dot running"></span>Working</span>', actions: 'running' })}
		<div class="transcript"><div class="col">
			${ask}${firstWork}${firstReply}
			<div class="work"><div class="work-head"><span class="spin"></span><b>Working for 1m 06s</b> · edited 2 files · running <code>cargo test -p wispd --test attach</code></div></div>
		</div></div>
		<div class="dock"><div class="dock-col">${composer({ placeholder: 'Send a message to the agent. It reads it after its current step.', sendState: 'stop', branch: 'wisp/fix-flaky-attach-test', mode: 'Worktree' })}</div></div>`;
	return frame(sidebar({ selected: 'Fix the flaky attach test' }), card);
}

function finished() {
	const call = (icon, verb, subject, dur = '', extra = '') => `<div class="call">${ic(icon, 'sm')}<span class="verb">${verb}</span><span>${subject}</span>${extra}<span class="dur">${dur}</span></div>`;
	const card = `${header({ title: 'Fix the flaky attach test', state: '<span class="state"><span class="dot done"></span>Done</span>', actions: 'finished' })}
		<div class="transcript"><div class="col" style="gap:14px">
			${ask}${firstWork}${firstReply}
			<div class="work"><div class="work-head"><span class="chev open">${ic('chevron', 'sm')}</span><b>Worked for 2m 16s</b> · edited 2 files, ran 3 commands</div>
				<div class="work-list">
					${call('pencil', 'Edited', 'attach.rs', '', ' <span class="added">+12</span> <span class="removed">-3</span>')}
					${call('pencil', 'Edited', 'test_util.rs', '', ' <span class="added">+2</span>')}
					${call('terminal', 'Ran', '<code>cargo test -p wispd --test attach</code>', '41s', ' <span class="fail"><span class="dot failed"></span>1 failed</span>')}
					${call('pencil', 'Edited', 'attach.rs', '', ' <span class="added">+1</span> <span class="removed">-1</span>')}
					${call('terminal', 'Ran', '<code>cargo test -p wispd --test attach</code>', '38s')}
					<div class="output">running 4 tests
test attach_starts_wispd ... ok
test attach_reconnects ... ok
test result: ok. 4 passed; 0 failed; finished in 3.21s</div>
					${call('terminal', 'Ran', 'the attach tests 20 more times', '52s')}
				</div></div>
			<div class="reply"><p>Fixed. The test now waits for wispd's ready line before it connects, with a 10 second limit so a real hang still fails. It passed 20 runs in a row here.</p></div>
			<div class="done-row">
				<div class="done-line"><span class="ok">${ic('checkCircle', 'sm')}</span><b>Done in 3m 04s</b> · 2 files changed <span class="added">+14</span> <span class="removed">-3</span> · committed to <code>wisp/fix-flaky-attach-test</code></div>
				<div class="files"><span class="file">${ic('file', 'sm')}daemon/tests/attach.rs <span class="added">+12</span> <span class="removed">-3</span></span><span class="file">${ic('file', 'sm')}daemon/tests/test_util.rs <span class="added">+2</span></span></div>
				<div class="done-actions"><span class="btn">Review changes</span><span class="btn secondary">${ic('code', 'sm')}Open in IDE</span></div>
			</div>
		</div></div>
		<div class="dock"><div class="dock-col">${composer({ placeholder: 'Ask for follow-up changes', branch: 'wisp/fix-flaky-attach-test', mode: 'Worktree' })}</div></div>`;
	return frame(sidebar({ selected: 'Fix the flaky attach test' }), card);
}

function error() {
	const card = `${header({ title: 'Add --json to wispd status', state: '<span class="state"><span class="dot failed"></span>Couldn\'t start</span>', actions: 'running' })}
		<div class="transcript"><div class="col">
			<div class="bubble">Add a <code>--json</code> flag to <code>wispd status</code> that prints the same fields as the table.</div>
			<div class="error"><span class="mk"><span class="dot failed"></span></span><div>
				<h4>Claude Code isn't signed in on this Mac.</h4>
				<p>The agent couldn't start, and nothing in your repository changed. Sign in, then try again.</p>
				<div class="done-actions"><span class="btn">Sign in to Claude Code</span><span class="btn secondary">Try again</span><span class="btn ghost">${ic('chevron', 'sm')}Details</span></div>
			</div></div>
		</div></div>
		<div class="dock"><div class="dock-col">${composer({ placeholder: 'Edit your message or send a new one', branch: 'from develop' })}</div></div>`;
	return frame(sidebar({ selected: 'Add --json to wispd status' }), card);
}

function settingsNav(active) {
	const item = (icon, label) => `<div class="item${label === active ? ' selected' : ''}">${ic(icon)}<span class="name">${label}</span></div>`;
	return `<div class="snav">${item('sliders', 'General')}${item('box', 'Providers')}${item('server', 'Hosts')}${item('doc', 'Shared context')}</div>`;
}

function settingsGeneral() {
	const sel = (content) => `<span class="select">${content}<span class="chev">${ic('chevron', 'sm')}</span></span>`;
	const card = `${header({ repo: 'Settings', title: 'General', actions: 'settings', state: '<span class="state">' + ic('monitor', 'sm') + 'this Mac</span>' })}
		<div class="settings">${settingsNav('General')}<div class="spage">
			<h3>New threads</h3>
			<div class="group">
				<div class="row"><span class="t"><b>Agent and model</b><span>Used for every new thread. Change it for one thread from the composer.</span></span>${sel(mm('CC') + 'Opus 5.5')}${sel('Medium')}</div>
				<div class="row"><span class="t"><b>Permissions</b><span>Edit files lets the agent edit its worktree and run commands in its sandbox. Read only answers and plans without changing anything.</span></span>${sel(ic('lock', 'sm') + 'Edit files')}</div>
				<div class="row"><span class="t"><b>Workspace</b><span>Where a new thread's agent works.</span></span>${sel(ic('worktree', 'sm') + 'New worktree')}</div>
				<div class="row"><span class="t"><b>Start from</b><span>The branch a new worktree starts from.</span></span>${sel(ic('branch', 'sm') + 'The checkout\'s current branch')}</div>
			</div>
			<h3>Notifications</h3>
			<div class="group">
				<div class="row"><span class="t"><b>When a thread finishes</b><span>Show a macOS notification when an agent is done or stops with an error.</span></span><span class="toggle on"></span></div>
			</div>
			<h3>Sidebar</h3>
			<div class="group">
				<div class="row"><span class="t"><b>Show archived threads</b><span>List archived threads under their repository, dimmed.</span></span><span class="toggle"></span></div>
			</div>
		</div></div>`;
	return frame(sidebar({}), card);
}

function settingsProviders() {
	const card = `${header({ repo: 'Settings', title: 'Providers', actions: 'none', state: '<span class="state">' + ic('monitor', 'sm') + 'this Mac · checked just now</span>' })}
		<div class="settings">${settingsNav('Providers')}<div class="spage">
			<h3>Coding CLIs on this Mac</h3>
			<div class="prov">
				<div class="plist">
					<div class="pitem sel">${mm('CC')}<span class="t"><b>Claude Code<span class="mono">2.1.267</span></b><span>Signed in · Claude Max · Ready</span></span><span class="toggle on"></span></div>
					<div class="pitem">${mm('Cx')}<span class="t"><b>Codex<span class="mono">0.157.1</span></b><span>Signed in · ChatGPT Plus · Can't run agents in Wisp yet</span></span><span class="toggle off"></span></div>
					<div class="pitem">${mm('Cu')}<span class="t"><b>Cursor</b><span>Not installed</span></span><span class="toggle off"></span></div>
				</div>
				<div class="pdetail">
					<div class="dh">${mm('CC')}Claude Code<span class="mono">2.1.267</span></div>
					<div class="group">
						<div class="row"><span class="t"><b>Account</b><span>Signed in with a Claude Max subscription. Wisp uses the CLI's own sign-in and never sees your password.</span></span><span class="btn secondary">Switch account</span></div>
						<div class="row"><span class="t"><b>Version</b><span>2.1.267. Wisp needs 2.1.248 or newer to run agents.</span></span><span class="status-ok">${ic('check', 'sm')}Up to date</span></div>
						<div class="row"><span class="t"><b>Use for</b><span>New threads and subagents default to this CLI.</span></span><span class="select">Threads and subagents<span class="chev">${ic('chevron', 'sm')}</span></span></div>
					</div>
					<h3>Runtime</h3>
					<div class="group">
						<div class="row"><span class="t"><b>Program</b><span>Found on this Mac's PATH.</span></span><span class="field mono">/opt/homebrew/bin/claude</span></div>
						<div class="row"><span class="t"><b>Config folder</b><span>Where the CLI keeps its sign-in and settings.</span></span><span class="field mono">~/.claude</span></div>
					</div>
				</div>
			</div>
			<h3>API keys</h3>
			<div class="group" style="max-width:1000px"><div class="inline-err">${ic('info', 'sm')}<span><b>This Mac's wispd is older than this Wisp.</b> Update wispd to add API keys and see usage. Your subscriptions work as they are.</span><span class="grow"></span><span class="btn secondary">Update wispd</span></div></div>
		</div></div>`;
	return frame(sidebar({}), card);
}

const scenes = {
	'setup-host': () => setup(1),
	'setup-agents': () => setup(2),
	'setup-repo': () => setup(3),
	empty: () => emptyThread(),
	'model-picker': () => emptyThread({ picker: true }),
	running,
	finished,
	error,
	'settings-general': settingsGeneral,
	'settings-providers': settingsProviders,
};

const base = theme === 'wisp-light' ? 'theme-light-modern' : 'theme-dark-modern';
document.body.className = `${base} theme-${theme}`;
document.getElementById('root').innerHTML = scenes[scene]();
document.body.dataset.ready = 'true';
