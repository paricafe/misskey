/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, test } from 'vitest';

describe('shutdown process signals', () => {
	test.skipIf(process.platform === 'win32')('survives a process-group signal followed by forwarded signals until drain completes', async () => {
		// Execute the production signal handler in a separate process without
		// starting databases, or installing signal handlers on the test runner.
		const moduleUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
		const readyUrl = moduleUrl(readFileSync(new URL('../../../src/boot/ready.ts', import.meta.url), 'utf8'));
		const handlerUrl = moduleUrl(readFileSync(new URL('../../../src/boot/shutdown-handler.ts', import.meta.url), 'utf8').replace("'./ready.js'", JSON.stringify(readyUrl)));
		const child = spawn(process.execPath, ['--input-type=module', '--eval', `
			import { installShutdownSignalHandlers } from ${JSON.stringify(handlerUrl)};
			let finishDrain;
			const draining = new Promise(resolve => { finishDrain = resolve; });
			process.on('message', message => {
				if (message === 'probe') process.send('alive');
				if (message === 'finish') finishDrain();
			});
			installShutdownSignalHandlers({
				shutdownTasks: [async () => { process.send('draining'); await draining; }],
				finalizeTasks: [async () => { process.stdout.write('logging flushed'); }],
			});
			process.send('ready');
		`], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
		let output = '';
		child.stdout?.on('data', chunk => { output += chunk; });
		const exited = once(child, 'exit');
		try {
			expect((await once(child, 'message'))[0]).toBe('ready');
			const draining = once(child, 'message');
			process.kill(-child.pid!, 'SIGTERM');
			expect((await draining)[0]).toBe('draining');
			child.kill('SIGTERM');
			child.kill('SIGINT');
			const alive = once(child, 'message');
			child.send('probe');
			expect((await alive)[0]).toBe('alive');
			child.send('finish');
			expect(await exited).toEqual([0, null]);
			expect(output).toBe('logging flushed');
		} finally {
			if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
			await exited;
		}
	});
});
