/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import cluster from 'node:cluster';
import { describe, expect, test, vi } from 'vitest';
import { forceStopClusterWorkers, shutdownClusterWorkers } from '@/boot/cluster-shutdown.js';

vi.mock('node:cluster', () => ({ default: { workers: {} } }));

describe('cluster shutdown', () => {
	test('forwards SIGTERM without disconnecting IPC and waits for child exit', async () => {
		const worker = Object.assign(new EventEmitter(), { id: 1, isDead: () => false, process: { kill: vi.fn() }, kill: vi.fn() });
		Object.defineProperty(cluster, 'workers', { configurable: true, value: { 1: worker } });
		let finished = false;
		const shutdown = shutdownClusterWorkers().then(() => { finished = true; });
		expect(worker.process.kill).toHaveBeenCalledWith('SIGTERM');
		expect(worker.kill).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(finished).toBe(false);
		worker.emit('exit', 0, null);
		await shutdown;
		expect(finished).toBe(true);
	});

	test('reports a child shutdown failure and can kill workers at the outer deadline', async () => {
		const worker = Object.assign(new EventEmitter(), { id: 1, isDead: () => false, process: { kill: vi.fn() } });
		Object.defineProperty(cluster, 'workers', { configurable: true, value: { 1: worker } });
		const shutdown = shutdownClusterWorkers();
		const rejected = expect(shutdown).rejects.toThrow('Cluster workers failed to shut down cleanly');
		forceStopClusterWorkers();
		expect(worker.process.kill).toHaveBeenLastCalledWith('SIGKILL');
		worker.emit('exit', null, 'SIGKILL');
		await rejected;
	});
});
