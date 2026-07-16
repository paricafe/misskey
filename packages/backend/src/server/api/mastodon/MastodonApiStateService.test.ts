/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from './errors.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';

describe(MastodonApiStateService, () => {
	const createdAt = new Date('2026-07-17T00:00:00.000Z');
	const updatedAt = new Date('2026-07-17T00:01:00.000Z');

	function state(version: number, value: unknown = { lastReadId: String(version) }) {
		return {
			id: 'state-id',
			userId: 'u1',
			tokenId: null,
			kind: 'marker',
			key: 'home',
			value,
			version,
			createdAt,
			updatedAt,
			expiresAt: null,
		};
	}

	function createService(queryResults: unknown[][] = []) {
		const repository = {
			query: vi.fn(),
			find: vi.fn(),
			findOneBy: vi.fn(),
			delete: vi.fn(),
		};
		for (const result of queryResults) repository.query.mockResolvedValueOnce(result);
		const idService = { gen: vi.fn().mockReturnValue('state-id') };
		return {
			service: new MastodonApiStateService(repository as never, idService as never),
			repository,
			idService,
		};
	}

	test('stores one independently versioned value per user, kind, and key', async () => {
		const { service, repository } = createService([
			[state(1)],
			[state(2, { lastReadId: '2' })],
		]);

		const first = await service.put({ userId: 'u1', kind: 'marker', key: 'home', value: { lastReadId: '1' } });
		const second = await service.put({ userId: 'u1', kind: 'marker', key: 'home', value: { lastReadId: '2' } });

		expect(second.version).toBe(first.version + 1);
		expect(repository.query.mock.calls[0][0]).toContain('ON CONFLICT ("userId", "kind", "key") DO UPDATE');
		expect(repository.query.mock.calls[0][0]).toContain('"version" = "mastodon_user_state"."version" + 1');
	});

	test('rejects a stale conditional write', async () => {
		const { service, repository } = createService([[]]);

		await expect(service.compareAndSet({
			userId: 'u1',
			kind: 'marker',
			key: 'home',
			expectedVersion: 1,
			value: { lastReadId: '3' },
		})).rejects.toMatchObject({
			statusCode: 409,
			code: 'conflict',
		} satisfies Partial<MastodonApiError> & { code: string });
		expect(repository.query.mock.calls[0][0]).toContain('AND "version" = $4');
		expect(repository.query.mock.calls[0][1]).toEqual(expect.arrayContaining(['u1', 'marker', 'home', 1]));
	});

	test('lists a kind and gets a key within one user', async () => {
		const row = state(1);
		const { service, repository } = createService();
		repository.find.mockResolvedValue([row]);
		repository.findOneBy.mockResolvedValue(row);

		await expect(service.list('u1', 'marker')).resolves.toEqual([row]);
		await expect(service.get('u1', 'marker', 'home')).resolves.toEqual(row);
		expect(repository.find).toHaveBeenCalledWith({
			where: { userId: 'u1', kind: 'marker' },
			order: { updatedAt: 'DESC' },
		});
		expect(repository.findOneBy).toHaveBeenCalledWith({ userId: 'u1', kind: 'marker', key: 'home' });
	});

	test('deletes only the addressed user, kind, and key', async () => {
		const { service, repository } = createService();
		repository.delete.mockResolvedValue({ affected: 1 });

		await expect(service.delete('u1', 'marker', 'home')).resolves.toBe(true);
		expect(repository.delete).toHaveBeenCalledWith({ userId: 'u1', kind: 'marker', key: 'home' });
	});

	test('deletes rows whose expiry has passed', async () => {
		const { service, repository } = createService([[{ id: 'state-1' }, { id: 'state-2' }]]);
		const now = new Date('2026-07-17T12:00:00.000Z');

		await expect(service.deleteExpired(now)).resolves.toBe(2);
		expect(repository.query.mock.calls[0][0]).toContain('"expiresAt" IS NOT NULL AND "expiresAt" <= $1');
		expect(repository.query.mock.calls[0][1]).toEqual([now]);
	});
});
