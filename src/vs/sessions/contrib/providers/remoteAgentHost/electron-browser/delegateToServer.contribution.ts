/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Delegate to Server in the Agents window. A chat of this machine moves to a CreaEditor
// Server: its code (a git bundle, only what the server lacks), its conversation (the agent's own
// session: Claude SDK transcript, Codex rollout or Copilot CLI session folder, so it resumes as the
// same session; a transcript when that fails) and its Claude setup-token accounts or OpenRouter/LiteLLM
// key (sealed for the server). The local chat is archived and locked ("continues on <server>") until
// Take Back Here; its results come back with Bring Back Changes or Open PR from the Server.

import '../../../../../platform/agentHost/electron-browser/creaeditorDelegationService.js';
import { raceTimeout, timeout } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../../base/common/observable.js';
import { posix } from '../../../../../base/common/path.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAgentHostConnectionsService } from '../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { remoteAgentHostSessionTypeId } from '../../../../../platform/agentHost/common/agentHostSessionType.js';
import { agentHostAuthority, toAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID, CREAEDITOR_DELEGATE_REQUEST_KEY, CREAEDITOR_DELEGATE_TO_SERVER_COMMAND_ID, CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX, CREAEDITOR_DELEGATION_DEFAULT_MAX_UPLOAD_MB, CREAEDITOR_OPEN_PR_FROM_SERVER_COMMAND_ID, CREAEDITOR_SET_SERVER_GITHUB_TOKEN_COMMAND_ID, DELEGATION_ERROR_NAME, DelegationAgentKind, DelegationErrorCode, DelegationMaxUploadSettingId, DelegationProgressStage, DelegationResultsMode, getAgentSessionIdFromStateFile, getBroughtBackBranchName, getBroughtBackBranchPrefix, getDelegationAgentKind, getDelegationAgentProvider, ICreaEditorDelegationService, IDelegateResult, IDelegateToServerRequest, IDelegationAccountsPayload, IDelegationGatewayKey, IDelegationGatewayModel, IDelegationServerTarget, parseDelegationGatewayModel } from '../../../../../platform/agentHost/common/creaeditorDelegation.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { buildDelegationTranscript, createDelegationTranscriptAttachment } from '../../../../../workbench/contrib/chat/browser/actions/chatContinueInAction.js';
import { IChatWidget, IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { ILanguageModelsConfigurationService } from '../../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import { getSubscriptionAccountSecretKey, ISubscriptionAccountsService } from '../../../../../workbench/services/agentHost/browser/subscriptionAccountsService.js';
import { Menus } from '../../../../browser/menus.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, REMOTE_AGENT_HOST_PROVIDER_PREFIX } from '../../../../common/agentHostSessionsProvider.js';
import { SessionProviderIdContext } from '../../../../common/contextkeys.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { getCreaEditorServerDeviceKeyName, ICreaEditorServer, ICreaEditorServersService } from '../browser/creaeditorServers.js';
import { CreaEditorServerCommandIds } from '../browser/creaeditorServerActions.js';
import { DelegatedChatsStore, describeDelegatedChatState, getServerFolderTrustUris, IDelegatedChat } from '../browser/delegatedChats.js';

/** True when the active session is a delegated chat (here or on its server). */
const ActiveSessionDelegatedContext = new RawContextKey<boolean>('creaeditorActiveSessionDelegated', false, localize('activeSessionDelegated', "Whether the active chat was delegated to a CreaEditor Server."));

const SHOW_DELEGATED_CHATS_COMMAND_ID = 'creaeditor.delegation.showDelegatedChats';
const OPEN_ON_SERVER_COMMAND_ID = 'creaeditor.delegation.openOnServer';
const CHANGE_RESULTS_MODE_COMMAND_ID = 'creaeditor.delegation.changeResultsMode';
const TAKE_BACK_HERE_COMMAND_ID = 'creaeditor.delegation.takeBackHere';

/** How long the server's agent host connection is waited for after the code went up. */
const CONNECTION_TIMEOUT_MS = 30_000;
/** How often importing the resumed session on the server is tried, and how far apart. */
const IMPORT_ATTEMPTS = 5;
const IMPORT_RETRY_MS = 1500;
/** How long a resumed session may take to show up in the server's sessions list. */
const SESSION_APPEAR_TIMEOUT_MS = 15_000;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'creaeditorDelegation',
	title: localize('delegation.configTitle', "Delegate to Server"),
	type: 'object',
	properties: {
		[DelegationMaxUploadSettingId]: {
			type: 'number',
			default: CREAEDITOR_DELEGATION_DEFAULT_MAX_UPLOAD_MB,
			minimum: 1,
			markdownDescription: localize('delegation.maxUpload', "The largest code upload of **Delegate to Server**, in MB. Delegating stops with a clear message when the code (history the server lacks, uncommitted changes and untracked files) is larger."),
		},
	},
});

