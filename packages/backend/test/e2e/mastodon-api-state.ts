/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadConfig } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import {
	MiMastodonUserState,
	miRepository,
	type MastodonUserStatesRepository,
	type MiRepository,
} from '@/models/_.js';
import { MastodonApiStateService } from '@/server/api/mastodon/MastodonApiStateService.js';
import { initTestDb, signup } from '../utils.js';

describe(MastodonApiStateService, () => {
	let db: DataSource;
	let repository: MastodonUserStatesRepository;
	let service: MastodonApiStateService;
	let userId: string;

	beforeAll(async () => {
		db = await initTestDb(true);
		repository = db.getRepository(MiMastodonUserState)
			.extend(miRepository as MiRepository<MiMastodonUserState>);
		service = new MastodonApiStateService(repository, new IdService(loadConfig()));
		userId = (await signup()).id;
	}, 1000 * 60 * 2);

	afterAll(async () => {
		if (db?.isInitialized) await db.destroy();
	});

	test('serializes concurrent puts and enforces compare-and-set against the authoritative row', async () => {
		const writes = await Promise.all([
			service.put({ userId, kind: 'marker', key: 'home', value: { lastReadId: '10' } }),
			service.put({ userId, kind: 'marker', key: 'home', value: { lastReadId: '20' } }),
		]);

		expect(writes.map(row => row.version).sort((a, b) => a - b)).toEqual([1, 2]);
		const authoritative = await repository.findBy({ userId, kind: 'marker', key: 'home' });
		expect(authoritative).toHaveLength(1);
		expect(authoritative[0]).toMatchObject({
			version: 2,
			value: writes.find(row => row.version === 2)?.value,
		});

		await expect(service.compareAndSet({
			userId,
			kind: 'marker',
			key: 'home',
			expectedVersion: 1,
			value: { lastReadId: 'stale' },
		})).rejects.toMatchObject({
			statusCode: 409,
			error: 'conflict',
			code: 'conflict',
		});

		const updated = await service.compareAndSet({
			userId,
			kind: 'marker',
			key: 'home',
			expectedVersion: 2,
			value: { lastReadId: '30' },
		});
		expect(updated).toMatchObject({ version: 3, value: { lastReadId: '30' } });
		await expect(repository.findBy({ userId, kind: 'marker', key: 'home' })).resolves.toMatchObject([
			{ version: 3, value: { lastReadId: '30' } },
		]);
	});

	test('allows only one concurrent insert-only write to create version one', async () => {
		const results = await Promise.allSettled([
			service.createIfAbsent({ userId, kind: 'marker', key: 'initial-create', value: { lastReadId: '10' } }),
			service.createIfAbsent({ userId, kind: 'marker', key: 'initial-create', value: { lastReadId: '20' } }),
		]);

		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(result => result.status === 'rejected')).toMatchObject([{
			reason: { statusCode: 409, error: 'conflict', code: 'conflict' },
		}]);
		await expect(repository.findBy({ userId, kind: 'marker', key: 'initial-create' })).resolves.toMatchObject([{
			version: 1,
		}]);
	});

	test('serializes callbacks holding the same user-kind advisory lock', async () => {
		let active = 0;
		let maximumActive = 0;
		const run = async (key: string) => await service.withUserKindLock(userId, 'filter-lock', async stateService => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise(resolve => setTimeout(resolve, 25));
			await stateService.put({ userId, kind: 'filter-lock', key, value: {} });
			active--;
		});

		await Promise.all([run('first'), run('second')]);

		expect(maximumActive).toBe(1);
		await expect(repository.findBy({ userId, kind: 'filter-lock' })).resolves.toHaveLength(2);
	});

	test('deletes expired and explicitly addressed state without touching unexpired rows', async () => {
		const now = new Date();
		await service.put({
			userId,
			kind: 'expiry-contract',
			key: 'expired',
			value: {},
			expiresAt: new Date(now.getTime() - 1000),
		});
		await service.put({
			userId,
			kind: 'expiry-contract',
			key: 'future',
			value: {},
			expiresAt: new Date(now.getTime() + 60_000),
		});

		await expect(service.deleteExpired(now)).resolves.toBe(1);
		await expect(service.get(userId, 'expiry-contract', 'expired')).resolves.toBeNull();
		await expect(service.get(userId, 'expiry-contract', 'future')).resolves.not.toBeNull();
		await expect(service.delete(userId, 'expiry-contract', 'future')).resolves.toBe(true);
		await expect(service.get(userId, 'expiry-contract', 'future')).resolves.toBeNull();
	});
});
