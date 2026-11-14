/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { HeapSnapshotData } from 'diagnostics-shared/heap-snapshot';

export const memoryPhases = ['afterGc'] as const;

export type MemoryPhase = typeof memoryPhases[number];

export type MemoryStability = {
	converged: boolean;
	readingCount: number;
	elapsedMs: number;
	maxAbsoluteSlopesKiBPerSecond: Record<string, number> | null;
};

export type MemorySample = {
	timestamp: string;
	phases: Record<MemoryPhase, {
		memoryUsage: Record<string, number>;
		memoryStability: MemoryStability;
		heapSnapshot: HeapSnapshotData | null;
	}>;
};

export type MemoryReport = {
	timestamp: string;
	sampleCount: number;
	aggregation: string;
	comparison?: {
		strategy: string;
		rounds: number;
		warmupRounds: number;
		heapSnapshotRounds?: number;
		startedAt: string;
	};
	summary: Record<MemoryPhase, {
		memoryUsage: Record<string, number>;
		heapSnapshot?: HeapSnapshotData;
	}>;
	samples: (MemorySample & {
		round: number;
	})[];
};