/** The delegation error code of an error from the main process. */
function getDelegationErrorCode(error: unknown): DelegationErrorCode | undefined {
	const name = error instanceof Error ? error.name : '';
	return name.startsWith(`${DELEGATION_ERROR_NAME}:`) ? name.slice(DELEGATION_ERROR_NAME.length + 1) as DelegationErrorCode : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatMegabytes(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/** One store per window, shared by the actions and the contribution. */
let delegatedChatsStore: DelegatedChatsStore | undefined;
function getDelegatedChats(accessor: ServicesAccessor): DelegatedChatsStore {
	delegatedChatsStore ??= accessor.get(IInstantiationService).createInstance(DelegatedChatsStore);
	return delegatedChatsStore;
}

async function getServerTarget(accessor: ServicesAccessor, server: ICreaEditorServer): Promise<IDelegationServerTarget | undefined> {
	const deviceKey = await accessor.get(ISecretStorageService).get(getCreaEditorServerDeviceKeyName(server.id));
	return deviceKey ? { serverId: server.id, name: server.name, serverUrl: server.serverUrl, deviceKey } : undefined;
}

/** What the delegation actions run on: a session (menus), a delegation id (notifications, lists), or the active session. */
type DelegationActionContext = ISession | ISession[] | string | undefined;

function getSessionArg(accessor: ServicesAccessor, context: DelegationActionContext): ISession | undefined {
	if (typeof context === 'string') {
		return undefined;
	}
	const session = Array.isArray(context) ? context[0] : context;
	return session ?? accessor.get(ISessionsService).activeSession.get();
}

function findDelegatedChat(accessor: ServicesAccessor, context: DelegationActionContext): IDelegatedChat | undefined {
	const store = getDelegatedChats(accessor);
	if (typeof context === 'string') {
		return store.get(context);
	}
	const session = getSessionArg(accessor, context);
	return session ? store.find(session.resource.toString()) : undefined;
}

async function pickDelegatedChat(accessor: ServicesAccessor, context: DelegationActionContext, placeholder: string): Promise<IDelegatedChat | undefined> {
	const found = findDelegatedChat(accessor, context);
	if (found) {
		return found;
	}
	const chats = getDelegatedChats(accessor).chats;
	if (!chats.length) {
		accessor.get(INotificationService).info(localize('delegation.noneDelegated', "No chat is delegated to a server yet. Use Delegate to Server... on a chat first."));
		return undefined;
	}
	const picked = await accessor.get(IQuickInputService).pick(chats.map(chat => ({ label: chat.title, description: chat.serverName, chat })), { placeHolder: placeholder });
	return picked?.chat;
}

/** Waits until the server's agent host is connected (it may still be connecting). */
async function getServerConnection(accessor: ServicesAccessor, server: ICreaEditorServer) {
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const address = accessor.get(ICreaEditorServersService).getAgentHostAddress(server);
	const existing = remoteAgentHostService.getConnection(address);
	if (existing) {
		return { connection: existing, authority: agentHostAuthority(address) };
	}
	await raceTimeout(remoteAgentHostService.waitForConnection(address).catch(() => undefined), CONNECTION_TIMEOUT_MS);
	const connection = remoteAgentHostService.getConnection(address);
	return connection ? { connection, authority: agentHostAuthority(address) } : undefined;
}

/** Reads the Claude setup-token accounts of this machine (the pool a Claude chat runs on). */
async function readClaudeTokenAccounts(accessor: ServicesAccessor): Promise<IDelegationAccountsPayload['claudeTokens']> {
	const secretStorageService = accessor.get(ISecretStorageService);
	const accounts = accessor.get(ISubscriptionAccountsService).accounts.get().filter(account => account.provider === 'claude' && account.kind === 'token');
	const tokens: { accountId: string; label: string; token: string }[] = [];
	for (const account of accounts) {
		const token = await secretStorageService.get(getSubscriptionAccountSecretKey(account.id));
		if (token) {
			tokens.push({ accountId: account.id, label: account.label, token });
		}
	}
	return tokens;
}

/** The agent's own session id of a local chat (Claude SDK session, Codex thread, Copilot CLI session), from its state file. */
async function readAgentSessionId(accessor: ServicesAccessor, session: ISession, agent: DelegationAgentKind): Promise<string | undefined> {
	const resolution = accessor.get(IAgentHostConnectionsService).resolveSessionResource(session.resource);
	if (!resolution || agent === DelegationAgentKind.Transcript) {
		return undefined;
	}
	const stateFile = await resolution.connection.getSessionStateFile(resolution.backendSession).catch(() => undefined);
	return stateFile ? getAgentSessionIdFromStateFile(agent, stateFile.path) : undefined;
}

/** The secret storage key in a provider group's `${input:<key>}` reference (see `LanguageModelsService`). */
function decodeSecretReference(value: unknown): string | undefined {
	return typeof value === 'string' && value.startsWith('${input:') && value.endsWith('}') ? value.slice('${input:'.length, -1) : undefined;
}

/**
 * The OpenRouter/LiteLLM key a chat runs on (its model's provider group), with the group's models, so
 * the chat runs on the server with that key only. Undefined for other models.
 */
async function readGatewayKey(accessor: ServicesAccessor, session: ISession): Promise<IDelegationGatewayKey | undefined> {
	const configurationService = accessor.get(ILanguageModelsConfigurationService);
	const languageModelsService = accessor.get(ILanguageModelsService);
	const secretStorageService = accessor.get(ISecretStorageService);
	const groups = configurationService.getLanguageModelsProviderGroups();
	const parsed = parseDelegationGatewayModel(session.modelId.get(), groups);
	const group = parsed && groups.find(candidate => candidate.vendor === parsed.vendor && candidate.name === parsed.group);
	if (!parsed || !group) {
		return undefined;
	}
	const secretKey = decodeSecretReference(group.apiKey);
	const key = secretKey ? await secretStorageService.get(secretKey) : typeof group.apiKey === 'string' ? group.apiKey : undefined;
	if (!key) {
		return undefined;
	}
	const prefix = `${parsed.vendor}/${parsed.group}/`;
	const models: IDelegationGatewayModel[] = [];
	for (const identifier of languageModelsService.getLanguageModelIds()) {
		const metadata = identifier.startsWith(prefix) ? languageModelsService.lookupLanguageModel(identifier) : undefined;
		if (metadata) {
			models.push({ id: identifier.slice(prefix.length), name: metadata.name, maxInputTokens: metadata.maxInputTokens, maxOutputTokens: metadata.maxOutputTokens, ...(metadata.capabilities?.vision ? { supportsVision: true } : {}) });
		}
	}
	if (!models.some(model => model.id === parsed.model)) {
		models.push({ id: parsed.model });
	}
	return {
		providerId: parsed.vendor,
		label: parsed.group,
		key,
		models,
		...(parsed.vendor === 'litellm' && typeof group.url === 'string' ? { baseUrl: group.url } : {}),
	};
}

/** Waits until a session shows up in the Agents window (the server lists a resumed one a moment later). */
async function waitForSession(sessionsManagementService: ISessionsManagementService, resource: URI): Promise<boolean> {
	if (sessionsManagementService.getSession(resource)) {
		return true;
	}
	const store = new DisposableStore();
	try {
		return await raceTimeout(new Promise<boolean>(resolve => {
			store.add(sessionsManagementService.onDidChangeSessions(() => {
				if (sessionsManagementService.getSession(resource)) {
					resolve(true);
				}
			}));
		}), SESSION_APPEAR_TIMEOUT_MS) ?? false;
	} finally {
		store.dispose();
	}
}

/** The id of a chat's model on a server: `<server's session type>:<model>` for the same agent. */
function getRemoteModelId(session: ISession, authority: string): string | undefined {
	const provider = getDelegationAgentProvider(getDelegationAgentKind(session.sessionType, session.resource.scheme));
	const modelId = session.modelId.get();
	const colon = modelId?.indexOf(':') ?? -1;
	return provider && modelId && colon > 0 ? `${remoteAgentHostSessionTypeId(authority, provider)}:${modelId.slice(colon + 1)}` : undefined;
}

/** The folder of a server's bare repositories, next to its worktrees folder (`<data>/repos`, `<data>/worktrees`). */
function getServerRepositoriesDir(worktreesDir: string): string {
	return posix.join(posix.dirname(worktreesDir), 'repos');
}

/**
 * Trusts folders of a server for its chats: the code in a delegated chat's worktree is this computer's
 * own, so its chats open without the workspace trust question.
 */
async function trustServerWorktrees(workspaceTrustManagementService: IWorkspaceTrustManagementService, authority: string, folders: readonly string[]): Promise<void> {
	await workspaceTrustManagementService.setUrisTrust(getServerFolderTrustUris(authority, folders), true);
}

/** The chat of a delegation in the server's list: its session works in the delegated worktree (or a worktree next to it). */
function findServerChat(sessionsManagementService: ISessionsManagementService, authority: string, chat: IDelegatedChat): ISession | undefined {
	if (!chat.worktree) {
		return undefined;
	}
	const worktree = toAgentHostUri(URI.file(chat.worktree), authority);
	const nextToIt = toAgentHostUri(URI.file(`${chat.worktree}.worktrees`), authority);
	return sessionsManagementService.getSessions().find(session => session.providerId === `${REMOTE_AGENT_HOST_PROVIDER_PREFIX}${authority}`
		&& !!session.workspace.get()?.folders.some(folder => extUri.isEqualOrParent(folder.workingDirectory, worktree) || extUri.isEqualOrParent(folder.workingDirectory, nextToIt)));
}

/** Starts the chat on the server with a transcript of the conversation (agents whose sessions cannot move). */
async function continueWithTranscript(accessor: ServicesAccessor, session: ISession, server: ICreaEditorServer, authority: string, result: IDelegateResult): Promise<URI | undefined> {
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const chatService = accessor.get(IChatService);
	const requests = chatService.getSession(session.mainChat.get().resource)?.getRequests() ?? [];
	const transcript = buildDelegationTranscript(requests);
	const attachment = createDelegationTranscriptAttachment(transcript, session.title.get());
	const folder = toAgentHostUri(URI.file(result.record.workingDirectory), authority);
	const options = { providerId: `${REMOTE_AGENT_HOST_PROVIDER_PREFIX}${authority}`, sessionTypeId: session.sessionType };
	// The same model on the server (the server lists a delegated key's models under the same id), so the
	// chat runs on that key there and needs no GitHub sign-in for a default model.
	const modelId = getRemoteModelId(session, authority);
	let remote: ISession;
	try {
		remote = sessionsManagementService.createNewSession(folder, modelId ? { ...options, modelId } : options);
	} catch {
		remote = sessionsManagementService.createNewSession(folder, options);
	}
	await sessionsManagementService.sendNewChatRequest(remote, {
		query: localize('delegation.transcriptPrompt', "This chat was delegated from {0} to {1}. Continue the work from the previous conversation; the code, including uncommitted changes, is in this folder.", result.record.sourceName, server.name),
		attachedContext: attachment ? [attachment] : [],
	});
	return remote.resource;
}

async function delegateToServer(accessor: ServicesAccessor, context: ISession | ISession[] | undefined): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	const quickInputService = accessor.get(IQuickInputService);
	const dialogService = accessor.get(IDialogService);
	const commandService = accessor.get(ICommandService);
	const serversService = accessor.get(ICreaEditorServersService);
	const delegationService = accessor.get(ICreaEditorDelegationService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const sessionsService = accessor.get(ISessionsService);
	const progressService = accessor.get(IProgressService);
	const configurationService = accessor.get(IConfigurationService);
	const logService = accessor.get(ILogService);
	const instantiationService = accessor.get(IInstantiationService);
	const workspaceTrustManagementService = accessor.get(IWorkspaceTrustManagementService);
	const store = getDelegatedChats(accessor);

	const session = getSessionArg(accessor, context);
	if (!session) {
		notificationService.info(localize('delegation.noSession', "Open the chat to delegate first."));
		return;
	}
	const existing = store.find(session.resource.toString());
	if (existing) {
		notificationService.prompt(Severity.Info, localize('delegation.already', "This chat already continues on {0}.", existing.serverName), [
			{ label: localize('delegation.openOnServer', "Open on Server"), run: () => commandService.executeCommand(OPEN_ON_SERVER_COMMAND_ID, existing.delegationId) },
		]);
		return;
	}
	if (session.providerId !== LOCAL_AGENT_HOST_PROVIDER_ID) {
		notificationService.info(localize('delegation.notLocal', "Only chats that run on this computer can be delegated to a server."));
		return;
	}
	const folder = session.workspace.get()?.folders.at(0);
	const folderUri = folder?.workingDirectory ?? folder?.root;
	if (!folderUri || folderUri.scheme !== 'file') {
		notificationService.info(localize('delegation.noFolder', "This chat has no folder on this computer, so there is no code to send."));
		return;
	}

	// The server.
	const servers = serversService.servers.get();
	if (!servers.length) {
		notificationService.prompt(Severity.Info, localize('delegation.noServers', "Add a CreaEditor Server first; the chat then continues there."), [
			{ label: localize('delegation.addServer', "Add CreaEditor Server"), run: () => commandService.executeCommand(CreaEditorServerCommandIds.add) },
		]);
		return;
	}
	const health = serversService.healthStates.get();
	type ServerPick = IQuickPickItem & { readonly server: ICreaEditorServer };
	const serverPick = servers.length === 1 ? { server: servers[0] } : await quickInputService.pick<ServerPick>(servers.map(server => ({
		label: server.name,
		description: health.get(server.id)?.reachable === false ? localize('delegation.serverOffline', "offline") : server.serverUrl,
		server,
	})), { placeHolder: localize('delegation.pickServer', "Delegate this chat to which server?") });
	if (!serverPick) {
		return;
	}
	const server = serverPick.server;
	const target = await instantiationService.invokeFunction(innerAccessor => getServerTarget(innerAccessor, server));
	if (!target) {
		notificationService.error(localize('delegation.noKey', "This computer has no key for {0}. Remove the server and add it again.", server.name));
		return;
	}

	// What the code is, and what stays here.
	let inspection;
	let serverInfo;
	try {
		[inspection, serverInfo] = await Promise.all([delegationService.inspectFolder(folderUri.fsPath), delegationService.getServerInfo(target)]);
	} catch (error) {
		notificationService.error(localize('delegation.cannotStart', "Cannot delegate to {0}: {1}", server.name, errorMessage(error)));
		return;
	}

	type ModePick = IQuickPickItem & { readonly mode: DelegationResultsMode };
	const modePick = await quickInputService.pick<ModePick>([
		{ mode: DelegationResultsMode.BringBack, label: localize('delegation.modeBringBack', "Bring Back Changes"), detail: localize('delegation.modeBringBackDetail', "When this computer is online, fetch the server's work into a local branch ({0}...), then check it out, compare or merge.", getBroughtBackBranchPrefix(server.name)) },
		{ mode: DelegationResultsMode.PullRequest, label: localize('delegation.modePullRequest', "Open PR from the Server"), detail: inspection.remoteUrl?.includes('github.com') ? (serverInfo.hasGitHubToken ? localize('delegation.modePullRequestDetail', "The server pushes its branch and opens a pull request with its own GitHub token.") : localize('delegation.modePullRequestNoToken', "The server pushes its branch and opens a pull request; set its GitHub token once first.")) : localize('delegation.modePullRequestNoGitHub', "Needs a GitHub remote (origin)."), disabled: !inspection.remoteUrl?.includes('github.com') },
	], { placeHolder: localize('delegation.pickMode', "How should the results come back?") });
	if (!modePick) {
		return;
	}

	let includeSecretFiles = false;
	if (inspection.skippedSecretFiles.length) {
		const choice = await quickInputService.pick([
			{ id: 'keep', label: localize('delegation.keepSecrets', "Keep Them on This Computer"), detail: inspection.skippedSecretFiles.slice(0, 5).join(', ') + (inspection.skippedSecretFiles.length > 5 ? ', ...' : '') },
			{ id: 'send', label: localize('delegation.sendSecrets', "Send Them Too"), detail: localize('delegation.sendSecretsDetail', "Only if the chat needs them; they end up in the server's worktree.") },
		], { placeHolder: localize('delegation.secretsQuestion', "{0} untracked files look like secrets (.env, keys). Send them to {1}?", inspection.skippedSecretFiles.length, server.name) });
		if (!choice) {
			return;
		}
		includeSecretFiles = choice.id === 'send';
	}

	// Only runs in one place at a time.
	if (session.status.get() === SessionStatus.InProgress || session.status.get() === SessionStatus.NeedsInput) {
		const { confirmed } = await dialogService.confirm({
			message: localize('delegation.stopFirst', "Stop the chat here and continue it on {0}?", server.name),
			detail: localize('delegation.stopFirstDetail', "A chat runs in one place at a time. The current turn stops; the server continues from there."),
			primaryButton: localize({ key: 'delegation.stopAndDelegate', comment: ['&& denotes a mnemonic'] }, "&&Stop and Delegate"),
		});
		if (!confirmed) {
			return;
		}
		await sessionsManagementService.cancelCurrentRequest(session);
	}

	const agent = getDelegationAgentKind(session.sessionType, session.resource.scheme);
	const isClaude = agent === DelegationAgentKind.Claude;
	const agentSessionId = await instantiationService.invokeFunction(innerAccessor => readAgentSessionId(innerAccessor, session, agent));
	const claudeTokens = isClaude ? await instantiationService.invokeFunction(readClaudeTokenAccounts) : [];
	const gatewayKey = agent === DelegationAgentKind.CopilotCli ? await instantiationService.invokeFunction(innerAccessor => readGatewayKey(innerAccessor, session)) : undefined;
	const maxUploadMb = configurationService.getValue<number>(DelegationMaxUploadSettingId) || CREAEDITOR_DELEGATION_DEFAULT_MAX_UPLOAD_MB;
	const title = session.title.get() || localize('delegation.untitled', "Delegated chat");

	const operationId = generateUuid();
	let result: IDelegateResult;
	try {
		result = await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('delegation.progressTitle', "Delegating to {0}", server.name) }, async progress => {
			const listener = delegationService.onDidProgress(event => {
				if (event.operationId !== operationId) {
					return;
				}
				switch (event.stage) {
					case DelegationProgressStage.Packing:
						progress.report({ message: localize('delegation.packing', "Packing code...") });
						break;
					case DelegationProgressStage.Uploading:
						progress.report({ message: localize('delegation.uploading', "Sending code... {0} MB / {1} MB", formatMegabytes(event.bytesDone ?? 0), formatMegabytes(event.bytesTotal ?? 0)) });
						break;
					case DelegationProgressStage.Preparing:
						progress.report({ message: localize('delegation.preparing', "Preparing the worktree on {0}...", server.name) });
						break;
				}
			});
			try {
				return await delegationService.delegate(operationId, {
					server: target,
					folder: folderUri.fsPath,
					title,
					resultsMode: modePick.mode,
					includeSecretFiles,
					maxUploadBytes: maxUploadMb * 1024 * 1024,
					agent: agentSessionId ? agent : DelegationAgentKind.Transcript,
					...(agentSessionId ? { agentSessionId } : {}),
					accounts: { ...(claudeTokens?.length ? { claudeTokens } : {}), ...(gatewayKey ? { gatewayKey } : {}) },
					sourceName: '',
				});
			} finally {
				listener.dispose();
			}
		});
	} catch (error) {
		const code = getDelegationErrorCode(error);
		logService.warn(`[Delegation] Delegating to ${server.name} failed (${code ?? 'unexpected'}): ${errorMessage(error)}`);
		const retry = code === DelegationErrorCode.Offline ? [{ label: localize('delegation.retry', "Try Again"), run: () => commandService.executeCommand(CREAEDITOR_DELEGATE_TO_SERVER_COMMAND_ID, session) }] : [];
		notificationService.prompt(Severity.Error, localize('delegation.failed', "Delegating to {0} failed: {1}", server.name, errorMessage(error)), retry);
		return;
	}

	// The conversation on the server.
	const chat: IDelegatedChat = {
		delegationId: result.record.delegationId,
		shortId: result.record.shortId,
		serverId: server.id,
		serverName: server.name,
		title,
		localSessionResource: session.resource.toString(),
		folder: folderUri.fsPath,
		worktree: result.record.worktree,
		baseCommit: result.record.baseCommit,
		branch: result.record.branch,
		resultsMode: modePick.mode,
		createdAt: Date.now(),
	};
	store.upsert(chat);

	// The worktree holds this computer's own code: trust it like the folder it came from, and the
	// server's folder of delegated worktrees (a chat there may work in a worktree next to it). Before
	// connecting, so the chat's first message never asks.
	await trustServerWorktrees(workspaceTrustManagementService, agentHostAuthority(serversService.getAgentHostAddress(server)), [serverInfo.worktreesDir, serverInfo.repositoriesDir ?? getServerRepositoriesDir(serverInfo.worktreesDir), result.record.worktree]).catch(error => logService.warn(`[Delegation] Trusting the worktree failed: ${errorMessage(error)}`));
	const connected = await instantiationService.invokeFunction(innerAccessor => getServerConnection(innerAccessor, server));
	let remoteResource: URI | undefined;
	let transcriptOnly = !result.sessionFilesSent;
	if (connected) {
		if (result.accountsEnvelope) {
			try {
				await connected.connection.authenticate({ resource: `${CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX}${result.record.delegationId}`, token: JSON.stringify(result.accountsEnvelope) });
			} catch (error) {
				logService.warn(`[Delegation] Sending the accounts to ${server.name} failed: ${errorMessage(error)}`);
			}
		}
		const provider = getDelegationAgentProvider(result.record.agent);
		if (result.sessionFilesSent && result.record.resumeSessionId && provider && connected.connection.importSession) {
			// The server lists the installed session a moment after the accounts call; try a few times.
			const backendSession = URI.from({ scheme: provider, path: `/${result.record.resumeSessionId}` });
			for (let attempt = 1; attempt <= IMPORT_ATTEMPTS && !remoteResource; attempt++) {
				try {
					await connected.connection.importSession(backendSession);
					remoteResource = URI.from({ scheme: remoteAgentHostSessionTypeId(connected.authority, provider), path: `/${result.record.resumeSessionId}` });
				} catch (error) {
					if (attempt === IMPORT_ATTEMPTS) {
						logService.warn(`[Delegation] ${server.name} could not resume the ${provider} session: ${errorMessage(error)}`);
					} else {
						await timeout(IMPORT_RETRY_MS);
					}
				}
			}
		}
		if (!remoteResource) {
			transcriptOnly = true;
			try {
				remoteResource = await instantiationService.invokeFunction(innerAccessor => continueWithTranscript(innerAccessor, session, server, connected.authority, result));
			} catch (error) {
				logService.warn(`[Delegation] Starting the chat on ${server.name} failed: ${errorMessage(error)}`);
			}
		}
	}
	store.update(chat.delegationId, { ...(remoteResource ? { remoteSessionResource: remoteResource.toString() } : {}), ...(transcriptOnly ? { transcriptOnly } : {}) });

	// Runs in one place only: the local chat is archived and points to the server.
	await sessionsManagementService.archiveSession(session).catch(error => logService.warn(`[Delegation] Archiving the local chat failed: ${errorMessage(error)}`));

	const sent = result.bytesSent ? localize('delegation.sentBytes', "{0} MB of code sent{1}.", formatMegabytes(result.bytesSent), result.incremental ? localize('delegation.incremental', " (only what the server lacked)") : '') : localize('delegation.nothingToSend', "The server had the code already.");
	const how = transcriptOnly ? localize('delegation.transcriptNote', " It continues with a transcript of the conversation (this chat's session could not move to the server).") : '';
	const actions = [
		...(remoteResource ? [{ label: localize('delegation.openOnServer', "Open on Server"), run: () => sessionsService.openSession(remoteResource) }] : []),
		...(modePick.mode === DelegationResultsMode.PullRequest && !serverInfo.hasGitHubToken ? [{ label: localize('delegation.setToken', "Set GitHub Token on Server"), run: () => commandService.executeCommand(CREAEDITOR_SET_SERVER_GITHUB_TOKEN_COMMAND_ID, server.id) }] : []),
		...(!connected ? [{ label: localize('delegation.openServers', "Open Servers"), run: () => commandService.executeCommand(CreaEditorServerCommandIds.manage) }] : []),
	];
	notificationService.prompt(Severity.Info, connected
		? localize('delegation.done', "Delegated to {0}: the chat continues there, so this computer can be turned off. {1}{2}", server.name, sent, how)
		: localize('delegation.doneOffline', "The code is on {0}, but its agent host is not connected yet, so the chat did not start there. Connect to the server and run Delegate to Server... again. {1}", server.name, sent), actions);

	if (isClaude && !claudeTokens?.length && connected) {
		notificationService.prompt(Severity.Info, localize('delegation.loginOnServer', "This computer signs in to Claude with a browser login, which cannot move to {0}. If the server has no Claude account yet, log in once on the server.", server.name), [
			{ label: localize('delegation.openServers', "Open Servers"), run: () => commandService.executeCommand(CreaEditorServerCommandIds.manage) },
		]);
	}

	if (remoteResource && await waitForSession(sessionsManagementService, remoteResource)) {
		await sessionsService.openSession(remoteResource).catch(() => undefined);
	}
}

