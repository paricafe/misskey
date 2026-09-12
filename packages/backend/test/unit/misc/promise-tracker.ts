/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';

describe('promise tracker during production shutdown', () => {
	test('waits for tracked production work, including work registered while draining', async () => {
		vi.resetModules();
		vi.stubEnv('NODE_ENV', 'production');
		try {
			const { trackPromise, allSettled } = await import('@/misc/promise-tracker.js');
			let finishFirst!: () => void;
			let finishSecond!: () => void;
			const first = new Promise<void>(resolve => { finishFirst = resolve; });
			const second = new Promise<void>(resolve => { finishSecond = resolve; });
			trackPromise(first.then(() => { trackPromise(second); }));
			let drained = false;
			const shutdown = allSettled().then(() => { drained = true; });
			await Promise.resolve();
			expect(drained).toBe(false);
			finishFirst();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(drained).toBe(false);
			finishSecond();
			await shutdown;
			expect(drained).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test('removes rejected work without creating an unhandled rejection', async () => {
		vi.resetModules();
		vi.stubEnv('NODE_ENV', 'production');
		try {
			const { trackPromise, allSettled } = await import('@/misc/promise-tracker.js');
			trackPromise(Promise.reject(new Error('background work failed')));
			await allSettled();
			await new Promise<void>(resolve => setImmediate(resolve));
			await allSettled();
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
