/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { SYNCED_CUSTOMIZATION_SCHEME } from './agentHostFileSystemService.js';
import { isCustomizationEnabled } from './customizationEnablement.js';
import { CustomizationType, type AgentCustomization, type ClientPluginCustomization, type Customization } from './state/protocol/state.js';

/**
 * Computes the effective set of selectable custom agents for a session.
 *
 * Custom agents live as {@link CustomizationType.Agent | `Agent`} entries
 * in each container customization's {@link Customization.children | `children`}
 * array. Only the agent host populates `children` (after parsing the
 * container). Disabled containers are skipped; containers with an absent
 * `children` field are treated as "unknown" (e.g. the host has not finished
 * parsing yet) and skipped, while an empty array means "no children
 * contributed" and is respected.
 *
 * The picker is keyed on the agent's stable {@link AgentCustomization.uri};
 * duplicates within the session's customization list are coalesced.
 */
export function getEffectiveAgents(
	sessionCustomizations: readonly Customization[] | undefined,
): readonly AgentCustomization[] {
	const seen = new Map<string, AgentCustomization>();
	if (sessionCustomizations) {
		for (const container of sessionCustomizations) {
			if (container.type === CustomizationType.McpServer) {
				continue;
			}
			if ((container.type === CustomizationType.Plugin && !isCustomizationEnabled(container)) || (container.type === CustomizationType.Directory && !container.enabled) || !container.children) {
				continue;
			}
			for (const child of container.children) {
				if (child.type !== CustomizationType.Agent) {
					continue;
				}
				const key = child.uri.toString();
				if (!seen.has(key)) {
					seen.set(key, child);
				}
			}
		}
	}
	const result = [...seen.values()];
	result.sort((a, b) => a.name.localeCompare(b.name) || a.uri.toString().localeCompare(b.uri.toString()));
	return result;
}

/**
 * CreaEditor: merges the draft agents a client resolved locally into the agents the host reports
 * for a session. Agents with the same URI are the same agent, and the client's entry wins.
 *
 * An agent outside the workspace, such as one contributed by an extension, reaches the host as a
 * copy inside the client's synced customization plugin, under another URI. The host resolves a
 * selected agent by its own URI, so once the host reports that copy, the client's draft entry for
 * the same agent (same name and file name) is left out instead of showing the agent twice.
 */
export function mergeClientAgents(
	sessionCustomizations: readonly Customization[] | undefined,
	clientAgents: readonly AgentCustomization[],
): readonly AgentCustomization[] {
	const stateAgents = getEffectiveAgents(sessionCustomizations);
	if (clientAgents.length === 0) {
		return stateAgents;
	}
	const syncedCopies = new Set<string>();
	for (const container of sessionCustomizations ?? []) {
		if (container.type === CustomizationType.McpServer || URI.parse(container.uri).scheme !== SYNCED_CUSTOMIZATION_SCHEME) {
			continue;
		}
		for (const child of container.children ?? []) {
			if (child.type === CustomizationType.Agent) {
				syncedCopies.add(getAgentCopyKey(child));
			}
		}
	}
	const agentsByUri = new Map(stateAgents.map(agent => [agent.uri, agent]));
	for (const agent of clientAgents) {
		if (!agentsByUri.has(agent.uri) && syncedCopies.has(getAgentCopyKey(agent))) {
			continue;
		}
		agentsByUri.set(agent.uri, agent);
	}
	return [...agentsByUri.values()].sort((a, b) => a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri));
}

function getAgentCopyKey(agent: AgentCustomization): string {
	return `${agent.name}\0${basename(URI.parse(agent.uri))}`;
}

/**
 * Filters draft agents by their published plugin container enablement.
 * Unmatched agents remain selectable because they may be loose agents or precede
 * their plugin ref during a client update.
 */
export function getEffectiveClientAgents(
	clientCustomizations: readonly ClientPluginCustomization[] | undefined,
	clientAgents: readonly AgentCustomization[],
): readonly AgentCustomization[] {
	if (!clientCustomizations || clientCustomizations.length === 0) {
		return clientAgents;
	}
	return clientAgents.filter(agent => {
		const agentUri = URI.parse(agent.uri);
		const plugin = clientCustomizations.find(candidate => isEqualOrParent(agentUri, URI.parse(candidate.uri)));
		return !plugin || isCustomizationEnabled(plugin);
	});
}

/**
 * Storage key used by the custom-agent pickers to remember the user's last
 * selection per session-resource scheme. Shared between the Agents Window
 * picker and the workbench chat-editor picker so the two surfaces agree on
 * the default for new (untitled) sessions.
 */
export function agentHostAgentPickerStorageKey(resourceScheme: string): string {
	return `workbench.agentsession.agentHostAgentPicker.${resourceScheme}.selectedAgentUri`;
}

/**
 * Resolves the agent that should be shown for a session:
 * - If the session has a current selection and it exists in the effective list, use it.
 * - Else if a stored agent URI matches an entry in the list, use that entry.
 * - Else `undefined` (the default "Agent" placeholder row).
 *
 * `sessionAgentUri` accepts either a platform {@link URI} instance or a raw
 * URI string. The agent-host protocol
 * {@link import('./state/protocol/state.js').AgentSelection} URI field and the
 * sessions-layer `ISessionAgentRef` both provide URI strings.
 */
export function resolveAgentHostAgent(
	agents: readonly AgentCustomization[],
	sessionAgentUri: URI | string | undefined,
	storedAgentUri: string | undefined,
): AgentCustomization | undefined {
	if (sessionAgentUri !== undefined) {
		const sessionStr = typeof sessionAgentUri === 'string' ? sessionAgentUri : sessionAgentUri.toString();
		const match = agents.find(a => a.uri === sessionStr);
		if (match) {
			return match;
		}
	}
	return storedAgentUri ? agents.find(a => a.uri === storedAgentUri) : undefined;
}