async function bringBackChangesAction(accessor: ServicesAccessor, context: DelegationActionContext): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	const quickInputService = accessor.get(IQuickInputService);
	const progressService = accessor.get(IProgressService);
	const delegationService = accessor.get(ICreaEditorDelegationService);
	const commandService = accessor.get(ICommandService);
	const serversService = accessor.get(ICreaEditorServersService);
	const instantiationService = accessor.get(IInstantiationService);
	const store = getDelegatedChats(accessor);
	const chat = await pickDelegatedChat(accessor, context, localize('delegation.pickBringBack', "Bring back the changes of which chat?"));
	if (!chat) {
		return;
	}
	const server = serversService.servers.get().find(candidate => candidate.id === chat.serverId);
	const target = server && await instantiationService.invokeFunction(innerAccessor => getServerTarget(innerAccessor, server));
	if (!target) {
		notificationService.error(localize('delegation.serverGone', "{0} is no longer in the Servers list.", chat.serverName));
		return;
	}
	const branch = getBroughtBackBranchName(chat.serverName, chat.shortId);
	const operationId = generateUuid();
	let result;
	try {
		result = await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('delegation.bringingBack', "Bringing back changes from {0}", chat.serverName) }, async progress => {
			const listener = delegationService.onDidProgress(event => {
				if (event.operationId === operationId && event.stage === DelegationProgressStage.Downloading) {
					progress.report({ message: localize('delegation.downloading', "Receiving... {0} MB / {1} MB", formatMegabytes(event.bytesDone ?? 0), formatMegabytes(event.bytesTotal ?? 0)) });
				}
			});
			try {
				return await delegationService.bringBackChanges(operationId, { server: target, delegationId: chat.delegationId, folder: chat.folder, baseCommit: chat.baseCommit, branch });
			} finally {
				listener.dispose();
			}
		});
	} catch (error) {
		const offline = getDelegationErrorCode(error) === DelegationErrorCode.Offline;
		notificationService.prompt(Severity.Error, localize('delegation.bringBackFailed', "Bringing back changes from {0} failed: {1}", chat.serverName, errorMessage(error)), offline ? [{ label: localize('delegation.retry', "Try Again"), run: () => commandService.executeCommand(CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID, chat.delegationId) }] : []);
		return;
	}
	store.update(chat.delegationId, { broughtBackBranch: result.branch });
	if (result.unchanged) {
		notificationService.info(localize('delegation.noChanges', "{0} has no changes for this chat yet.", chat.serverName));
		return;
	}
	type NextPick = IQuickPickItem & { readonly id: 'checkout' | 'compare' | 'merge' };
	const next = await quickInputService.pick<NextPick>([
		{ id: 'compare', label: localize('delegation.compare', "Compare"), detail: localize('delegation.compareDetail', "Show what {0} changed against your current branch.", result.branch) },
		{ id: 'checkout', label: localize('delegation.checkout', "Checkout"), detail: localize('delegation.checkoutDetail', "Switch to {0}.", result.branch) },
		{ id: 'merge', label: localize('delegation.merge', "Merge"), detail: localize('delegation.mergeDetail', "Merge {0} into your current branch.", result.branch) },
	], { placeHolder: localize('delegation.broughtBack', "The changes are in the local branch {0}{1}. Your files are unchanged.", result.branch, result.includesUncommitted ? localize('delegation.withUncommitted', " (the server's uncommitted work is its last commit)") : '') });
	if (!next) {
		return;
	}
	try {
		if (next.id === 'compare') {
			const changes = await delegationService.listBranchChanges(chat.folder, result.branch);
			if (!changes.length) {
				notificationService.info(localize('delegation.sameContent', "{0} has the same files as your current branch.", result.branch));
				return;
			}
			const gitUri = (path: string, ref: string) => URI.file(path).with({ scheme: 'git', query: JSON.stringify({ path, ref }) });
			await commandService.executeCommand('vscode.changes', localize('delegation.compareTitle', "Changes from {0}", chat.serverName), changes.map(change => [
				URI.file(change.path),
				change.status === 'A' ? undefined : gitUri(change.path, 'HEAD'),
				change.status === 'D' ? undefined : gitUri(change.path, result.branch),
			]));
			return;
		}
		await delegationService.applyBroughtBackBranch(chat.folder, result.branch, next.id);
		notificationService.info(next.id === 'checkout'
			? localize('delegation.checkedOut', "Checked out {0}.", result.branch)
			: localize('delegation.merged', "Merged {0} into your current branch.", result.branch));
	} catch (error) {
		notificationService.error(errorMessage(error));
	}
}

