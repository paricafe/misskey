/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { superviseWorker } from '@/boot/worker-supervisor.js';
import type { Worker } from 'node:cluster';

describe('worker readiness supervisor', () => {
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	function setup() {
		vi.useFakeTimers();
		const workers: (EventEmitter & { id: number })[] = [];
		let stopping = false;
		const fork = vi.fn(() => {
			const worker = Object.assign(new EventEmitter(), { id: workers.length + 1 });
			workers.push(worker);
			return worker as Worker;
		});
		const onFatal = vi.fn();
		const onRestart = vi.fn();
		const readiness = superviseWorker({ fork, isStopping: () => stopping, onFatal, onRestart });
		return { workers, fork, onFatal, onRestart, readiness, stop: () => { stopping = true; } };
	}

	test('keeps initial readiness attached to a replacement and recovers after startup too', async () => {
		const { workers, readiness, fork, stop } = setup();
		let ready = false;
		void readiness.then(() => { ready = true; });
		workers[0].emit('exit', 1, null);
		await vi.advanceTimersByTimeAsync(999);
		expect(fork).toHaveBeenCalledTimes(1);
		expect(ready).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		workers[1].emit('message', 'ready');
		await readiness;
		expect(ready).toBe(true);
		workers[1].emit('exit', 1, null);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fork).toHaveBeenCalledTimes(3);
		stop();
		workers[2].emit('exit', 0, null);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fork).toHaveBeenCalledTimes(3);
	});

	test('does not fork a queued replacement once shutdown has begun', async () => {
		const { workers, readiness, fork, stop } = setup();
		workers[0].emit('exit', 1, null);
		stop();
		await vi.advanceTimersByTimeAsync(1_000);
		await readiness;
		expect(fork).toHaveBeenCalledTimes(1);
	});

	test('fails startup clearly on listenFailed without restarting', async () => {
		const { workers, readiness, fork, onFatal } = setup();
		const rejected = expect(readiness).rejects.toThrow('Worker 1 could not listen');
		workers[0].emit('message', 'listenFailed');
		workers[0].emit('exit', 1, null);
		await rejected;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onFatal).toHaveBeenCalledOnce();
		expect(fork).toHaveBeenCalledTimes(1);
	});

	test('also handles listenFailed in a replacement after initial readiness', async () => {
		const { workers, readiness, fork, onFatal } = setup();
		workers[0].emit('message', 'ready');
		await readiness;
		workers[0].emit('exit', 1, null);
		await vi.advanceTimersByTimeAsync(1_000);
		workers[1].emit('message', 'listenFailed');
		workers[1].emit('exit', 1, null);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onFatal).toHaveBeenCalledOnce();
		expect(fork).toHaveBeenCalledTimes(2);
	});

	test('backs off repeated initial failures and gives up after five attempts', async () => {
		const { workers, readiness, fork, onFatal, onRestart } = setup();
		const rejected = expect(readiness).rejects.toThrow('Worker startup failed 5 times');
		for (let attempt = 0; attempt < 5; attempt++) {
			workers[attempt].emit('exit', 1, null);
			if (attempt < 4) await vi.advanceTimersByTimeAsync(1_000 * (2 ** attempt));
		}
		await rejected;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onRestart.mock.calls.map(([, delay]) => delay)).toEqual([1_000, 2_000, 4_000, 8_000]);
		expect(fork).toHaveBeenCalledTimes(5);
		expect(onFatal).toHaveBeenCalledOnce();
	});

	test('caps recovery backoff and resets it after a stable worker', async () => {
		const { workers, readiness, onRestart, stop } = setup();
		workers[0].emit('message', 'ready');
		await readiness;
		const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
		for (const [index, delay] of delays.entries()) {
			workers[index].emit('exit', 1, null);
			await vi.advanceTimersByTimeAsync(delay);
		}
		expect(onRestart.mock.calls.map(([, delay]) => delay)).toEqual(delays);
		await vi.advanceTimersByTimeAsync(60_000);
		workers.at(-1)!.emit('exit', 1, null);
		expect(onRestart).toHaveBeenLastCalledWith(8, 1_000);
		stop();
		await vi.advanceTimersByTimeAsync(1_000);
	});

	test.skipIf(process.platform === 'win32')('becomes ready after a real startup crash and supervises later replacements', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'misskey-worker-supervisor-'));
		const source = await readFile(new URL('../../../src/boot/worker-supervisor.ts', import.meta.url), 'utf8');
		const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
		const fixture = join(directory, 'cluster.mjs');
		await writeFile(fixture, `
			import cluster from 'node:cluster';
			import { superviseWorker } from ${JSON.stringify(moduleUrl)};
			if (cluster.isPrimary) {
				let attempts = 0;
				let stopping = false;
				let current;
				cluster.on('message', (worker, message) => {
					if (message === 'ready') process.send({ type: 'worker-ready', id: worker.id });
				});
				process.on('message', async message => {
					if (message === 'replace') current.process.kill('SIGKILL');
					if (message === 'stop') {
						stopping = true;
						current.once('exit', () => process.exit(0));
						current.process.kill('SIGTERM');
					}
				});
				await superviseWorker({
					fork: () => current = cluster.fork({ ATTEMPT: String(++attempts) }),
					isStopping: () => stopping,
					onRestart: (id, delay) => process.send({ type: 'restart', id, delay }),
					onFatal: error => { console.error(error); process.exit(1); },
				});
				process.send({ type: 'master-ready', attempts });
			} else {
				if (process.env.ATTEMPT === '1') process.exit(1);
				process.on('SIGTERM', () => process.exit(0));
				setInterval(() => {}, 1000);
				process.send('ready');
			}
		`);
		const child = spawn(process.execPath, [fixture], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
		const exited = once(child, 'exit');
		const messages: { type: string; id?: number; attempts?: number; delay?: number }[] = [];
		child.on('message', message => messages.push(message as typeof messages[number]));
		let stderr = '';
		child.stderr?.on('data', chunk => { stderr += chunk; });
		try {
			await expect.poll(() => messages.find(message => message.type === 'master-ready'), { timeout: 5_000 }).toEqual({ type: 'master-ready', attempts: 2 });
			expect(messages.filter(message => message.type === 'restart')).toEqual([{ type: 'restart', id: 1, delay: 1_000 }]);
			child.send('replace');
			await expect.poll(() => messages.filter(message => message.type === 'worker-ready').length, { timeout: 5_000 }).toBe(2);
			expect(messages.filter(message => message.type === 'master-ready')).toHaveLength(1);
			child.send('stop');
			expect(await exited, stderr).toEqual([0, null]);
		} finally {
			if (child.exitCode == null && child.signalCode == null) process.kill(-child.pid!, 'SIGKILL');
			await exited;
			await rm(directory, { recursive: true, force: true });
		}
	}, 15_000);
});
