/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: director agents. A director plans work and starts a session group
// (`create_session_group`) whose members each run in their own new worktree, so the
// director itself never needs a worktree and always works in the folder.

/**
 * Whether the custom agent with the given file URI is a director: the built-in
 * `director.agent.md`, or any user agent file whose name ends in `director.agent.md`
 * (for example `issues-director.agent.md`).
 */
export function isDirectorAgentUri(agentUri: string | undefined): boolean {
	if (!agentUri) {
		return false;
	}
	const path = agentUri.split(/[?#]/)[0];
	return /(?:^|[\/._-])director\.agent\.md$/i.test(decodeURIComponent(path));
}