async function openPullRequestAction(accessor: ServicesAccessor, context: DelegationActionContext): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	const progressService = accessor.get(IProgressService);
	const delegationService = accessor.get(ICreaEditorDelegationService);
	const openerService = accessor.get(IOpenerService);
	const commandService = accessor.get(ICommandService);
	const serversService = accessor.get(ICreaEditorServersService);
	const instantiationService = accessor.get(IInstantiationService);
	const store = getDelegatedChats(accessor);
	const chat = await pickDelegatedChat(accessor, context, localize('delegation.pickPullRequest', "Open a pull request for which chat?"));
	if (!chat) {
		return;
	}
	const server = serversService.servers.get().find(candidate => candidate.id === chat.serverId);
	const target = server && await instantiationService.invokeFunction(innerAccessor => getServerTarget(innerAccessor, server));
	if (!target) {
		notificationService.error(localize('delegation.serverGone', "{0} is no longer in the Servers list.", chat.serverName));
		return;
	}
	try {
		const url = await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('delegation.openingPullRequest', "{0} is pushing {1} and opening a pull request...", chat.serverName, chat.branch) }, () => delegationService.openPullRequest(target, chat.delegationId));
		store.update(chat.delegationId, { pullRequestUrl: url });
		notificationService.prompt(Severity.Info, localize('delegation.pullRequestOpened', "{0} opened a pull request: {1}", chat.serverName, url), [
			{ label: localize('delegation.openPullRequest', "Open Pull Request"), run: () => openerService.open(URI.parse(url), { openExternal: true }) },
		]);
	} catch (error) {
		const code = getDelegationErrorCode(error);
		notificationService.prompt(Severity.Error, errorMessage(error), code === DelegationErrorCode.NoGitHubToken
			? [{ label: localize('delegation.setToken', "Set GitHub Token on Server"), run: () => commandService.executeCommand(CREAEDITOR_SET_SERVER_GITHUB_TOKEN_COMMAND_ID, chat.serverId) }]
			: []);
	}
}

