/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readBooleanEnv, readIntegerEnv } from 'diagnostics-shared/env';
import { analyzeHeapSnapshot, defaultHeapSnapshotBreakdownTopN, type HeapSnapshotData } from 'diagnostics-shared/heap-snapshot';
import { getMemoryUsage, getSmapsRollupMemoryUsage } from './proc';
import {
	forkBackendServer,
	getRuntimeMemoryUsage,
	requestHeapSnapshot,
	shutdownBackendServer,
	triggerGc,
	waitForServerReady,
} from './server';
import { measureMemoryUntilStable } from './stability';
import type { MemorySample } from '../types';

export type MeasureBackendMemoryOptions = {
	heapSnapshot?: boolean;
	heapSnapshotSavePath?: string | null;
	heapSnapshotBreakdownTopN?: number;
	heapSnapshotTimeoutMs?: number;
	startupTimeoutMs?: number;
	ipcTimeoutMs?: number;
};

function resolveOptions(options: MeasureBackendMemoryOptions) {
	return {
		heapSnapshot: options.heapSnapshot ?? readBooleanEnv('MK_MEMORY_HEAP_SNAPSHOT', false),
		heapSnapshotSavePath: options.heapSnapshotSavePath ?? null,
		heapSnapshotBreakdownTopN: options.heapSnapshotBreakdownTopN ?? readIntegerEnv('MK_MEMORY_HEAP_SNAPSHOT_BREAKDOWN_TOP_N', defaultHeapSnapshotBreakdownTopN, 1),
		heapSnapshotTimeoutMs: options.heapSnapshotTimeoutMs ?? readIntegerEnv('MK_MEMORY_HEAP_SNAPSHOT_TIMEOUT_MS', 120000, 1),
		startupTimeoutMs: options.startupTimeoutMs ?? readIntegerEnv('MK_MEMORY_STARTUP_TIMEOUT_MS', 120000, 1),
		ipcTimeoutMs: options.ipcTimeoutMs ?? readIntegerEnv('MK_MEMORY_IPC_TIMEOUT_MS', 30000, 1),
	};
}

export async function measureBackendMemory(backendDir: string, options: MeasureBackendMemoryOptions = {}): Promise<MemorySample> {
	const settings = resolveOptions(options);
	const serverProcess = forkBackendServer(backendDir);

	const serverReady = waitForServerReady(serverProcess, settings.startupTimeoutMs);

	serverProcess.stdout?.on('data', (data) => {
		process.stderr.write(`[server stdout] ${data}`);
	});

	serverProcess.stderr?.on('data', (data) => {
		process.stderr.write(`[server stderr] ${data}`);
	});

	serverProcess.on('error', (err) => {
		process.stderr.write(`[server error] ${err}\n`);
	});

	try {
		const startupStartTime = Date.now();
		await serverReady;

		const startupTime = Date.now() - startupStartTime;
		process.stderr.write(`Server started in ${startupTime}ms\n`);

		await triggerGc(serverProcess, settings.ipcTimeoutMs);

		const pid = serverProcess.pid!;
		const stableSmapsRollup = await measureMemoryUntilStable(() => getSmapsRollupMemoryUsage(pid));
		const afterGc = {
			memoryUsage: {
				...await getMemoryUsage(pid),
				...stableSmapsRollup.memoryUsage,
				...await getRuntimeMemoryUsage(serverProcess, settings.ipcTimeoutMs),
			},
			stability: stableSmapsRollup.stability,
		};
		process.stderr.write(`Memory ${afterGc.stability.converged ? 'stabilized' : 'did not stabilize'} after ${afterGc.stability.readingCount} readings over ${Math.round(afterGc.stability.elapsedMs)}ms\n`);

		const heapSnapshotAfterGc = await getHeapSnapshotStatistics(serverProcess, settings);

		return {
			timestamp: new Date().toISOString(),
			phases: {
				afterGc: {
					memoryUsage: afterGc.memoryUsage,
					memoryStability: afterGc.stability,
					heapSnapshot: heapSnapshotAfterGc,
				},
			},
		};
	} finally {
		await shutdownBackendServer(serverProcess);
	}
}

async function getHeapSnapshotStatistics(
	serverProcess: ReturnType<typeof forkBackendServer>,
	settings: ReturnType<typeof resolveOptions>,
): Promise<HeapSnapshotData | null> {
	if (!settings.heapSnapshot) return null;

	const snapshotPath = join(tmpdir(), `misskey-backend-heap-${process.pid}-${serverProcess.pid}-${Date.now()}.heapsnapshot`);
	const writtenPath = await requestHeapSnapshot(serverProcess, snapshotPath, settings.heapSnapshotTimeoutMs);

	try {
		if (settings.heapSnapshotSavePath != null && settings.heapSnapshotSavePath !== '') {
			await fs.mkdir(dirname(settings.heapSnapshotSavePath), { recursive: true });
			await fs.copyFile(writtenPath, settings.heapSnapshotSavePath);
		}

		const snapshot = JSON.parse(await fs.readFile(writtenPath, 'utf-8'));
		return analyzeHeapSnapshot(snapshot, { breakdownTopN: settings.heapSnapshotBreakdownTopN });
	} finally {
		await fs.unlink(writtenPath).catch(err => {
			process.stderr.write(`Failed to delete heap snapshot ${writtenPath}: ${err.message}\n`);
		});
	}
}
