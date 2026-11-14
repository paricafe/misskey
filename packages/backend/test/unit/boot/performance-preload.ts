/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const preload = fileURLToPath(new URL('../../../scripts/performance-preload.mjs', import.meta.url));

describe('opt-in process performance metrics', () => {
	test('does not keep an otherwise idle process alive', () => {
		const output = execFileSync(process.execPath, ['--import', preload, '--eval', ''], { timeout: 5000 });
		expect(output.toString()).toBe('');
	});

	test('reports process resource intervals without request or account data', () => {
		const result = spawnSync(process.execPath, ['--import', preload, '--eval', 'setTimeout(() => {}, 80)'], {
			timeout: 5000,
			stdio: ['ignore', 'pipe', 'pipe'],
			encoding: 'utf8',
			env: { ...process.env, MK_PERFORMANCE_INTERVAL_MS: '20', MK_ONLY_SERVER: '1', MK_ONLY_QUEUE: '', MK_DISABLE_CLUSTERING: '1' },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('');
		const samples = result.stderr.trim().split('\n').map(line => JSON.parse(line));
		expect(samples.length).toBeGreaterThanOrEqual(2);
		for (const sample of samples) {
			expect(sample).toMatchObject({ type: 'performance', role: 'server', gc: { count: expect.any(Number), durationMs: expect.any(Number) } });
			expect(sample.intervalMs).toBeGreaterThan(0);
			expect(sample.cpuPercent).toBeGreaterThanOrEqual(0);
			expect(sample.memory.rss).toBeGreaterThan(0);
			expect(sample.eventLoopUtilization).toBeGreaterThanOrEqual(0);
			expect(sample.eventLoopUtilization).toBeLessThanOrEqual(1);
		}
	});
});
