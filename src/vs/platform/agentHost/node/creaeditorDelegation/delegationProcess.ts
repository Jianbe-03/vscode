/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: runs `git` and `gh` for Delegate to Server. Every call goes through an
// `IDelegationProcessRunner`, so tests can replace the process (never push or call GitHub in tests).

import { spawn } from 'child_process';

export interface IDelegationProcessResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface IDelegationProcessOptions {
	readonly cwd: string;
	/** Added to the environment of this process. */
	readonly env?: Readonly<Record<string, string>>;
}

/** Runs a command and collects its output. Never throws for a non-zero exit code. */
export interface IDelegationProcessRunner {
	run(command: string, args: readonly string[], options: IDelegationProcessOptions): Promise<IDelegationProcessResult>;
}

/** Thrown when a command fails; the message names the command and its error output (never the env). */
export class DelegationCommandError extends Error {
	constructor(readonly command: string, readonly args: readonly string[], readonly result: IDelegationProcessResult) {
		super(`${command} ${args[0] ?? ''} failed (exit code ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
		this.name = 'DelegationCommandError';
	}
}

/** The runner that starts real processes. Git never prompts: there is nobody to answer. */
export const nodeDelegationProcessRunner: IDelegationProcessRunner = {
	run(command, args, options) {
		return new Promise(resolve => {
			const child = spawn(command, args, {
				cwd: options.cwd,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			child.stdout.on('data', (data: Buffer) => stdout.push(data));
			child.stderr.on('data', (data: Buffer) => stderr.push(data));
			child.on('error', error => resolve({ code: -1, stdout: '', stderr: error.message }));
			child.on('close', code => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
		});
	}
};

/** Runs `git` in `cwd`; throws {@link DelegationCommandError} on failure and answers stdout. */
export async function git(runner: IDelegationProcessRunner, cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<string> {
	const result = await runner.run('git', args, { cwd, ...(env ? { env } : {}) });
	if (result.code !== 0) {
		throw new DelegationCommandError('git', args, result);
	}
	return result.stdout;
}

/** Runs `git` and answers whether it exited with 0. */
export async function gitSucceeds(runner: IDelegationProcessRunner, cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): Promise<boolean> {
	return (await runner.run('git', args, { cwd, ...(env ? { env } : {}) })).code === 0;
}

/** The identity of commits CreaEditor makes itself (snapshots of uncommitted changes). */
export function delegationCommitIdentity(name: string): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: 'creaeditor@localhost',
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: 'creaeditor@localhost',
	};
}
