/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: "Connect Jira", which adds Atlassian's official remote MCP server so agents can read Jira issues.

import { raceTimeout } from '../../../../base/common/async.js';
import { derived, waitForState } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMcpServerConfiguration, IMcpServerVariable, McpServerType, McpServerVariableType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchMcpManagementService } from '../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { IMcpService } from '../common/mcpTypes.js';

/** Name of the MCP server in the user's `mcp.json`; agents reference its tools as `atlassian/*`. */
export const JIRA_MCP_SERVER_NAME = 'atlassian';

/** Atlassian's official remote MCP server (Jira, Confluence) for Atlassian Cloud sites. */
const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v2/mcp';

const API_KEY_INPUT_ID = 'atlassian-api-key';

/** How long to wait for the added server to show up before starting it. */
const SERVER_REGISTRATION_TIMEOUT = 10_000;

interface IJiraAuthPick extends IQuickPickItem {
	readonly auth: 'oauth' | 'apiKey';
}

/**
 * Returns the MCP server configuration (and the secret inputs it prompts for) for the chosen sign-in.
 * With OAuth the server asks for an Atlassian sign-in in the browser when it first starts. With a
 * service account API key, the key is asked for once and kept in the secret storage, never in `mcp.json`.
 */
export function getJiraMcpServer(auth: 'oauth' | 'apiKey'): { readonly config: IMcpServerConfiguration; readonly inputs?: IMcpServerVariable[] } {
	if (auth === 'oauth') {
		return { config: { type: McpServerType.REMOTE, url: ATLASSIAN_MCP_URL } };
	}
	return {
		config: { type: McpServerType.REMOTE, url: ATLASSIAN_MCP_URL, headers: { Authorization: `Bearer \${input:${API_KEY_INPUT_ID}}` } },
		inputs: [{
			id: API_KEY_INPUT_ID,
			type: McpServerVariableType.PROMPT,
			description: localize('creaeditor.jira.apiKey.description', "Atlassian service account API key for the Rovo MCP server"),
			password: true,
		}],
	};
}

/**
 * Connects Jira: adds the Atlassian MCP server to the user's MCP servers and starts it, so agents in
 * the editor and the Agents window can search Jira and read issues with their description.
 */
export class ConnectJiraAction extends Action2 {

	static readonly ID = 'creaeditor.connectJira';

	constructor() {
		super({
			id: ConnectJiraAction.ID,
			title: localize2('creaeditor.connectJira', "Connect Jira..."),
			category: localize2('creaeditor.category', "CreaEditor"),
			precondition: ChatContextKeys.enabled,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const mcpManagementService = accessor.get(IWorkbenchMcpManagementService);
		const mcpService = accessor.get(IMcpService);
		const notificationService = accessor.get(INotificationService);

		const picks: IJiraAuthPick[] = [{
			auth: 'oauth',
			label: localize('creaeditor.jira.oauth', "Sign In with Atlassian"),
			description: localize('creaeditor.jira.oauth.description', "Recommended"),
			detail: localize('creaeditor.jira.oauth.detail', "Jira Cloud. Your browser opens once to sign in; agents see what your account can see."),
		}, {
			auth: 'apiKey',
			label: localize('creaeditor.jira.apiKey', "Use a Service Account API Key"),
			detail: localize('creaeditor.jira.apiKey.detail', "For when your Atlassian admin enabled API keys for the Rovo MCP server. The key is kept in the secret storage."),
		}];
		const pick = await quickInputService.pick(picks, {
			title: localize('creaeditor.jira.title', "Connect Jira"),
			placeHolder: localize('creaeditor.jira.placeholder', "How should agents sign in to Jira?"),
			ignoreFocusLost: true,
		});
		if (!pick) {
			return;
		}

		const { config, inputs } = getJiraMcpServer(pick.auth);
		try {
			await mcpManagementService.install({ name: JIRA_MCP_SERVER_NAME, config, inputs });
		} catch (error) {
			notificationService.error(localize('creaeditor.jira.installError', "Could not connect Jira: {0}", error instanceof Error ? error.message : String(error)));
			return;
		}

		// Start it right away so the sign-in (and trust) happens now rather than in the middle of a chat.
		const server = await raceTimeout(waitForState(derived(reader => mcpService.servers.read(reader).find(candidate => candidate.definition.label === JIRA_MCP_SERVER_NAME))), SERVER_REGISTRATION_TIMEOUT);
		await server?.start();

		notificationService.notify({
			severity: Severity.Info,
			message: localize('creaeditor.jira.connected', "Jira is connected. Mention an issue key such as PROJ-123 in a chat and the agent reads the issue and its description from Jira."),
		});
	}
}
