/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { DeliverProcessorService } from './DeliverProcessorService.js';

function createService() {
	const existsBy = vi.fn().mockResolvedValue(false);
	const signedPost = vi.fn().mockResolvedValue(undefined);
	const service = Object.create(DeliverProcessorService.prototype) as DeliverProcessorService;
	Object.assign(service, {
		instancesRepository: { existsBy },
		utilityService: { isFederationAllowedUri: () => true, toPuny: (host: string) => host, isDeliverSuspendedSoftware: () => false },
		meta: { enableStatsForFederatedInstances: false },
		federatedInstanceService: { fetch: vi.fn().mockResolvedValue(null) },
		apRequestService: { signedPost },
		apRequestChart: { deliverSucc: vi.fn() },
		federationChart: { deliverd: vi.fn() },
	});
	const job = { data: { to: 'https://remote.example/inbox', user: { id: 'user' }, content: '{}' } };
	return { service, existsBy, signedPost, job };
}

describe('delivery suspension state', () => {
	test('observes suspension immediately after an earlier successful delivery', async () => {
		const { service, existsBy, signedPost, job } = createService();
		await expect(service.process(job as never)).resolves.toBe('Success');
		existsBy.mockResolvedValue(true);
		await expect(service.process(job as never)).resolves.toBe('skip (suspended)');
		expect(signedPost).toHaveBeenCalledOnce();
		expect(existsBy).toHaveBeenCalledTimes(2);
		expect(existsBy).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'remote.example' }));
	});

	test('delivers immediately after a suspended instance is resumed', async () => {
		const { service, existsBy, signedPost, job } = createService();
		existsBy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await expect(service.process(job as never)).resolves.toBe('skip (suspended)');
		await expect(service.process(job as never)).resolves.toBe('Success');
		expect(signedPost).toHaveBeenCalledOnce();
	});

	test('retries rather than delivering or discarding a job when the current state cannot be read', async () => {
		const { service, existsBy, signedPost, job } = createService();
		const error = new Error('database unavailable');
		existsBy.mockRejectedValue(error);
		await expect(service.process(job as never)).rejects.toBe(error);
		expect(signedPost).not.toHaveBeenCalled();
	});
});
