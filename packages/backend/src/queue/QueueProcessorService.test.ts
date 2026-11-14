/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { QueueProcessorService } from './QueueProcessorService.js';
import { QUEUE } from './const.js';

const workers = vi.hoisted(() => new Map<string, (job: unknown) => Promise<unknown>>());

vi.mock('bullmq', async importOriginal => ({
	...await importOriginal<typeof import('bullmq')>(),
	Worker: class {
		constructor(name: string, process: (job: unknown) => Promise<unknown>) {
			workers.set(name, process);
		}

		on() {
			return this;
		}
	},
}));

describe('webhook failure telemetry', () => {
	test.each([QUEUE.USER_WEBHOOK_DELIVER, QUEUE.SYSTEM_WEBHOOK_DELIVER])('omits credentials and payloads from %s failures', async (queue) => {
		const error = Object.assign(new Error('delivery failed'), { request: { headers: { secret: 'private-secret' } } });
		const logger = { error: vi.fn(), createSubLogger: vi.fn() };
		logger.createSubLogger.mockReturnValue(logger);
		const captureMessage = vi.fn();
		const telemetry = { startSpan: (_name: string, run: () => unknown) => run(), captureMessage };
		const processor = { process: vi.fn().mockRejectedValue(error) };
		const dependencies = [
			{ redisForJobQueue: {} }, { logger }, telemetry,
			...Array.from({ length: QueueProcessorService.length - 3 }, () => processor),
		] as unknown as ConstructorParameters<typeof QueueProcessorService>;
		new QueueProcessorService(...dependencies);
		const job = {
			id: 'job-id', name: 'webhook-id', attemptsMade: 2, timestamp: Date.now(),
			data: { secret: 'private-secret', content: { text: 'private-content' }, to: 'https://hooks.example/private-token' },
		};

		await expect(workers.get(queue)!(job)).rejects.toBe(error);
		expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('delivery failed'), {
			level: 'error', extra: { jobId: 'job-id', attemptsMade: 2 },
		});
		const report = JSON.stringify(captureMessage.mock.calls);
		for (const secret of ['private-secret', 'private-content', 'private-token']) {
			expect(report).not.toContain(secret);
		}
	});
});
