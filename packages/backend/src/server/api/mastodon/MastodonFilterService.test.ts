/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { MastodonFilterService } from './MastodonFilterService.js';

describe(MastodonFilterService, () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function createService() {
		const rows = new Map<string, {
			id: string;
			userId: string;
			tokenId: null;
			kind: string;
			key: string;
			value: unknown;
			version: number;
			createdAt: Date;
			updatedAt: Date;
			expiresAt: Date | null;
		}>();
		let lockTail = Promise.resolve();
		const stateService = {
			list: vi.fn(async (userId: string, kind: string) => [...rows.values()].filter(row => row.userId === userId && row.kind === kind)),
			put: vi.fn(async (input: { userId: string; kind: string; key: string; value: unknown; expiresAt?: Date | null }) => {
				const previous = rows.get(input.key);
				const now = new Date();
				const row = {
					id: previous?.id ?? `state-${input.key}`,
					userId: input.userId,
					tokenId: null,
					kind: input.kind,
					key: input.key,
					value: input.value,
					version: (previous?.version ?? 0) + 1,
					createdAt: previous?.createdAt ?? now,
					updatedAt: now,
					expiresAt: input.expiresAt ?? null,
				};
				rows.set(input.key, row);
				return row;
			}),
			delete: vi.fn(async (_userId: string, _kind: string, key: string) => rows.delete(key)),
			withUserKindLock: vi.fn(async (_userId: string, _kind: string, callback: (service: unknown) => Promise<unknown>) => {
				const previous = lockTail;
				let release!: () => void;
				lockTail = new Promise<void>(resolve => {
					release = resolve;
				});
				await previous;
				try {
					return await callback(stateService);
				} finally {
					release();
				}
			}),
		};
		return { service: new MastodonFilterService(stateService as never, { filtersChanged: vi.fn() } as never), stateService, rows };
	}

	test('projects v2 keywords as authoritative v1 filters and keeps v1 CRUD keyed by keyword id', async () => {
		const { service, stateService } = createService();
		const filter = await service.createV2('u1', {
			title: 'spoilers',
			context: ['home'],
			filter_action: 'warn',
			keywords: [{ keyword: 'ending', whole_word: true }],
		});

		expect(await service.listV1('u1')).toMatchObject([{
			id: filter.keywords[0]!.id,
			phrase: 'ending',
			context: ['home'],
			whole_word: true,
			irreversible: false,
		}]);
		expect(await service.getV1('u1', filter.keywords[0]!.id)).toMatchObject({ phrase: 'ending' });
		expect(await service.updateV1('u1', filter.keywords[0]!.id, {
			phrase: 'finale',
			context: ['public'],
			whole_word: false,
			irreversible: true,
		})).toMatchObject({ phrase: 'finale', context: ['public'], irreversible: true });
		await expect(service.deleteV1('u1', filter.keywords[0]!.id)).resolves.toEqual({});
		expect((await service.getV2('u1', filter.id)).keywords).toEqual([]);

		const legacy = await service.createV1('u1', {
			phrase: 'legacy',
			context: ['account'],
			whole_word: true,
			irreversible: false,
		});
		expect(legacy).toMatchObject({ phrase: 'legacy', context: ['account'] });
		expect((await service.listV2('u1')).find(value => value.keywords.some(keyword => keyword.id === legacy.id))).toMatchObject({
			title: 'legacy',
			filter_action: 'warn',
		});
		expect(stateService.withUserKindLock).toHaveBeenCalledTimes(4);
	});

	test('supports v2 filter, keyword, and status CRUD while enforcing bounded inputs', async () => {
		const { service, stateService } = createService();
		const filter = await service.createV2('u1', {
			title: 'bounded',
			context: ['home', 'notifications', 'public', 'thread', 'account'],
			filter_action: 'blur',
		});
		const keyword = await service.createKeyword('u1', filter.id, { keyword: 'literal[.]', whole_word: false });
		const status = await service.createStatus('u1', filter.id, { status_id: 'status-1' });

		expect(await service.getKeyword('u1', keyword.id)).toEqual(keyword);
		expect(await service.listKeywords('u1', filter.id)).toEqual([keyword]);
		expect(await service.updateKeyword('u1', keyword.id, { keyword: 'literal.*', whole_word: true })).toMatchObject({ keyword: 'literal.*', whole_word: true });
		expect(await service.getStatus('u1', status.id)).toEqual(status);
		expect(await service.listStatuses('u1', filter.id)).toEqual([status]);
		expect(await service.updateV2('u1', filter.id, { title: 'renamed', filter_action: 'hide' })).toMatchObject({ title: 'renamed', filter_action: 'hide' });
		await expect(service.deleteKeyword('u1', keyword.id)).resolves.toEqual({});
		await expect(service.deleteStatus('u1', status.id)).resolves.toEqual({});
		await expect(service.deleteV2('u1', filter.id)).resolves.toEqual({});

		await expect(service.createV2('u1', { title: 'x'.repeat(101), context: ['home'] })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.createV2('u1', { title: 'x', context: ['direct'] as never })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.createV2('u1', { title: 'x', context: ['home'], filter_action: 'drop' as never })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.createV2('u1', {
			title: 'x',
			context: ['home'],
			keywords: Array.from({ length: 21 }, (_, index) => ({ keyword: `k${index}`, whole_word: false })),
		})).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.createV2('u1', {
			title: 'x',
			context: ['home'],
			keywords: [{ keyword: 'x'.repeat(201), whole_word: false }],
		})).rejects.toMatchObject({ statusCode: 422 });

		expect(stateService.withUserKindLock).toHaveBeenCalledTimes(13);
		for (const [userId, kind, callback] of stateService.withUserKindLock.mock.calls) {
			expect(userId).toBe('u1');
			expect(kind).toBe('filter');
			expect(callback).toEqual(expect.any(Function));
		}
	});

	test('serializes concurrent mutations so the filter-count limit cannot be bypassed', async () => {
		const { service } = createService();
		for (let index = 0; index < 99; index++) {
			await service.createV2('u1', { title: `filter-${index}`, context: ['home'] });
		}

		const results = await Promise.allSettled([
			service.createV2('u1', { title: 'concurrent-a', context: ['home'] }),
			service.createV2('u1', { title: 'concurrent-b', context: ['home'] }),
		]);

		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter(result => result.status === 'rejected')).toMatchObject([{
			reason: { statusCode: 422, description: expect.stringContaining('100') },
		}]);
		expect(await service.listV2('u1')).toHaveLength(100);
	});

	test('enforces filter, per-filter keyword/status, and total serialized state limits', async () => {
		const filterLimit = createService();
		for (let index = 0; index < 100; index++) {
			await filterLimit.service.createV2('u1', { title: `filter-${index}`, context: ['home'] });
		}
		await expect(filterLimit.service.createV2('u1', { title: 'one-too-many', context: ['home'] })).rejects.toMatchObject({
			statusCode: 422,
			description: expect.stringContaining('100'),
		});

		const perFilter = createService();
		const filter = await perFilter.service.createV2('u1', {
			title: 'full',
			context: ['home'],
			keywords: Array.from({ length: 20 }, (_, index) => ({ keyword: `keyword-${index}`, whole_word: false })),
			statuses: Array.from({ length: 100 }, (_, index) => ({ status_id: `status-${index}` })),
		});
		await expect(perFilter.service.createKeyword('u1', filter.id, { keyword: 'extra' })).rejects.toMatchObject({ statusCode: 422 });
		await expect(perFilter.service.createStatus('u1', filter.id, { status_id: 'extra' })).rejects.toMatchObject({ statusCode: 422 });

		const byteLimit = createService();
		await expect((async () => {
			for (let index = 0; index < 100; index++) {
				await byteLimit.service.createV2('u1', {
					title: `large-${index}`,
					context: ['home'],
					keywords: Array.from({ length: 20 }, (_, keywordIndex) => ({
						keyword: `${keywordIndex}`.padEnd(200, 'x'),
						whole_word: false,
					})),
				});
			}
		})()).rejects.toMatchObject({
			statusCode: 422,
			description: expect.stringContaining('262144'),
		});
	});

	test('loads one snapshot, matches Unicode case-insensitive literals and status ids, hides collections, and preserves single statuses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
		const { service, stateService } = createService();
		await service.createV2('u1', {
			title: 'hide secrets',
			context: ['home'],
			filter_action: 'hide',
			keywords: [{ keyword: '秘密', whole_word: true }],
		});
		await service.createV2('u1', {
			title: 'warn spoilers',
			context: ['home'],
			filter_action: 'warn',
			keywords: [{ keyword: 'Spoiler[.]', whole_word: false }],
			statuses: [{ status_id: 'status-match' }],
		});
		await service.createV2('u1', {
			title: 'expired',
			context: ['home'],
			filter_action: 'hide',
			expires_in: 1,
			keywords: [{ keyword: 'old', whole_word: false }],
		});
		vi.setSystemTime(new Date('2026-07-17T00:00:02.000Z'));
		stateService.list.mockClear();
		const statuses = [
			{ id: 'hidden', content: '<p>これは、秘密！</p>', reblogged: true },
			{ id: 'not-hidden', content: '<p>極秘密文書</p>' },
			{ id: 'warned', content: '<p>sPoIlEr[.] literal</p>', bookmarked: true },
			{ id: 'status-match', content: '<p>clean</p>', pinned: true },
			{ id: 'expired', content: '<p>old</p>' },
		];
		const corpora = new Map([
			['hidden', ['これは、秘密！']],
			['not-hidden', ['極秘密文書']],
			['warned', ['sPoIlEr[.] literal']],
			['status-match', ['clean']],
			['expired', ['old']],
		]);

		const collection = await service.apply('u1', 'home', statuses, { corpora });

		expect(stateService.list).toHaveBeenCalledTimes(1);
		expect(collection.map(status => status.id)).toEqual(['not-hidden', 'warned', 'status-match', 'expired']);
		expect(collection.find(status => status.id === 'warned')).toMatchObject({
			bookmarked: true,
			filtered: [{
				filter: expect.objectContaining({ title: 'warn spoilers', filter_action: 'warn' }),
				keyword_matches: ['Spoiler[.]'],
				status_matches: null,
			}],
		});
		expect(collection.find(status => status.id === 'status-match')).toMatchObject({
			pinned: true,
			filtered: [{ status_matches: ['status-match'] }],
		});
		expect(collection.find(status => status.id === 'expired')).not.toHaveProperty('filtered');

		const [single] = await service.apply('u1', 'home', [statuses[0]!], { preserveHidden: true, corpora });
		expect(single).toMatchObject({ id: 'hidden', reblogged: true, filtered: [expect.any(Object)] });
	});

	test('matches only supplied native-visible text, not generated HTML tags or entities', async () => {
		const { service } = createService();
		for (const keyword of ['span', 'foobar', 'fish & chips']) {
			await service.createV2('u1', {
				title: keyword,
				context: ['home'],
				filter_action: 'warn',
				keywords: [{ keyword, whole_word: false }],
			});
		}
		const statuses = [
			{ id: 'tag-name', content: '<p><span>clean</span></p>' },
			{ id: 'tag-split', content: '<p>foo<span>bar</span></p>' },
			{ id: 'entity', content: '<p>fish &amp; chips</p>' },
		];
		const corpora = new Map([
			['tag-name', ['clean']],
			['tag-split', ['foobar']],
			['entity', ['fish & chips']],
		]);

		const result = await service.apply('u1', 'home', statuses, { corpora });

		expect(result.find(status => status.id === 'tag-name')).not.toHaveProperty('filtered');
		expect(result.find(status => status.id === 'tag-split')).toMatchObject({ filtered: [{ keyword_matches: ['foobar'] }] });
		expect(result.find(status => status.id === 'entity')).toMatchObject({ filtered: [{ keyword_matches: ['fish & chips'] }] });
	});
});
