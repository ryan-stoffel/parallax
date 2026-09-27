/*---------------------------------------------------------------------------------------------
 *  wisp: not part of Code - OSS. Edit editor/overlay in the wisp repo, not this copy.
 *--------------------------------------------------------------------------------------------*/

// Upstream actions that wisp leaves out, for features whose visible part is an action rather
// than a view container or workbench contribution (src/vs/workbench/common/wisp/exclusions.ts).
// registerAction2 skips these ids, so neither the command nor its menu entries are registered.

const excludedActions: ReadonlySet<string> = new Set([
	// Agents window: the Copilot account button in the title bar. Its contribution only draws it.
	'sessions.action.titleBarAccountWidget',
	// The local agent host, which wisp never starts.
	'workbench.action.chat.profileAgentHost',
	// Copilot voice mode's developer commands.
	'agentsVoice.simulateConnection',
	'agentsVoice.resetOnboarding',
	// Agents window title bar: Back and Forward do nothing for a thread (#302).
	'sessions.goBack',
	'sessions.goForward',
	// The disabled Run placeholder. The real Run item is hidden because wisp workspaces are virtual.
	'workbench.action.agentSessions.runScript.notAvailable',
]);

export function isExcludedAction(id: string): boolean {
	return excludedActions.has(id);
}