async function setServerGitHubTokenAction(accessor: ServicesAccessor, serverId?: string): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const delegationService = accessor.get(ICreaEditorDelegationService);
	const serversService = accessor.get(ICreaEditorServersService);
	const instantiationService = accessor.get(IInstantiationService);
	const servers = serversService.servers.get();
	let server = typeof serverId === 'string' ? servers.find(candidate => candidate.id === serverId) : undefined;
	if (!server) {
		if (!servers.length) {
			notificationService.info(localize('delegation.noServersForToken', "Add a CreaEditor Server first."));
			return;
		}
		server = servers.length === 1 ? servers[0] : (await quickInputService.pick(servers.map(candidate => ({ label: candidate.name, description: candidate.serverUrl, server: candidate })), { placeHolder: localize('delegation.pickTokenServer', "Set the GitHub token of which server?") }))?.server;
	}
	if (!server) {
		return;
	}
	const token = await quickInputService.input({
		title: localize('delegation.tokenTitle', "Set GitHub Token on {0}", server.name),
		prompt: localize('delegation.tokenPrompt', "A GitHub token with access to the repositories (fine-grained: Contents and Pull requests read and write). The server keeps it encrypted and uses it only to push branches of delegated chats and open their pull requests. Leave empty to remove it."),
		password: true,
		ignoreFocusLost: true,
	});
	if (token === undefined) {
		return;
	}
	const currentServer = server;
	const target = await instantiationService.invokeFunction(innerAccessor => getServerTarget(innerAccessor, currentServer));
	if (!target) {
		notificationService.error(localize('delegation.noKey', "This computer has no key for {0}. Remove the server and add it again.", server.name));
		return;
	}
	try {
		await delegationService.setServerGitHubToken(target, token.trim());
		notificationService.info(token.trim() ? localize('delegation.tokenSet', "{0} has a GitHub token now.", server.name) : localize('delegation.tokenRemoved', "The GitHub token of {0} is removed.", server.name));
	} catch (error) {
		notificationService.error(localize('delegation.tokenFailed', "Setting the GitHub token on {0} failed: {1}", server.name, errorMessage(error)));
	}
}

