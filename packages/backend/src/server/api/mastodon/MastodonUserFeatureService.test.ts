/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonUserFeatureService } from './MastodonUserFeatureService.js';

describe(MastodonUserFeatureService, () => {
	function createService() {
		type Row = {
			id: string;
			userId: string;
			kind: string;
			key: string;
			value: unknown;
			updatedAt: Date;
		};
		const rows = new Map<string, Row>();
		const rowKey = (userId: string, kind: string, key: string) => `${userId}\0${kind}\0${key}`;
		const lockTails = new Map<string, Promise<void>>();
		const stateService = {
			list: vi.fn(async (userId: string, kind: string) => [...rows.values()].filter(row => row.userId === userId && row.kind === kind)),
			get: vi.fn(async (userId: string, kind: string, key: string) => rows.get(rowKey(userId, kind, key)) ?? null),
			put: vi.fn(async (input: { userId: string; kind: string; key: string; value: unknown }) => {
				const key = rowKey(input.userId, input.kind, input.key);
				const previous = rows.get(key);
				const row = {
					id: previous?.id ?? `state-${rows.size + 1}`,
					userId: input.userId,
					kind: input.kind,
					key: input.key,
					value: input.value,
					updatedAt: new Date(),
				};
				rows.set(key, row);
				return row;
			}),
			delete: vi.fn(async (userId: string, kind: string, key: string) => rows.delete(rowKey(userId, kind, key))),
			withUserKindLock: vi.fn(async (userId: string, kind: string, callback: (service: typeof stateService) => Promise<unknown>) => {
				const key = `${userId}\0${kind}`;
				const previous = lockTails.get(key) ?? Promise.resolve();
				let release!: () => void;
				const next = new Promise<void>(resolve => { release = resolve; });
				lockTails.set(key, next);
				await previous;
				try {
					return await callback(stateService);
				} finally {
					release();
				}
			}),
		};
		const profiles = new Map([['u1', { userId: 'u1', mutedInstances: [] as string[] }]]);
		const profileRepository = {
			findOne: vi.fn(async ({ where }: { where: { userId: string } }) => {
				const profile = profiles.get(where.userId);
				return profile == null ? null : { ...profile, mutedInstances: [...profile.mutedInstances] };
			}),
			update: vi.fn(async ({ userId }: { userId: string }, value: { mutedInstances: string[] }) => {
				const profile = profiles.get(userId);
				if (profile != null) profile.mutedInstances = [...value.mutedInstances];
			}),
		};
		const userProfilesRepository = {
			manager: {
				transaction: vi.fn(async (callback: (manager: { getRepository: () => typeof profileRepository }) => Promise<unknown>) => callback({
					getRepository: () => profileRepository,
				})),
			},
		};
		const usersRepository = { existsBy: vi.fn(async ({ id }: { id: string }) => id === 'target' || id === 'not-followed') };
		const followingsRepository = { existsBy: vi.fn(async ({ followerId, followeeId }: { followerId: string; followeeId: string }) => followerId === 'u1' && followeeId === 'target') };
		const noteThreadMutingsRepository = {
			query: vi.fn(async (_sql: string, _parameters: unknown[]) => []),
			delete: vi.fn(async () => ({ affected: 1 })),
		};
		const cacheService = {
			userProfileCache: {
				fetch: vi.fn(async (userId: string) => profiles.get(userId)),
				set: vi.fn(),
			},
		};
		let id = 0;
		const service = new MastodonUserFeatureService(
			stateService as never,
			usersRepository as never,
			followingsRepository as never,
			userProfilesRepository as never,
			noteThreadMutingsRepository as never,
			cacheService as never,
			{ gen: () => `id-${++id}` } as never,
		);
		return { service, rows, stateService, profiles, profileRepository, userProfilesRepository, noteThreadMutingsRepository, cacheService };
	}

	test('normalizes followed tags, keeps follow idempotent, and serializes the 20-tag cap', async () => {
		const { service, stateService } = createService();
		const first = await service.followTag('u1', ' #MissKey ');
		expect(await service.followTag('u1', '＃ＭＩＳＳＫＥＹ')).toEqual(first);
		expect(first).toMatchObject({ name: 'misskey' });
		for (let index = 1; index < 19; index++) await service.followTag('u1', `tag-${index}`);

		const results = await Promise.allSettled([service.followTag('u1', 'extra-a'), service.followTag('u1', 'extra-b')]);
		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { statusCode: 422 } }]);
		expect(await service.listFollowedTags('u1')).toHaveLength(20);
		expect(stateService.withUserKindLock).toHaveBeenCalledWith('u1', 'followed_tag', expect.any(Function));
		await expect(service.unfollowTag('u1', 'MISSKEY')).resolves.toEqual({});
		await expect(service.unfollowTag('u1', 'misskey')).resolves.toEqual({});
	});

	test('limits featured tags to 10 and hides state ids owned by another account', async () => {
		const { service, stateService } = createService();
		const first = await service.featureTag('u1', 'Ａｒｔ');
		expect(await service.featureTag('u1', '#art')).toEqual(first);
		for (let index = 1; index < 10; index++) await service.featureTag('u1', `featured-${index}`);
		await expect(service.featureTag('u1', 'extra')).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.unfeatureTagById('u2', first.id)).rejects.toMatchObject({ statusCode: 404 });
		expect(stateService.withUserKindLock).toHaveBeenCalledWith('u1', 'featured_tag', expect.any(Function));
		await expect(service.unfeatureTagById('u1', first.id)).resolves.toEqual({});
		await expect(service.unfeatureTagById('u1', first.id)).rejects.toMatchObject({ statusCode: 404 });
	});

	test('endorses only existing followed accounts and remains idempotent', async () => {
		const { service, rows } = createService();
		const first = await service.endorse('u1', 'target');
		expect(await service.endorse('u1', 'target')).toEqual(first);
		expect(await service.listEndorsementIds('u1')).toEqual(['target']);
		expect([...rows.values()].filter(row => row.kind === 'endorsement')).toHaveLength(1);
		await expect(service.endorse('u1', 'not-followed')).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.endorse('u1', 'missing')).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.unendorse('u1', 'target')).resolves.toEqual({});
		await expect(service.unendorse('u1', 'target')).resolves.toEqual({});
	});

	test('normalizes IDN domain blocks directly on a locked user profile row', async () => {
		const { service, profiles, profileRepository, userProfilesRepository, cacheService } = createService();
		await service.blockDomain('u1', ' ＢÜCHER.Example. ');
		await service.blockDomain('u1', 'xn--bcher-kva.example');
		expect(await service.listDomainBlocks('u1')).toEqual(['xn--bcher-kva.example']);
		expect(profiles.get('u1')?.mutedInstances).toEqual(['xn--bcher-kva.example']);
		expect(userProfilesRepository.manager.transaction).toHaveBeenCalledTimes(2);
		expect(profileRepository.findOne).toHaveBeenCalledWith({ where: { userId: 'u1' }, lock: { mode: 'pessimistic_write' } });
		expect(cacheService.userProfileCache.set).toHaveBeenCalledWith('u1', expect.objectContaining({ mutedInstances: ['xn--bcher-kva.example'] }));
		await service.unblockDomain('u1', 'BÜCHER.EXAMPLE');
		await service.unblockDomain('u1', 'xn--bcher-kva.example');
		expect(await service.listDomainBlocks('u1')).toEqual([]);
	});

	test('uses conflict-safe native thread-mute writes and idempotent deletes', async () => {
		const { service, noteThreadMutingsRepository } = createService();
		await service.muteThread('u1', 'thread-1');
		await service.muteThread('u1', 'thread-1');
		expect(noteThreadMutingsRepository.query).toHaveBeenCalledTimes(2);
		expect(noteThreadMutingsRepository.query.mock.calls[0]?.[0]).toContain('ON CONFLICT ("userId", "threadId") DO NOTHING');
		await service.unmuteThread('u1', 'thread-1');
		await service.unmuteThread('u1', 'thread-1');
		expect(noteThreadMutingsRepository.delete).toHaveBeenCalledWith({ userId: 'u1', threadId: 'thread-1' });
	});
});
