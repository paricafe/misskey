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
		const existingUsers = new Set(['target', 'not-followed']);
		const followedUsers = new Set(['target']);
		const usersRepository = {
			existsBy: vi.fn(async ({ id }: { id: string }) => existingUsers.has(id)),
			findBy: vi.fn(async () => [...existingUsers].map(id => ({ id }))),
		};
		const followingsRepository = {
			existsBy: vi.fn(async ({ followerId, followeeId }: { followerId: string; followeeId: string }) => followerId === 'u1' && followedUsers.has(followeeId)),
			findBy: vi.fn(async () => [...followedUsers].map(followeeId => ({ followerId: 'u1', followeeId }))),
		};
		const noteThreadMutingsRepository = {
			query: vi.fn(async (_sql: string, _parameters: unknown[]): Promise<{ id: string }[]> => []),
			delete: vi.fn(async () => ({ affected: 1 })),
		};
		const cacheService = {
			userProfileCache: {
				fetch: vi.fn(async (userId: string) => profiles.get(userId)),
				set: vi.fn(),
				delete: vi.fn(),
			},
		};
		let id = 0;
		const userEntityService = { pack: vi.fn(async () => ({ id: 'u1', mutedInstances: profiles.get('u1')?.mutedInstances ?? [] })) };
		const globalEventService = { publishMainStream: vi.fn() };
		const service = new MastodonUserFeatureService(
			stateService as never,
			usersRepository as never,
			followingsRepository as never,
			userProfilesRepository as never,
			noteThreadMutingsRepository as never,
			cacheService as never,
			{ gen: () => `id-${++id}` } as never,
			userEntityService as never,
			globalEventService as never,
			{ followedTagChanged: vi.fn() } as never,
		);
		return {
			service,
			rows,
			stateService,
			profiles,
			profileRepository,
			userProfilesRepository,
			noteThreadMutingsRepository,
			cacheService,
			existingUsers,
			followedUsers,
			userEntityService,
			globalEventService,
		};
	}

	test('normalizes followed tags, keeps follow idempotent, and serializes the 20-tag cap', async () => {
		const { service, stateService } = createService();
		const first = await service.followTag('u1', ' #MissKey ');
		expect(await service.followTag('u1', '＃ＭＩＳＳＫＥＹ')).toEqual(first);
		expect(first).toMatchObject({ name: 'misskey' });
		for (let index = 1; index < 19; index++) await service.followTag('u1', `tag_${index}`);

		const results = await Promise.allSettled([service.followTag('u1', 'extra_a'), service.followTag('u1', 'extra_b')]);
		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { statusCode: 422 } }]);
		expect(await service.listFollowedTags('u1')).toHaveLength(20);
		expect(stateService.withUserKindLock).toHaveBeenCalledWith('u1', 'followed_tag', expect.any(Function));
		await expect(service.unfollowTag('u1', 'MISSKEY')).resolves.toEqual({});
		await expect(service.unfollowTag('u1', 'misskey')).resolves.toEqual({});
	});

	test('uses a diacritic-folded state key while preserving the native normalized tag name', async () => {
		const { service, rows } = createService();

		await expect(service.followTag('u1', 'BL\u00c5HAJ')).resolves.toMatchObject({ name: 'bl\u00e5haj' });
		expect([...rows.values()].find(row => row.kind === 'followed_tag')).toMatchObject({
			key: 'blahaj',
			value: { name: 'bl\u00e5haj' },
		});
		expect(await service.listFollowedTags('u1')).toEqual([expect.objectContaining({ name: 'bl\u00e5haj' })]);
	});

	test('limits featured tags to 10 and hides state ids owned by another account', async () => {
		const { service, stateService } = createService();
		const first = await service.featureTag('u1', 'Ａｒｔ');
		expect(await service.featureTag('u1', '#art')).toEqual(first);
		for (let index = 1; index < 10; index++) await service.featureTag('u1', `featured_${index}`);
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

	test('revalidates an endorsement only after taking the endorsement lock', async () => {
		const { service, stateService, followedUsers, rows } = createService();
		stateService.withUserKindLock.mockImplementationOnce(async (_userId, _kind, callback) => {
			followedUsers.delete('target');
			return await callback(stateService);
		});

		await expect(service.endorse('u1', 'target')).rejects.toMatchObject({ statusCode: 422 });
		expect([...rows.values()].filter(row => row.kind === 'endorsement')).toEqual([]);
	});

	test('omits and prunes endorsements after unfollow or account deletion', async () => {
		const { service, rows, followedUsers, existingUsers } = createService();
		await service.endorse('u1', 'target');
		followedUsers.delete('target');

		expect(await service.listEndorsementIds('u1')).toEqual([]);
		expect(await service.isEndorsed('u1', 'target')).toBe(false);
		expect([...rows.values()].filter(row => row.kind === 'endorsement')).toEqual([]);

		followedUsers.add('target');
		await service.endorse('u1', 'target');
		existingUsers.delete('target');
		expect(await service.listEndorsementIds('u1')).toEqual([]);
		expect([...rows.values()].filter(row => row.kind === 'endorsement')).toEqual([]);
	});

	test('normalizes IDN domain blocks directly on a locked user profile row', async () => {
		const { service, profiles, profileRepository, userProfilesRepository, cacheService, userEntityService, globalEventService } = createService();
		await service.blockDomain('u1', ' ＢÜCHER.Example. ');
		await service.blockDomain('u1', 'xn--bcher-kva.example');
		expect(await service.listDomainBlocks('u1')).toEqual(['xn--bcher-kva.example']);
		expect(profiles.get('u1')?.mutedInstances).toEqual(['xn--bcher-kva.example']);
		expect(userProfilesRepository.manager.transaction).toHaveBeenCalledTimes(2);
		expect(profileRepository.findOne).toHaveBeenCalledWith({ where: { userId: 'u1' }, lock: { mode: 'pessimistic_write' } });
		expect(cacheService.userProfileCache.delete).toHaveBeenCalledWith('u1');
		expect(cacheService.userProfileCache.set).not.toHaveBeenCalled();
		expect(userEntityService.pack).toHaveBeenCalledWith('u1', { id: 'u1' }, { schema: 'MeDetailed', includeSecrets: true });
		expect(globalEventService.publishMainStream).toHaveBeenCalledWith('u1', 'meUpdated', expect.objectContaining({ id: 'u1' }));
		await service.unblockDomain('u1', 'BÜCHER.EXAMPLE');
		await service.unblockDomain('u1', 'xn--bcher-kva.example');
		expect(await service.listDomainBlocks('u1')).toEqual([]);
	});

	test('accepts Unicode hashtag word characters and rejects punctuation by code point', async () => {
		const { service } = createService();
		await expect(service.followTag('u1', 'Cafe\u0301_2026')).resolves.toMatchObject({ name: 'café_2026' });
		await expect(service.followTag('u1', 'bad/tag')).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.followTag('u1', 'bad!tag')).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.followTag('u1', '😀'.repeat(101))).rejects.toMatchObject({ statusCode: 422 });
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

	test('maps a batch of note ids to muted threads with one SQL join', async () => {
		const { service, noteThreadMutingsRepository } = createService();
		noteThreadMutingsRepository.query.mockResolvedValueOnce([{ id: 'reply-1' }, { id: 'reply-2' }]);

		await expect(service.mutedNoteIds('u1', ['root', 'reply-1', 'reply-2'])).resolves.toEqual(new Set(['reply-1', 'reply-2']));
		expect(noteThreadMutingsRepository.query).toHaveBeenCalledTimes(1);
		expect(noteThreadMutingsRepository.query.mock.calls[0]?.[0]).toContain('JOIN "note_thread_muting"');
		expect(noteThreadMutingsRepository.query.mock.calls[0]?.[1]).toEqual(['u1', ['root', 'reply-1', 'reply-2']]);
	});
});