async function openOnServerAction(accessor: ServicesAccessor, context: DelegationActionContext): Promise<void> {
	const notificationService = accessor.get(INotificationService);
	const sessionsService = accessor.get(ISessionsService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const serversService = accessor.get(ICreaEditorServersService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const workspaceTrustManagementService = accessor.get(IWorkspaceTrustManagementService);
	const logService = accessor.get(ILogService);
	const store = getDelegatedChats(accessor);
	const chat = await pickDelegatedChat(accessor, context, localize('delegation.pickOpen', "Open which delegated chat?"));
	if (!chat) {
		return;
	}
	const server = serversService.servers.get().find(candidate => candidate.id === chat.serverId);
	const authority = server ? agentHostAuthority(serversService.getAgentHostAddress(server)) : undefined;
	if (authority && chat.worktree) {
		await trustServerWorktrees(workspaceTrustManagementService, authority, [posix.dirname(chat.worktree), getServerRepositoriesDir(posix.dirname(chat.worktree)), chat.worktree]).catch(error => logService.warn(`[Delegation] Trusting the worktree failed: ${errorMessage(error)}`));
	}
	let resource = chat.remoteSessionResource ? URI.parse(chat.remoteSessionResource) : undefined;
	if (!resource && authority) {
		// The chat started on the server, but this computer did not learn its session (the start was
		// interrupted, or it ran in another window): find it by its worktree.
		resource = findServerChat(sessionsManagementService, authority, chat)?.resource;
		if (resource) {
			store.update(chat.delegationId, { remoteSessionResource: resource.toString() });
		}
	}
	if (!resource) {
		const connected = !!server && !!remoteAgentHostService.getConnection(serversService.getAgentHostAddress(server));
		notificationService.info(connected
			? localize('delegation.notOnServer', "{0} has no chat for \"{1}\" yet. Run Delegate to Server... again to start it there.", chat.serverName, chat.title)
			: localize('delegation.serverNotConnected', "{0} is not connected. Open Servers to connect it, then open the chat.", chat.serverName));
		return;
	}
	await sessionsService.openSession(resource);
}

async function changeResultsModeAction(accessor: ServicesAccessor, context: DelegationActionContext): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const store = getDelegatedChats(accessor);
	const chat = await pickDelegatedChat(accessor, context, localize('delegation.pickChange', "Change how the results of which chat come back?"));
	if (!chat) {
		return;
	}
	const picked = await quickInputService.pick([
		{ mode: DelegationResultsMode.BringBack, label: localize('delegation.modeBringBack', "Bring Back Changes"), picked: chat.resultsMode === DelegationResultsMode.BringBack },
		{ mode: DelegationResultsMode.PullRequest, label: localize('delegation.modePullRequest', "Open PR from the Server"), picked: chat.resultsMode === DelegationResultsMode.PullRequest },
	], { placeHolder: localize('delegation.pickMode', "How should the results come back?") });
	if (picked) {
		store.update(chat.delegationId, { resultsMode: picked.mode });
	}
}

/**
 * Take Back Here: the delegated chat stops on its server (its turn is cancelled and the server's chat
 * archived) and the local chat can be sent to again. The server's conversation stays there; its code
 * comes back with Bring Back Changes.
 */
async function takeBackHereAction(accessor: ServicesAccessor, context: DelegationActionContext): Promise<void> {
	const dialogService = accessor.get(IDialogService);
	const notificationService = accessor.get(INotificationService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const sessionsService = accessor.get(ISessionsService);
	const logService = accessor.get(ILogService);
	const serversService = accessor.get(ICreaEditorServersService);
	const store = getDelegatedChats(accessor);
	const chat = await pickDelegatedChat(accessor, context, localize('delegation.pickTakeBack', "Take back which chat?"));
	if (!chat) {
		return;
	}
	const { confirmed } = await dialogService.confirm({
		message: localize('delegation.takeBackConfirm', "Take \"{0}\" back from {1}?", chat.title, chat.serverName),
		detail: chat.resultsMode === DelegationResultsMode.BringBack && !chat.broughtBackBranch
			? localize('delegation.takeBackDetailBringBack', "The chat stops on {0} and continues here from where it was delegated. Its work on the server stays on the server: use Bring Back Changes first to get its code.", chat.serverName)
			: localize('delegation.takeBackDetail', "The chat stops on {0} and continues here from where it was delegated. The conversation on the server stays there.", chat.serverName),
		primaryButton: localize({ key: 'delegation.takeBackButton', comment: ['&& denotes a mnemonic'] }, "&&Take Back Here"),
	});
	if (!confirmed) {
		return;
	}
	// The server's chat as recorded, else (no record of it, e.g. it started later) the one in its worktree.
	const server = serversService.servers.get().find(candidate => candidate.id === chat.serverId);
	const authority = server ? agentHostAuthority(serversService.getAgentHostAddress(server)) : undefined;
	const remote = (chat.remoteSessionResource ? sessionsManagementService.getSession(URI.parse(chat.remoteSessionResource)) : undefined)
		?? (authority ? findServerChat(sessionsManagementService, authority, chat) : undefined);
	if (remote) {
		try {
			if (remote.status.get() === SessionStatus.InProgress || remote.status.get() === SessionStatus.NeedsInput) {
				await sessionsManagementService.cancelCurrentRequest(remote);
			}
			await sessionsManagementService.archiveSession(remote);
		} catch (error) {
			logService.warn(`[Delegation] Stopping the chat on ${chat.serverName} failed: ${errorMessage(error)}`);
		}
	} else if (chat.remoteSessionResource) {
		notificationService.info(localize('delegation.takeBackOffline', "{0} is not connected, so the chat could not be stopped there. Archive it on the server when it is back.", chat.serverName));
	}
	store.remove(chat.delegationId);
	const local = chat.localSessionResource ? sessionsManagementService.getSession(URI.parse(chat.localSessionResource)) : undefined;
	if (local) {
		if (local.isArchived.get()) {
			await sessionsManagementService.unarchiveSession(local).catch(error => logService.warn(`[Delegation] Unarchiving the local chat failed: ${errorMessage(error)}`));
		}
		await sessionsService.openSession(local.resource).catch(() => undefined);
	}
}

async function showDelegatedChatsAction(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const commandService = accessor.get(ICommandService);
	const sessionsManagementService = accessor.get(ISessionsManagementService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const serversService = accessor.get(ICreaEditorServersService);
	const chats = getDelegatedChats(accessor).chats;
	if (!chats.length) {
		accessor.get(INotificationService).info(localize('delegation.noneDelegated', "No chat is delegated to a server yet. Use Delegate to Server... on a chat first."));
		return;
	}
	const items = [...chats].sort((a, b) => b.createdAt - a.createdAt).map(chat => {
		const server = serversService.servers.get().find(candidate => candidate.id === chat.serverId);
		const connected = !!server && !!remoteAgentHostService.getConnection(serversService.getAgentHostAddress(server));
		const status = chat.remoteSessionResource ? sessionsManagementService.getSession(URI.parse(chat.remoteSessionResource))?.status.get() : undefined;
		const results = chat.pullRequestUrl
			? localize('delegation.resultPr', "pull request opened")
			: chat.resultsMode === DelegationResultsMode.PullRequest ? localize('delegation.resultsPr', "results: Open PR from the Server") : localize('delegation.resultsBringBack', "results: Bring Back Changes");
		return { label: chat.title, description: `${chat.serverName} · ${describeDelegatedChatState(status, connected)}`, detail: `${chat.branch} · ${results}`, chat };
	});
	const picked = await quickInputService.pick(items, { placeHolder: localize('delegation.delegatedChats', "Chats delegated to servers") });
	if (!picked) {
		return;
	}
	const action = await quickInputService.pick([
		{ id: OPEN_ON_SERVER_COMMAND_ID, label: localize('delegation.openOnServer', "Open on Server") },
		picked.chat.resultsMode === DelegationResultsMode.PullRequest
			? { id: CREAEDITOR_OPEN_PR_FROM_SERVER_COMMAND_ID, label: localize('delegation.openPrFromServer', "Open PR from the Server") }
			: { id: CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID, label: localize('delegation.bringBackChanges', "Bring Back Changes") },
		{ id: CHANGE_RESULTS_MODE_COMMAND_ID, label: localize('delegation.changeMode', "Change How Results Come Back") },
		{ id: TAKE_BACK_HERE_COMMAND_ID, label: localize('delegation.takeBack', "Take Back Here") },
	], { placeHolder: picked.chat.title });
	if (action) {
		await commandService.executeCommand(action.id, picked.chat.delegationId);
	}
}

const LocalAgentHostSession = ContextKeyExpr.equals(SessionProviderIdContext.key, LOCAL_AGENT_HOST_PROVIDER_ID);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREAEDITOR_DELEGATE_TO_SERVER_COMMAND_ID,
			title: localize2('delegation.delegateToServer', "Delegate to Server..."),
			category: localize2('delegation.category', "Chat"),
			icon: Codicon.server,
			f1: true,
			menu: [
				{ id: Menus.SessionItemContextMenu, group: '2_open', order: 10, when: LocalAgentHostSession },
				{ id: Menus.SessionHeaderContext, group: '2_edit', order: 10, when: ContextKeyExpr.and(LocalAgentHostSession, ActiveSessionDelegatedContext.negate()) },
			],
		});
	}
	run(accessor: ServicesAccessor, context?: ISession | ISession[]): Promise<void> {
		return delegateToServer(accessor, context);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID,
			title: localize2('delegation.bringBackChanges', "Bring Back Changes"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
			menu: [{ id: Menus.SessionHeaderContext, group: '2_edit', order: 11, when: ActiveSessionDelegatedContext }],
		});
	}
	run(accessor: ServicesAccessor, context?: DelegationActionContext): Promise<void> {
		return bringBackChangesAction(accessor, context);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREAEDITOR_OPEN_PR_FROM_SERVER_COMMAND_ID,
			title: localize2('delegation.openPrFromServer', "Open PR from the Server"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
			menu: [{ id: Menus.SessionHeaderContext, group: '2_edit', order: 12, when: ActiveSessionDelegatedContext }],
		});
	}
	run(accessor: ServicesAccessor, context?: DelegationActionContext): Promise<void> {
		return openPullRequestAction(accessor, context);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: OPEN_ON_SERVER_COMMAND_ID,
			title: localize2('delegation.openOnServer', "Open on Server"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
			menu: [{ id: Menus.SessionHeaderContext, group: '2_edit', order: 13, when: ActiveSessionDelegatedContext }],
		});
	}
	run(accessor: ServicesAccessor, context?: DelegationActionContext): Promise<void> {
		return openOnServerAction(accessor, context);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CHANGE_RESULTS_MODE_COMMAND_ID,
			title: localize2('delegation.changeMode', "Change How Results Come Back"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
			menu: [{ id: Menus.SessionHeaderContext, group: '2_edit', order: 14, when: ActiveSessionDelegatedContext }],
		});
	}
	run(accessor: ServicesAccessor, context?: DelegationActionContext): Promise<void> {
		return changeResultsModeAction(accessor, context);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: TAKE_BACK_HERE_COMMAND_ID,
			title: localize2('delegation.takeBack', "Take Back Here"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
			menu: [{ id: Menus.SessionHeaderContext, group: '2_edit', order: 15, when: ActiveSessionDelegatedContext }],
		});
	}
	run(accessor: ServicesAccessor, context?: DelegationActionContext): Promise<void> {
		return takeBackHereAction(accessor, context);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CREAEDITOR_SET_SERVER_GITHUB_TOKEN_COMMAND_ID,
			title: localize2('delegation.setToken', "Set GitHub Token on Server"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor, serverId?: string): Promise<void> {
		return setServerGitHubTokenAction(accessor, serverId);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_DELEGATED_CHATS_COMMAND_ID,
			title: localize2('delegation.showDelegatedChats', "Show Delegated Chats"),
			category: localize2('delegation.category', "Chat"),
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return showDelegatedChatsAction(accessor);
	}
});

