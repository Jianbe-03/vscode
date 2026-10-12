/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileStat, FileSystemWatcher, RelativePattern } from 'vscode';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { IFileSystemService } from '../../../filesystem/common/fileSystemService';
import { FileType } from '../../../filesystem/common/fileTypes';
import { IGitService } from '../../../git/common/gitService';
import { ILogService } from '../../../log/common/logService';
import { TestLogService } from '../../../testing/common/testLogService';
import { IGatewayCostEntry } from '../../common/gatewayTrackingService';
import { GatewayTrackingService } from '../gatewayTrackingServiceImpl';

vi.mock('vscode', async importOriginal => ({
	...await importOriginal<typeof import('vscode')>(),
	RelativePattern: class {
		constructor(readonly baseUri: URI, readonly pattern: string) { }
	},
}));

const STORAGE = URI.file('/user/globalStorage/github.copilot-chat');
const LEDGER = URI.joinPath(STORAGE, 'creaeditor-gateway-costs.jsonl');

/** One file system shared by the extension hosts of several windows, with watchers on file names. */
class SharedFileSystem implements IFileSystemService {
	declare readonly _serviceBrand: undefined;
	readonly files = new Map<string, string>();
	private readonly _watchers: { folder: string; names: string[]; onDidChange: Emitter<URI> }[] = [];

	async readFile(uri: URI): Promise<Uint8Array> {
		const content = this.files.get(uri.path);
		if (content === undefined) {
			throw new Error('ENOENT');
		}
		return new TextEncoder().encode(content);
	}

	async writeFile(uri: URI, content: Uint8Array): Promise<void> {
		this.files.set(uri.path, new TextDecoder().decode(content));
		this._fire(uri);
	}

	async rename(source: URI, target: URI): Promise<void> {
		const content = this.files.get(source.path);
		if (content === undefined) {
			throw new Error('ENOENT');
		}
		this.files.delete(source.path);
		this.files.set(target.path, content);
		this._fire(target);
	}

	async delete(uri: URI): Promise<void> {
		this.files.delete(uri.path);
	}

	async createDirectory(): Promise<void> { }

	async copy(): Promise<void> {
		throw new Error('not implemented');
	}

	isWritableFileSystem(): boolean {
		return true;
	}

	async readDirectory(): Promise<[string, FileType][]> {
		return [];
	}

	async stat(): Promise<FileStat> {
		throw new Error('ENOENT');
	}

	createFileSystemWatcher(glob: string | RelativePattern): FileSystemWatcher {
		const pattern = glob as RelativePattern;
		const onDidChange = new Emitter<URI>();
		this._watchers.push({ folder: URI.from(pattern.baseUri).path, names: pattern.pattern.replace(/^\{|\}$/g, '').split(','), onDidChange });
		const none = new Emitter<URI>().event;
		return { onDidChange: onDidChange.event, onDidCreate: none, onDidDelete: none, dispose: () => onDidChange.dispose() } as Partial<FileSystemWatcher> as FileSystemWatcher;
	}

	private _fire(uri: URI): void {
		const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
		for (const watcher of this._watchers) {
			if (uri.path === `${watcher.folder}/${name}` && watcher.names.includes(name)) {
				watcher.onDidChange.fire(uri);
			}
		}
	}
}

describe('GatewayTrackingService shared ledger', () => {
	const disposables = new DisposableStore();
	let fileSystem: SharedFileSystem;

	beforeEach(() => {
		vi.useFakeTimers();
		fileSystem = new SharedFileSystem();
	});

	afterEach(() => {
		disposables.clear();
		vi.useRealTimers();
	});

	function createWindow(): GatewayTrackingService {
		const context = { globalStorageUri: STORAGE } as Partial<IVSCodeExtensionContext> as IVSCodeExtensionContext;
		return disposables.add(new GatewayTrackingService(context, fileSystem, {} as IGitService, new TestLogService() as ILogService));
	}

	function record(service: GatewayTrackingService, chatTitle: string): string {
		return service.recordRequest({ chatId: chatTitle, rootChatId: chatTitle, chatTitle, gateway: 'openrouter', gatewayHost: 'openrouter.ai', model: 'm' });
	}

	/** Lets the debounced saves and watcher reloads of every window run. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(1500);
		}
	}

	function summary(entries: readonly IGatewayCostEntry[]): string[] {
		return entries.map(entry => `${entry.chatTitle}:${entry.cost ?? '-'}`).sort();
	}

	function ledger(): string[] {
		const lines = (fileSystem.files.get(LEDGER.path) ?? '').split('\n').filter(line => line.trim());
		const byId = new Map<string, IGatewayCostEntry>(lines.map(line => {
			const entry: IGatewayCostEntry = JSON.parse(line);
			return [entry.id, entry];
		}));
		return summary([...byId.values()]);
	}

	it('keeps the entries of both windows, shows each window the other\'s, and the newest version of an entry wins', async () => {
		const editor = createWindow();
		const agents = createWindow();
		await settle();

		const rename = record(agents, 'Rename');
		vi.advanceTimersByTime(1);
		const explain = record(editor, 'Explain');
		await settle();
		agents.updateRequest(rename, { cost: 0.5 });
		editor.updateRequest(explain, { cost: 0.25 });
		record(editor, 'Commit');
		await settle();

		expect({ editor: summary(editor.entries), agents: summary(agents.entries), ledger: ledger() }).toEqual({
			editor: ['Commit:-', 'Explain:0.25', 'Rename:0.5'],
			agents: ['Commit:-', 'Explain:0.25', 'Rename:0.5'],
			ledger: ['Commit:-', 'Explain:0.25', 'Rename:0.5'],
		});
	});

	it('writes back its own entries when another window overwrote the ledger with an older copy', async () => {
		const editor = createWindow();
		const agents = createWindow();
		const rename = record(agents, 'Rename');
		await settle();
		agents.updateRequest(rename, { cost: 0.5 });
		await settle();

		// A window that saved at the same moment, from a copy without the update and without its own entry.
		const stale = (fileSystem.files.get(LEDGER.path) ?? '').replace('"cost":0.5', '"cost":0.1');
		await fileSystem.writeFile(LEDGER, new TextEncoder().encode(stale));
		await settle();

		expect({ editor: summary(editor.entries), agents: summary(agents.entries), ledger: ledger() }).toEqual({
			editor: ['Rename:0.5'],
			agents: ['Rename:0.5'],
			ledger: ['Rename:0.5'],
		});
	});

	it('clears the ledger for every window, also when another window still has the old entries', async () => {
		const editor = createWindow();
		const agents = createWindow();
		record(agents, 'Rename');
		record(editor, 'Explain');
		await settle();

		vi.advanceTimersByTime(10);
		editor.clear();
		await settle();
		vi.advanceTimersByTime(10);
		record(agents, 'After');
		await settle();

		expect({ editor: summary(editor.entries), agents: summary(agents.entries), ledger: ledger() }).toEqual({
			editor: ['After:-'],
			agents: ['After:-'],
			ledger: ['After:-'],
		});
	});
});
