/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MastodonStatusMetadataService } from './MastodonStatusMetadataService.js';

type StateRow = { userId: string; kind: string; key: string; value: Record<string, unknown> };

describe(MastodonStatusMetadataService, () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	function createService() {
		const rows = new Map<string, StateRow>();
		const locks = new Map<string, Promise<void>>();
		const rowKey = (userId: string, kind: string, key: string) => `${userId}:${kind}:${key}`;
		const state = {
			get: vi.fn(async (userId: string, kind: string, key: string) => rows.get(rowKey(userId, kind, key)) ?? null),
			put: vi.fn(async (row: StateRow) => {
				rows.set(rowKey(row.userId, row.kind, row.key), structuredClone(row));
				return row;
			}),
			withUserKindLock: vi.fn(async (userId: string, kind: string, callback: (transaction: object) => Promise<unknown>) => {
				const key = `${userId}:${kind}`;
				const previous = locks.get(key) ?? Promise.resolve();
				let release!: () => void;
				const pending = new Promise<void>(resolve => { release = resolve; });
				const tail = previous.then(() => pending);
				locks.set(key, tail);
				await previous;
				try {
					return await callback(state);
				} finally {
					release();
					if (locks.get(key) === tail) locks.delete(key);
				}
			}),
		};
		const media = {
			decorate: vi.fn(async (userId: string, attachment: Record<string, unknown>) => ({ ...attachment, focusOwner: userId })),
		};
		const redisLocks = new Map<string, { owner: string; expiresAt: number }>();
		const expireIfNeeded = (key: string) => {
			const lock = redisLocks.get(key);
			if (lock != null && lock.expiresAt <= Date.now()) redisLocks.delete(key);
		};
		const redis = {
			set: vi.fn(async (key: string, owner: string, _px: string, timeout: number, _nx: string) => {
				expireIfNeeded(key);
				if (redisLocks.has(key)) return null;
				redisLocks.set(key, { owner, expiresAt: Date.now() + timeout });
				return 'OK';
			}),
			eval: vi.fn(async (script: string, _keyCount: number, key: string, owner: string, timeout?: string) => {
				expireIfNeeded(key);
				const lock = redisLocks.get(key);
				if (lock?.owner !== owner) return 0;
				if (script.includes('pexpire')) {
					lock.expiresAt = Date.now() + Number(timeout);
					return 1;
				}
				if (script.includes('del')) {
					redisLocks.delete(key);
					return 1;
				}
				throw new Error('Unexpected Redis script');
			}),
		};
		const service = new MastodonStatusMetadataService(state as never, media as never, redis as never);
		return { service, state, media, redis, redisLocks };
	}

	test('validates and normalizes explicit status language and sensitive fields without adding omitted fields', () => {
		const { service } = createService();
		expect(service.parse({})).toEqual({});
		expect(service.parse({ language: 'zh-Hant', sensitive: 'on' })).toEqual({ language: 'zh-hant', sensitive: true });
		expect(service.parse({ language: null, sensitive: '0' })).toEqual({ language: null, sensitive: false });
		expect(service.parse({ language: '' })).toEqual({ language: null });
		for (const sensitive of [true, 1, '1', 'true']) expect(service.parse({ sensitive })).toEqual({ sensitive: true });
		for (const sensitive of [false, 0, 'false', 'off']) expect(service.parse({ sensitive })).toEqual({ sensitive: false });
	});

	test.each([
		{ language: 1 }, { language: 'e' }, { language: 'en_US' }, { language: 'english' },
		{ sensitive: null }, { sensitive: 'yes' }, { sensitive: 2 }, { sensitive: [] },
	])('rejects invalid status metadata: %j', body => {
		expect(() => createService().service.parse(body)).toThrow(expect.objectContaining({ statusCode: 422 }));
	});

	test('validates nested and form posting preferences and preserves unrelated credential fields', async () => {
		const { service } = createService();
		expect(await service.preferences('author')).toEqual({ privacy: 'public', sensitive: false, language: null });
		await service.savePreferences('author', service.parsePreferences({ source: { privacy: 'private', sensitive: true, language: 'JA' } }));
		await service.savePreferences('author', service.parsePreferences({ 'source[language]': 'en', 'source[sensitive]': 'false' }));
		await service.savePreferences('author', {});

		expect(await service.preferences('author')).toEqual({ privacy: 'private', sensitive: false, language: 'en' });
		expect(await service.preferences('other')).toEqual({ privacy: 'public', sensitive: false, language: null });
		expect(await service.credentialAccount('author', { id: 'author', source: { note: 'Profile text', fields: [], follow_requests_count: 2 } })).toEqual({
			id: 'author', source: { note: 'Profile text', fields: [], follow_requests_count: 2, privacy: 'private', sensitive: false, language: 'en' },
		});
	});

	test.each([
		{ source: { privacy: 'followers' } }, { 'source[privacy]': null },
		{ source: { language: 'not a language' } }, { 'source[sensitive]': 'perhaps' },
	])('rejects invalid posting preferences: %j', body => {
		expect(() => createService().service.parsePreferences(body)).toThrow(expect.objectContaining({ statusCode: 422 }));
	});

	test('merges status edits and reads metadata only from the status author', async () => {
		const { service } = createService();
		await service.save('author', 'note-id', { language: 'ja', sensitive: true });
		await service.save('author', 'note-id', { language: 'en' });
		await service.save('author', 'note-id', {});
		const status = { id: 'note-id', language: null, sensitive: false, content: 'Hello' };

		expect(await service.decorate({ id: 'note-id', userId: 'author' } as never, status)).toEqual({ ...status, language: 'en', sensitive: true });
		expect(await service.decorate({ id: 'note-id', userId: 'other' } as never, status)).toEqual(status);
		expect(status).toEqual({ id: 'note-id', language: null, sensitive: false, content: 'Hello' });
	});

	test('keeps each revision metadata separate from the latest status and never exposes the internal revision dictionary', async () => {
		const { service, state } = createService();
		const firstDate = '2026-09-11T01:00:00.000Z';
		const secondDate = '2026-09-11T02:00:00.000Z';
		const latestDate = '2026-09-11T03:00:00.000Z';
		await service.save('author', 'note-id', { language: 'ja', sensitive: true });
		await service.save('author', 'note-id', { language: 'en', sensitive: false }, { createdAt: firstDate, language: 'ja', sensitive: true });
		await service.save('author', 'note-id', { language: 'fr' }, { createdAt: secondDate, language: 'en', sensitive: false });
		const edits = [
			{ created_at: '2026-09-11T00:00:00.000Z', language: null, sensitive: false },
			{ created_at: firstDate, language: null, sensitive: false },
			{ created_at: secondDate, language: null, sensitive: true },
			{ created_at: latestDate, language: null, sensitive: true },
		];

		expect(await service.decorateHistory('author', 'note-id', edits)).toEqual([
			edits[0],
			{ created_at: firstDate, language: 'ja', sensitive: true },
			{ created_at: secondDate, language: 'en', sensitive: false },
			{ created_at: latestDate, language: 'fr', sensitive: false },
		]);
		expect((await state.get('author', 'status_metadata', 'note-id'))?.value).toEqual({
			language: 'fr', sensitive: false,
			revisions: {
				[firstDate]: { language: 'ja', sensitive: true },
				[secondDate]: { language: 'en', sensitive: false },
			},
		});
		expect(await service.decorate({ id: 'note-id', userId: 'author' } as never, { id: 'note-id' })).toEqual({ id: 'note-id', language: 'fr', sensitive: false });
		expect(await service.decorateHistory('other', 'note-id', edits)).toEqual(edits);
		expect(edits.at(-1)).toEqual({ created_at: latestDate, language: null, sensitive: true });
	});

	test('captures a previous version even when the successful update changes no compatibility fields', async () => {
		const { service, state } = createService();
		const createdAt = '2026-09-11T01:00:00.000Z';
		await service.save('author', 'note-id', {}, { createdAt, language: null, sensitive: false });

		expect(state.put).toHaveBeenCalledTimes(1);
		expect((await state.get('author', 'status_metadata', 'note-id'))?.value).toEqual({
			revisions: { [createdAt]: { language: null, sensitive: false } },
		});
		expect(await service.decorateHistory('author', 'note-id', [
			{ created_at: createdAt, sensitive: true },
			{ created_at: '2026-09-11T02:00:00.000Z', sensitive: true },
		])).toEqual([
			{ created_at: createdAt, language: null, sensitive: false },
			{ created_at: '2026-09-11T02:00:00.000Z', sensitive: true },
		]);
	});

	test('saves the previous snapshot and current metadata together without mutating existing state on failure', async () => {
		const { service, state } = createService();
		await service.save('author', 'note-id', { language: 'ja', sensitive: true });
		state.put.mockClear();
		state.put.mockRejectedValueOnce(new Error('Storage unavailable'));
		const createdAt = '2026-09-11T01:00:00.000Z';

		await expect(service.save('author', 'note-id', { language: 'en', sensitive: false }, { createdAt, language: 'ja', sensitive: true })).rejects.toThrow('Storage unavailable');
		expect(state.put).toHaveBeenCalledExactlyOnceWith({
			userId: 'author', kind: 'status_metadata', key: 'note-id',
			value: { language: 'en', sensitive: false, revisions: { [createdAt]: { language: 'ja', sensitive: true } } },
		});
		expect((await state.get('author', 'status_metadata', 'note-id'))?.value).toEqual({ language: 'ja', sensitive: true });
	});

	test('decorates media in every history version and excludes internal metadata fields', async () => {
		const { service, state, media } = createService();
		const createdAt = '2026-09-11T01:00:00.000Z';
		await state.put({
			userId: 'author', kind: 'status_metadata', key: 'note-id',
			value: {
				language: 'en', sensitive: false, internal: 'private metadata',
				revisions: { [createdAt]: { language: 'ja', sensitive: true, internal: 'private revision' } },
			},
		});
		media.decorate.mockImplementation(async (userId, attachment) => ({
			...attachment, focusOwner: userId, description: 'Compatibility description', meta: { focus: { x: 0.5, y: -0.5 } },
		}));
		const edits = [
			{ created_at: createdAt, media_attachments: [{ id: 'old-file', description: 'Native description' }] },
			{ created_at: '2026-09-11T02:00:00.000Z', media_attachments: [{ id: 'new-file', description: 'Native description' }] },
		];
		const original = structuredClone(edits);

		const history = await service.decorateHistory('author', 'note-id', edits);

		expect(history).toEqual(edits.map((edit, index) => ({
			...edit,
			language: index === 0 ? 'ja' : 'en', sensitive: index === 0,
			media_attachments: edit.media_attachments.map(attachment => ({
				...attachment, focusOwner: 'author', description: 'Compatibility description', meta: { focus: { x: 0.5, y: -0.5 } },
			})),
		})));
		expect(media.decorate).toHaveBeenCalledTimes(2);
		expect(media.decorate).toHaveBeenCalledWith('author', { id: 'old-file', description: 'Native description' });
		expect(media.decorate).toHaveBeenCalledWith('author', { id: 'new-file', description: 'Native description' });
		expect(await service.decorate({ id: 'note-id', userId: 'author' } as never, { id: 'note-id' })).toEqual({ id: 'note-id', language: 'en', sensitive: false });
		expect(edits).toEqual(original);
	});

	test.each(['reblog', 'quote'] as const)('decorates nested %s metadata and media with the original author', async kind => {
		const { service, media } = createService();
		await service.save('author', 'outer', { language: 'en', sensitive: false });
		await service.save('original-author', 'inner', { language: 'ja', sensitive: true });
		const inner = { id: 'inner', language: null, sensitive: false, media_attachments: [{ id: 'inner-file' }] };
		const status = {
			id: 'outer', media_attachments: [{ id: 'outer-file' }],
			...(kind === 'reblog' ? { reblog: inner } : { quote: { state: 'accepted', quoted_status: inner } }),
		};
		const original = structuredClone(status);
		const decorated = await service.decorate({ id: 'outer', userId: 'author', renote: { id: 'inner', userId: 'original-author' } } as never, status);
		const expectedInner = { ...inner, language: 'ja', sensitive: true, media_attachments: [{ id: 'inner-file', focusOwner: 'original-author' }] };

		expect(decorated).toMatchObject({ language: 'en', sensitive: false, media_attachments: [{ id: 'outer-file', focusOwner: 'author' }] });
		expect(decorated).toMatchObject(kind === 'reblog' ? { reblog: expectedInner } : { quote: { state: 'accepted', quoted_status: expectedInner } });
		expect(media.decorate).toHaveBeenCalledWith('original-author', { id: 'inner-file' });
		expect(status).toEqual(original);
	});

	test('published status waits for its author metadata write while other authors can publish', async () => {
		const { service, state, redisLocks } = createService();
		let releaseWriter!: () => void;
		let writerEntered!: () => void;
		const gate = new Promise<void>(resolve => { releaseWriter = resolve; });
		const entered = new Promise<void>(resolve => { writerEntered = resolve; });
		const writer = service.withWrite('author', async () => {
			writerEntered();
			await gate;
			await service.save('author', 'note-id', { language: 'ja', sensitive: true });
		});
		await entered;
		const published = service.decoratePublished({ id: 'note-id', userId: 'author' } as never, { id: 'note-id', language: null, sensitive: false });
		const resolved = vi.fn();
		void published.then(resolved);

		expect(await service.decoratePublished({ id: 'other-note', userId: 'other' } as never, { id: 'other-note' })).toEqual({ id: 'other-note' });
		expect(resolved).not.toHaveBeenCalled();
		expect(state.get).not.toHaveBeenCalledWith('author', 'status_metadata', 'note-id');
		expect(state.withUserKindLock).not.toHaveBeenCalled();
		releaseWriter();
		await writer;
		await vi.advanceTimersByTimeAsync(100);
		expect(await published).toEqual({ id: 'note-id', language: 'ja', sensitive: true });
		expect(redisLocks.size).toBe(0);
	});

	test('releases the Redis write lock after failure so the next writer can continue without database locks', async () => {
		const { service, state, redisLocks } = createService();
		await expect(service.withWrite('author', async () => {
			throw new Error('Write failed');
		})).rejects.toThrow('Write failed');
		expect(redisLocks.size).toBe(0);
		expect(await service.withWrite('author', async () => 'saved')).toBe('saved');
		expect(redisLocks.size).toBe(0);
		expect(state.withUserKindLock).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	test('renews a long write and serializes another service instance through the shared Redis lock', async () => {
		const { service, state, media, redis, redisLocks } = createService();
		const otherInstance = new MastodonStatusMetadataService(state as never, media as never, redis as never);
		let releaseWriter!: () => void;
		let writerEntered!: () => void;
		const gate = new Promise<void>(resolve => { releaseWriter = resolve; });
		const entered = new Promise<void>(resolve => { writerEntered = resolve; });
		const writer = service.withWrite('author', async () => {
			writerEntered();
			await gate;
			await service.save('author', 'note-id', { language: 'ja' });
		});
		await entered;
		await vi.advanceTimersByTimeAsync(35_000);
		expect(redisLocks.size).toBe(1);
		const published = otherInstance.decoratePublished({ id: 'note-id', userId: 'author' } as never, { id: 'note-id', language: null });
		await vi.advanceTimersByTimeAsync(100);
		expect(state.get).not.toHaveBeenCalledWith('author', 'status_metadata', 'note-id');
		expect(state.withUserKindLock).not.toHaveBeenCalled();

		releaseWriter();
		await writer;
		await vi.advanceTimersByTimeAsync(100);
		expect(await published).toEqual({ id: 'note-id', language: 'ja' });
		expect(redisLocks.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('does not report success or release a replacement owner after losing the write lock', async () => {
		const { service, redisLocks } = createService();
		await expect(service.withWrite('author', async () => {
			const [key] = redisLocks.keys();
			redisLocks.set(key, { owner: 'replacement-owner', expiresAt: Date.now() + 30_000 });
			return 'saved';
		})).rejects.toMatchObject({ name: 'DistributedLockLostError' });
		expect([...redisLocks.values()].map(lock => lock.owner)).toEqual(['replacement-owner']);
		expect(vi.getTimerCount()).toBe(0);
	});
});