/**
 * Marks delegated chats: the context key for the header actions, a lock on the local chat (no input,
 * a notice with Open on Server, Bring Back Changes and Take Back Here), and a notification when a
 * delegated chat finishes on its server.
 */
class DelegatedChatsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.creaeditorDelegatedChats';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ISessionsService sessionsService: ISessionsService,
		@ISessionsManagementService sessionsManagementService: ISessionsManagementService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@INotificationService notificationService: INotificationService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		const store = instantiationService.invokeFunction(getDelegatedChats);
		const delegated = ActiveSessionDelegatedContext.bindTo(contextKeyService);
		const storeChanged = observableSignalFromEvent(this, store.onDidChange);
		// A chat view binds its widget to a chat a moment after the chat is opened.
		const widgetsChanged = this._register(new Emitter<void>());
		const widgetListeners = this._register(new DisposableMap<IChatWidget>());
		const watchWidget = (widget: IChatWidget) => widgetListeners.set(widget, widget.onDidChangeViewModel(() => widgetsChanged.fire()));
		chatWidgetService.getAllWidgets().forEach(watchWidget);
		this._register(chatWidgetService.onDidAddWidget(widget => {
			watchWidget(widget);
			widgetsChanged.fire();
		}));
		this._register(chatWidgetService.onDidRemoveWidget(widget => widgetListeners.deleteAndDispose(widget)));
		const widgetSignal = observableSignalFromEvent(this, widgetsChanged.event);
		// A delegated chat runs in one place: here it is locked (no input) until it is taken back.
		let lockedWidget: IChatWidget | undefined;
		this._register(autorun(reader => {
			storeChanged.read(reader);
			widgetSignal.read(reader);
			const session = sessionsService.activeSession.read(reader);
			const chat = session ? store.find(session.resource.toString()) : undefined;
			delegated.set(!!chat);
			const widget = session && chat && chat.localSessionResource === session.resource.toString()
				? chatWidgetService.getWidgetBySessionResource(session.mainChat.read(reader).resource)
				: undefined;
			if (lockedWidget && lockedWidget !== widget) {
				lockedWidget.setLockNotice?.(undefined);
			}
			lockedWidget = widget;
			widget?.setLockNotice?.(chat && {
				message: localize('delegation.locked', "This chat continues on {0}.", chat.serverName),
				actions: [
					{ label: localize('delegation.openOnServer', "Open on Server"), run: () => commandService.executeCommand(OPEN_ON_SERVER_COMMAND_ID, chat.delegationId) },
					chat.resultsMode === DelegationResultsMode.PullRequest
						? { label: localize('delegation.openPrFromServer', "Open PR from the Server"), run: () => commandService.executeCommand(CREAEDITOR_OPEN_PR_FROM_SERVER_COMMAND_ID, chat.delegationId) }
						: { label: localize('delegation.bringBackChanges', "Bring Back Changes"), run: () => commandService.executeCommand(CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID, chat.delegationId) },
					{ label: localize('delegation.takeBack', "Take Back Here"), run: () => commandService.executeCommand(TAKE_BACK_HERE_COMMAND_ID, chat.delegationId) },
				],
			});
		}));
		this._register(toDisposable(() => lockedWidget?.setLockNotice?.(undefined)));

		// A delegated chat that finishes (or waits for approval) on its server.
		const lastStatus = new Map<string, SessionStatus>();
		this._register(sessionsManagementService.onDidChangeSessions(() => {
			for (const chat of store.chats) {
				if (!chat.remoteSessionResource) {
					continue;
				}
				const status = sessionsManagementService.getSession(URI.parse(chat.remoteSessionResource))?.status.get();
				const previous = lastStatus.get(chat.delegationId);
				if (status === undefined || status === previous) {
					continue;
				}
				lastStatus.set(chat.delegationId, status);
				if (previous === SessionStatus.InProgress && (status === SessionStatus.Completed || status === SessionStatus.NeedsInput)) {
					const resultsAction = chat.resultsMode === DelegationResultsMode.PullRequest
						? { label: localize('delegation.openPrFromServer', "Open PR from the Server"), run: () => commandService.executeCommand(CREAEDITOR_OPEN_PR_FROM_SERVER_COMMAND_ID, chat.delegationId) }
						: { label: localize('delegation.bringBackChanges', "Bring Back Changes"), run: () => commandService.executeCommand(CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID, chat.delegationId) };
					notificationService.prompt(Severity.Info, status === SessionStatus.Completed
						? localize('delegation.finished', "\"{0}\" finished on {1}.", chat.title, chat.serverName)
						: localize('delegation.needsInput', "\"{0}\" waits for you on {1}.", chat.title, chat.serverName), [
						{ label: localize('delegation.openOnServer', "Open on Server"), run: () => sessionsService.openSession(URI.parse(chat.remoteSessionResource!)) },
						...(status === SessionStatus.Completed ? [resultsAction] : []),
					]);
				}
			}
		}));
	}
}

