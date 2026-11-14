/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { QueueService } from './QueueService.js';

describe('account deletion queue identity', () => {
	test('deduplicates pending deletion by user and deletion mode without pinning completed jobs', async () => {
		const add = vi.fn().mockResolvedValue({ id: 'job' });
		const service = Object.create(QueueService.prototype) as QueueService;
		Object.assign(service, { dbQueue: { add } });
		await service.createDeleteAccountJob({ id: 'alice' });
		await service.createDeleteAccountJob({ id: 'alice' }, { soft: false });
		await service.createDeleteAccountJob({ id: 'alice' }, { soft: true });
		await service.createDeleteAccountJob({ id: 'bob' });
		const options = add.mock.calls.map(call => call[2]);
		expect(options[0].deduplication).toEqual(options[1].deduplication);
		expect(options[2].deduplication).not.toEqual(options[0].deduplication);
		expect(options[3].deduplication).not.toEqual(options[0].deduplication);
		for (const option of options) {
			expect(option.jobId).toBeUndefined();
			expect(option.deduplication.ttl).toBeUndefined();
		}
	});
});
