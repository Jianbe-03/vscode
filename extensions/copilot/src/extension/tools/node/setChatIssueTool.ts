/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { sessionResourceToId } from '../../../platform/chat/common/chatDebugFileLoggerService';
import { formatIssue, parseIssueReference } from '../../../platform/endpoint/common/gatewayTracking';
import { IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation } from './toolUtils';

interface ISetChatIssueParams {
	/** `123`, `#123`, `owner/repo#123` or an issue URL. Empty to clear. */
	readonly issue: string;
}

/**
 * CreaEditor: lets an agent declare which issue the current chat works on, so the tracking metadata
 * sent to OpenRouter / LiteLLM (and the cost page) attribute the chat's cost to that issue.
 */
class SetChatIssueTool implements vscode.LanguageModelTool<ISetChatIssueParams> {

	public static readonly toolName = ToolName.SetChatIssue;

	constructor(
		@IGatewayTrackingService private readonly _gatewayTrackingService: IGatewayTrackingService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ISetChatIssueParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		checkCancellation(token);
		const chatId = options.chatSessionResource ? sessionResourceToId(URI.from(options.chatSessionResource)) : undefined;
		if (!chatId) {
			return new LanguageModelToolResult([new LanguageModelTextPart('No chat session is associated with this tool call; the issue was not set.')]);
		}
		const value = options.input.issue?.trim();
		if (!value) {
			this._gatewayTrackingService.setIssue(chatId, undefined);
			return new LanguageModelToolResult([new LanguageModelTextPart('Cleared the issue of this chat.')]);
		}
		const issue = parseIssueReference(value);
		if (!issue) {
			return new LanguageModelToolResult([new LanguageModelTextPart(`"${value}" is not an issue reference. Use 123, #123, owner/repo#123 or an issue URL.`)]);
		}
		// The issue applies to the whole chat, including its subagents.
		this._gatewayTrackingService.setIssue(chatId, issue);
		return new LanguageModelToolResult([new LanguageModelTextPart(`This chat now works on issue ${formatIssue(issue)}. Its model requests are tracked under that issue.`)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ISetChatIssueParams>): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const issue = parseIssueReference(options.input.issue);
		return {
			invocationMessage: issue ? l10n.t('Tracking this chat under issue {0}', formatIssue(issue) ?? '') : l10n.t('Updating the issue of this chat'),
			pastTenseMessage: issue ? l10n.t('Tracked this chat under issue {0}', formatIssue(issue) ?? '') : l10n.t('Updated the issue of this chat'),
		};
	}
}

ToolRegistry.registerTool(SetChatIssueTool);
