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
		const scopedRepository = {
			query: vi.fn(),
		};
		const manager = {
			getRepository: vi.fn(() => ({
				extend: vi.fn(() => scopedRepository),
			})),
		};
		const repository = {
			query: vi.fn(),
			find: vi.fn(),
			findAndCount: vi.fn(),
			findOneBy: vi.fn(),
			delete: vi.fn(),
			manager: {
				transaction: vi.fn(async (callback: (transactionManager: typeof manager) => unknown) => await callback(manager)),
			},
		};
		for (const result of queryResults) repository.query.mockResolvedValueOnce(result);
		const idService = { gen: vi.fn().mockReturnValue('state-id') };
		return {
			service: new MastodonApiStateService(repository as never, idService as never),
			repository,
			scopedRepository,
			manager,
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

	test('creates a key only when absent and reports a concurrent insert as a conflict', async () => {
		const { service, repository } = createService([[state(1)], []]);

		await expect(service.createIfAbsent({
			userId: 'u1',
			kind: 'marker',
			key: 'home',
			value: { lastReadId: '1' },
		})).resolves.toEqual(state(1));
		await expect(service.createIfAbsent({
			userId: 'u1',
			kind: 'marker',
			key: 'home',
			value: { lastReadId: '2' },
		})).rejects.toMatchObject({
			statusCode: 409,
			code: 'conflict',
		} satisfies Partial<MastodonApiError> & { code: string });

		expect(repository.query.mock.calls[0][0]).toContain('ON CONFLICT ("userId", "kind", "key") DO NOTHING');
		expect(repository.query.mock.calls[0][0]).toContain('RETURNING *');
	});

	test('holds a transaction-scoped advisory lock and gives the callback a scoped state service', async () => {
		const { service, repository, scopedRepository, manager } = createService();
		const callback = vi.fn(async (scopedState: MastodonApiStateService) => {
			await scopedState.put({ userId: 'u1', kind: 'filter', key: 'filter-1', value: {} });
			return 'result';
		});
		scopedRepository.query
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([state(1, {})]);

		await expect(service.withUserKindLock('u1', 'filter', callback)).resolves.toBe('result');

		expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
		expect(manager.getRepository).toHaveBeenCalledTimes(1);
		expect(scopedRepository.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
		expect(scopedRepository.query.mock.calls[0][1]).toEqual(['u1\0filter']);
		expect(scopedRepository.query.mock.calls[1][0]).toContain('INSERT INTO "mastodon_user_state"');
		expect(callback).toHaveBeenCalledTimes(1);
	});

	test('holds multiple user-kind locks once in stable sorted order inside one transaction', async () => {
		const { service, repository, scopedRepository } = createService();
		scopedRepository.query.mockResolvedValue([]);

		await service.withUserKindLocks([
			{ userId: 'z-user', kind: 'collection_membership' },
			{ userId: 'a-user', kind: 'collection' },
			{ userId: 'z-user', kind: 'collection_membership' },
		], async () => undefined);

		expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
		expect(scopedRepository.query.mock.calls.map(call => call[1])).toEqual([
			['a-user\0collection'],
			['z-user\0collection_membership'],
		]);
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

	test('gets state by its indexed primary id', async () => {
		const row = state(1);
		const { service, repository } = createService();
		repository.findOneBy.mockResolvedValue(row);

		await expect(service.getById('collection-1')).resolves.toEqual(row);
		expect(repository.findOneBy).toHaveBeenCalledWith({ id: 'collection-1' });
	});

	test('creates one state row with the caller-provided primary id', async () => {
		const collection = { ...state(1), id: 'collection-1', kind: 'collection', key: 'collection-1' };
		const { service, repository, idService } = createService([[collection], []]);
		const input = {
			id: 'collection-1',
			userId: 'u1',
			kind: 'collection',
			key: 'collection-1',
			value: { name: 'People' },
		};

		await expect(service.createWithId(input)).resolves.toEqual(collection);
		await expect(service.createWithId(input)).rejects.toMatchObject({ statusCode: 409, code: 'conflict' });
		expect(repository.query.mock.calls[0][0]).toContain('ON CONFLICT DO NOTHING');
		expect(repository.query.mock.calls[0][0]).not.toContain('DO UPDATE');
		expect(repository.query.mock.calls[0][1][0]).toBe('collection-1');
		expect(idService.gen).not.toHaveBeenCalled();
	});

	test('reads a bounded stable page and returns the total', async () => {
		const row = state(1);
		const { service, repository } = createService();
		repository.findAndCount.mockResolvedValue([[row], 81]);

		await expect(service.listPage('u1', 'collection_membership', { offset: 40, limit: 80 }))
			.resolves.toEqual({ items: [row], total: 81 });
		expect(repository.findAndCount).toHaveBeenCalledWith({
			where: { userId: 'u1', kind: 'collection_membership' },
			order: { updatedAt: 'DESC', id: 'DESC' },
			skip: 40,
			take: 80,
		});
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