registerWorkbenchContribution2(DelegatedChatsContribution.ID, DelegatedChatsContribution, WorkbenchPhase.AfterRestored);

/** How long a request of the editor window to delegate a chat stays valid. */
const DELEGATE_REQUEST_LIFETIME_MS = 2 * 60 * 1000;

/** The session of the Agents window that shows a chat of the editor window. */
function findSessionForChat(sessionsManagementService: ISessionsManagementService, resource: URI): ISession | undefined {
	return sessionsManagementService.getSession(resource)
		?? sessionsManagementService.getSessions().find(session => session.mainChat.get().resource.toString() === resource.toString());
}

/** Runs Delegate to Server for a chat of the editor window (see `CREAEDITOR_OPEN_DELEGATE_TO_SERVER_COMMAND_ID`). */
class DelegateRequestContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.creaeditorDelegateRequest';

	private readonly _waiting = this._register(new DisposableStore());

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
	) {
		super();
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, CREAEDITOR_DELEGATE_REQUEST_KEY, this._store)(() => this._handleRequest()));
		this._handleRequest();
	}

	private _handleRequest(): void {
		const raw = this._storageService.get(CREAEDITOR_DELEGATE_REQUEST_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return;
		}
		this._storageService.remove(CREAEDITOR_DELEGATE_REQUEST_KEY, StorageScope.APPLICATION);
		let request: IDelegateToServerRequest;
		try {
			request = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof request?.sessionResource !== 'string' || typeof request.requestedAt !== 'number' || Date.now() - request.requestedAt > DELEGATE_REQUEST_LIFETIME_MS) {
			return;
		}
		const resource = URI.parse(request.sessionResource);
		const run = (session: ISession) => {
			this._waiting.clear();
			void this._commandService.executeCommand(CREAEDITOR_DELEGATE_TO_SERVER_COMMAND_ID, session);
		};
		const found = findSessionForChat(this._sessionsManagementService, resource);
		if (found) {
			run(found);
			return;
		}
		// The Agents window may still be loading its chats.
		this._waiting.clear();
		this._waiting.add(this._sessionsManagementService.onDidChangeSessions(() => {
			const session = findSessionForChat(this._sessionsManagementService, resource);
			if (session) {
				run(session);
			}
		}));
		const timer = setTimeout(() => {
			this._waiting.clear();
			this._notificationService.info(localize('delegation.notAnAgentChat', "This chat cannot be delegated: only agent chats (Copilot CLI, Claude and Codex) that run on this computer move to a server."));
		}, SESSION_APPEAR_TIMEOUT_MS);
		this._waiting.add(toDisposable(() => clearTimeout(timer)));
	}
}

registerWorkbenchContribution2(DelegateRequestContribution.ID, DelegateRequestContribution, WorkbenchPhase.AfterRestored);
