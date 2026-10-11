/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_HOST_USER_CUSTOMIZATIONS_DIR_ENV_VAR, collectUserCustomizations, findDelegatedUserCustomizations, installUserCustomizations, removeUserCustomizations } from '../../../node/creaeditorDelegation/delegationUserCustomizations.js';

function write(path: string, content: string | Buffer): void {
	fs.mkdirSync(join(path, '..'), { recursive: true });
	fs.writeFileSync(path, content);
}

/** Every file under `dir`, relative, sorted. */
function listFiles(dir: string, prefix = ''): string[] {
	return fs.readdirSync(dir).sort().flatMap(name => fs.statSync(join(dir, name)).isDirectory() ? listFiles(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]);
}

suite('CreaEditor Delegation - personal agents, skills and instructions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(() => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'delegationUserCustomizations');
		const claude = join(dir, 'claude');
		write(join(claude, 'CLAUDE.md'), 'Always answer in Dutch.\n');
		write(join(claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n');
		write(join(claude, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nDeploy.\n');
		write(join(claude, 'skills', 'deploy', 'run.sh'), 'echo deploy\n');
		write(join(claude, 'skills', 'deploy', '.env'), 'TOKEN=FAKE\n');
		write(join(claude, 'skills', 'deploy', 'node_modules', 'x', 'index.js'), 'x\n');
		write(join(claude, 'skills', 'big', 'SKILL.md'), Buffer.alloc(2 * 1024 * 1024, 'a'));
		write(join(claude, 'commands', 'ship.md'), 'Ship it.\n');
		write(join(claude, 'commands', 'settings.json'), '{}\n');
		// Never: credentials, settings and state of the agent.
		write(join(claude, 'settings.json'), '{"apiKeyHelper":"FAKE"}\n');
		write(join(claude, '.credentials.json'), '{"FAKE":true}\n');
		write(join(claude, 'projects', 'p', 's.jsonl'), '{}\n');
		write(join(claude, 'todos', 't.json'), '{}\n');
		// A skill linked from elsewhere.
		write(join(dir, 'shared-skills', 'lint', 'SKILL.md'), 'Lint.\n');
		fs.symlinkSync(join(dir, 'shared-skills', 'lint'), join(claude, 'skills', 'lint'));
		const copilot = join(dir, 'copilot');
		write(join(copilot, 'copilot-instructions.md'), 'Use tabs.\n');
		write(join(copilot, 'agents', 'planner.agent.md'), 'Plan.\n');
		write(join(copilot, 'skills', 'test', 'SKILL.md'), 'Test.\n');
		write(join(copilot, 'mcp-config.json'), '{}\n');
		write(join(copilot, 'config.json'), '{}\n');
		const codex = join(dir, 'codex');
		write(join(codex, 'AGENTS.md'), 'Be brief.\n');
		write(join(codex, 'auth.json'), '{"FAKE":true}\n');
		write(join(codex, 'config.toml'), 'model = "x"\n');
	});

	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('collects them without credentials, state or large files, and the server agents find them by the chat folder', () => {
		const collected = collectUserCustomizations({ claudeConfigDir: join(dir, 'claude'), copilotHome: join(dir, 'copilot'), codexHome: join(dir, 'codex') });
		const root = join(dir, 'server', 'user-customizations');
		const worktree = join(dir, 'server', 'worktrees', 'app-1234');
		const files = installUserCustomizations(root, 'd1', [worktree], 'MacBook', [
			...collected.files,
			// What a broken or hostile request could add: never written.
			{ agent: 'claude', relativePath: '../escape.md', content: '' },
			{ agent: 'claude', relativePath: 'settings.json', content: '' },
			{ agent: 'codex', relativePath: 'prompts/x.md', content: '' },
		]);
		const env = { [AGENT_HOST_USER_CUSTOMIZATIONS_DIR_ENV_VAR]: root };
		const found = findDelegatedUserCustomizations(join(worktree, 'src'), env);
		const installed = listFiles(join(root, 'd1'));
		const other = findDelegatedUserCustomizations(join(dir, 'server', 'worktrees', 'app-9999'), env);
		removeUserCustomizations(root, 'd1');
		assert.deepStrictEqual({
			collected: collected.files.map(file => `${file.agent}/${file.relativePath}`),
			skipped: collected.skipped,
			files,
			installed,
			found,
			other,
			afterRemove: fs.readdirSync(root),
		}, {
			collected: [
				'claude/CLAUDE.md',
				'claude/agents/reviewer.md',
				'claude/skills/deploy/SKILL.md',
				'claude/skills/deploy/run.sh',
				'claude/skills/lint/SKILL.md',
				'claude/commands/ship.md',
				'copilot/copilot-instructions.md',
				'copilot/agents/planner.agent.md',
				'copilot/skills/test/SKILL.md',
				'codex/AGENTS.md',
			],
			skipped: ['claude/skills/big/SKILL.md', 'claude/skills/deploy/.env', 'claude/commands/settings.json'],
			files: 10,
			installed: [
				'claude/.claude-plugin/plugin.json',
				'claude/CLAUDE.md',
				'claude/agents/reviewer.md',
				'claude/commands/ship.md',
				'claude/skills/deploy/SKILL.md',
				'claude/skills/deploy/run.sh',
				'claude/skills/lint/SKILL.md',
				'codex/AGENTS.md',
				'copilot/.plugin/plugin.json',
				'copilot/agents/planner.agent.md',
				'copilot/copilot-instructions.md',
				'copilot/skills/test/SKILL.md',
				'manifest.json',
			],
			found: {
				claudePluginDir: join(root, 'd1', 'claude'),
				claudeMemory: 'Always answer in Dutch.',
				copilotPluginDir: join(root, 'd1', 'copilot'),
				copilotInstructions: 'Use tabs.',
				codexInstructions: 'Be brief.',
			},
			other: undefined,
			afterRemove: [],
		});
	});

	test('stops at the total size', () => {
		const collected = collectUserCustomizations({ claudeConfigDir: join(dir, 'claude'), copilotHome: join(dir, 'copilot'), codexHome: join(dir, 'codex'), maxTotalBytes: 40 });
		assert.deepStrictEqual(collected.files.map(file => `${file.agent}/${file.relativePath}`), ['claude/CLAUDE.md']);
	});
});
