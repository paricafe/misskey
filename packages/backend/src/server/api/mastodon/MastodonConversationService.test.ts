/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from './errors.js';
import { MastodonConversationService } from './MastodonConversationService.js';

describe(MastodonConversationService, () => {
	type DirectNote = {
		id: string;
		threadId: string | null;
		userId: string;
		visibleUserIds: string[];
		visibility: 'specified';
	};

	const note = (id: string, threadId: string | null, userId: string, visibleUserIds: string[]): DirectNote => ({
		id,
		threadId,
		userId,
		visibleUserIds,
		visibility: 'specified',
	});

	function createService(initialNotes: DirectNote[] = []) {
		let notes = [...initialNotes];
		let id = 0;
		let lockTail = Promise.resolve();
		const rowsByKey = new Map<string, any>();
		const rowsById = new Map<string, any>();
		const calls = {
			where: [] as unknown[][],
			andWhere: [] as unknown[][],
			orderBy: [] as unknown[][],
			take: [] as unknown[][],
		};
		const queryBuilder = {
			where: vi.fn((...args: unknown[]) => { calls.where.push(args); return queryBuilder; }),
			andWhere: vi.fn((...args: unknown[]) => { calls.andWhere.push(args); return queryBuilder; }),
			orderBy: vi.fn((...args: unknown[]) => { calls.orderBy.push(args); return queryBuilder; }),
			take: vi.fn((...args: unknown[]) => { calls.take.push(args); return queryBuilder; }),
			getMany: vi.fn(async () => [...notes].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 200)),
		};
		const notesRepository = {
			createQueryBuilder: vi.fn(() => queryBuilder),
			findOneBy: vi.fn(async ({ id: noteId }: { id: string }) => notes.find(value => value.id === noteId) ?? null),
			findBy: vi.fn(async ({ id: operator }: { id: { _value?: string[] } }) => {
				const ids = operator?._value ?? [];
				return notes.filter(value => ids.includes(value.id));
			}),
		};
		const users = new Map([
			['me', { id: 'me', username: 'me', isDeleted: false, isSuspended: false }],
			['alice', { id: 'alice', username: 'alice', isDeleted: false, isSuspended: false }],
			['bob', { id: 'bob', username: 'bob', isDeleted: false, isSuspended: true }],
			['deleted', { id: 'deleted', username: 'deleted', isDeleted: true, isSuspended: false }],
		]);
		const usersRepository = {
			findBy: vi.fn(async () => [...users.values()]),
		};
		const stateService: any = {
			list: vi.fn(() => { throw new Error('conversation state must not be scanned'); }),
			get: vi.fn(async (userId: string, kind: string, key: string) => rowsByKey.get(`${userId}:${kind}:${key}`) ?? null),
			getById: vi.fn(async (rowId: string) => rowsById.get(rowId) ?? null),
			createWithId: vi.fn(async (input: any) => {
				const now = new Date();
				const row = { ...input, tokenId: null, version: 1, createdAt: now, updatedAt: now, expiresAt: null };
				rowsByKey.set(`${input.userId}:${input.kind}:${input.key}`, row);
				rowsById.set(input.id, row);
				return row;
			}),
			put: vi.fn(async (input: any) => {
				const mapKey = `${input.userId}:${input.kind}:${input.key}`;
				const current = rowsByKey.get(mapKey);
				const now = new Date();
				const row = {
					...input,
					id: current?.id ?? `state-${++id}`,
					tokenId: null,
					version: (current?.version ?? 0) + 1,
					createdAt: current?.createdAt ?? now,
					updatedAt: now,
					expiresAt: null,
				};
				rowsByKey.set(mapKey, row);
				rowsById.set(row.id, row);
				return row;
			}),
			delete: vi.fn(async (userId: string, kind: string, key: string) => {
				const mapKey = `${userId}:${kind}:${key}`;
				const row = rowsByKey.get(mapKey);
				if (row == null) return false;
				rowsByKey.delete(mapKey);
				rowsById.delete(row.id);
				return true;
			}),
			withUserKindLocks: vi.fn(async (_locks: Array<{ userId: string; kind: string }>, callback: (service: any) => Promise<unknown>) => {
				const previous = lockTail;
				let release!: () => void;
				lockTail = new Promise<void>(resolve => { release = resolve; });
				await previous;
				try {
					return await callback(stateService);
				} finally {
					release();
				}
			}),
		};
		const noteEntityService = {
			packMany: vi.fn(async (values: DirectNote[]) => values.map(value => ({
				...value,
				createdAt: '2026-07-17T00:00:00.000Z',
				user: { id: value.userId, username: value.userId },
			}))),
		};
		const userEntityService = {
			packMany: vi.fn(async (values: Array<{ id: string; username: string }>) => values.map(value => ({ id: value.id, username: value.username }))),
		};
		const mastodonEntityService = {
			account: vi.fn((value: { id: string; username: string }) => ({ id: value.id, username: value.username })),
		};
		const service = new MastodonConversationService(
			stateService,
			notesRepository as never,
			usersRepository as never,
			{ gen: vi.fn(() => `conversation-${++id}`) } as never,
			noteEntityService as never,
			userEntityService as never,
			mastodonEntityService as never,
		);
		return {
			service,
			stateService,
			notesRepository,
			noteEntityService,
			userEntityService,
			mastodonEntityService,
			calls,
			rowsByKey,
			setNotes: (values: DirectNote[]) => { notes = [...values]; },
		};
	}

	test('upserts one persisted live direct note into a stable complete conversation projection', async () => {
		const direct = note('099', 'thread-live', 'alice', ['me']);
		const { service, notesRepository, calls } = createService([direct]);

		const first = await service.upsertLive({ id: 'me' } as never, direct.id);
		const second = await service.upsertLive({ id: 'me' } as never, direct.id);

		expect(first).toEqual({
			id: expect.stringMatching(/^conversation-/u),
			unread: true,
			accounts: [{ id: 'alice', username: 'alice' }],
			lastStatus: expect.objectContaining({ id: '099' }),
		});
		expect(second).toEqual(first);
		expect(notesRepository.findOneBy).toHaveBeenCalledWith({ id: '099' });
		expect(calls.take).toEqual([]);
	});

	test('refreshes a live conversation to its previous status after the latest direct note is deleted', async () => {
		const latest = note('099', 'thread-live', 'alice', ['me']);
		const previous = note('098', 'thread-live', 'alice', ['me']);
		const { service, setNotes } = createService([latest, previous]);
		const created = await service.upsertLive({ id: 'me' } as never, latest.id);
		setNotes([previous]);

		await expect(service.refreshLive({ id: 'me' } as never, created.id)).resolves.toEqual({
			id: created.id,
			unread: true,
			accounts: [{ id: 'alice', username: 'alice' }],
			lastStatus: expect.objectContaining({ id: previous.id }),
		});
	});

	test('queries only direct notes for the author or recipient with cursor bounds and a hard 200-note cap', async () => {
		const { service, calls, notesRepository } = createService();

		await service.list({ id: 'me' } as never, { limit: 20, maxId: '900', minId: '100', sinceId: '050' });

		expect(notesRepository.createQueryBuilder).toHaveBeenCalledWith('note');
		expect(calls.where).toEqual([['note.visibility = :visibility', { visibility: 'specified' }]]);
		expect(calls.andWhere).toEqual(expect.arrayContaining([
			['(note.userId = :userId OR :userIdAsList <@ note.visibleUserIds)', { userId: 'me', userIdAsList: ['me'] }],
			['note.id < :maxId', { maxId: '900' }],
			['note.id > :minId', { minId: '100' }],
		]));
		expect(calls.orderBy).toEqual([['note.id', 'ASC']]);
		expect(calls.take).toEqual([[200]]);
	});

	test('uses the greater lower cursor and keeps since_id scans descending when min_id is absent', async () => {
		const { service, calls } = createService();

		await service.list({ id: 'me' } as never, { limit: 20, minId: '100', sinceId: '200' });
		expect(calls.andWhere).toContainEqual(['note.id > :minId', { minId: '200' }]);
		expect(calls.orderBy).toEqual([['note.id', 'ASC']]);

		calls.andWhere.length = 0;
		calls.orderBy.length = 0;
		await service.list({ id: 'me' } as never, { limit: 20, sinceId: '300' });
		expect(calls.andWhere).toContainEqual(['note.id > :minId', { minId: '300' }]);
		expect(calls.orderBy).toEqual([['note.id', 'DESC']]);
	});

	test('groups a thread only when its complete participant set matches', async () => {
		const { service, stateService } = createService([
			note('104', 'thread', 'alice', ['me', 'bob']),
			note('103', 'thread', 'me', ['alice']),
			note('102', 'thread', 'alice', ['me']),
		]);

		const result = await service.list({ id: 'me' } as never, { limit: 20 });

		expect(result).toHaveLength(2);
		expect(result.map(value => value.lastStatus.id)).toEqual(['104', '103']);
		expect(result.map(value => value.accounts.map(account => account.id))).toEqual([
			['alice', 'bob'],
			['alice'],
		]);
		expect(stateService.get).toHaveBeenCalledTimes(4);
		expect(stateService.list).not.toHaveBeenCalled();
		expect(stateService.withUserKindLocks).toHaveBeenCalledWith([
			{ userId: 'me', kind: 'conversation' },
			{ userId: 'me', kind: 'conversation_deleted' },
		], expect.any(Function));
	});

	test('serializes projection creation across both state kinds and keeps one public id per group', async () => {
		const { service, stateService } = createService([note('150', 'thread', 'alice', ['me'])]);

		const [[first], [second]] = await Promise.all([
			service.list({ id: 'me' } as never, { limit: 20 }),
			service.list({ id: 'me' } as never, { limit: 20 }),
		]);

		expect(first.id).toBe(second.id);
		expect(stateService.createWithId).toHaveBeenCalledTimes(1);
	});

	test('marks incoming conversations unread, latest self-authored conversations read, and preserves suspended accounts while excluding deleted accounts', async () => {
		const { service } = createService([
			note('202', 'incoming', 'alice', ['me', 'bob', 'deleted']),
			note('201', 'outgoing', 'me', ['alice']),
		]);

		const result = await service.list({ id: 'me' } as never, { limit: 20 });

		expect(result).toEqual([
			expect.objectContaining({ unread: true, accounts: [{ id: 'alice', username: 'alice' }, { id: 'bob', username: 'bob' }] }),
			expect.objectContaining({ unread: false, accounts: [{ id: 'alice', username: 'alice' }] }),
		]);
	});

	test('read and unread mutations update one owned public conversation id without lowering the read watermark', async () => {
		const { service, rowsByKey } = createService([note('301', 'thread', 'alice', ['me'])]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });

		await expect(service.read({ id: 'me' } as never, created.id)).resolves.toMatchObject({ id: created.id, unread: false });
		await expect(service.unread({ id: 'me' } as never, created.id)).resolves.toMatchObject({ id: created.id, unread: true });
		await service.read({ id: 'me' } as never, created.id);

		const projection = [...rowsByKey.values()].find(row => row.kind === 'conversation');
		expect(projection.value).toMatchObject({ readThroughId: '301', forcedUnread: false });
	});

	test('persists an explicit unread flag on a self-authored latest status until a read or newer self status', async () => {
		const { service } = createService([note('350', 'thread', 'me', ['alice'])]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });

		await service.unread({ id: 'me' } as never, created.id);
		await expect(service.list({ id: 'me' } as never, { limit: 20 })).resolves.toEqual([
			expect.objectContaining({ id: created.id, unread: true }),
		]);
	});

	test('a newer incoming direct note becomes unread after the previous status was read', async () => {
		const { service, setNotes } = createService([note('401', 'thread', 'alice', ['me'])]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });
		await service.read({ id: 'me' } as never, created.id);
		setNotes([
			note('402', 'thread', 'alice', ['me']),
			note('401', 'thread', 'alice', ['me']),
		]);

		await expect(service.list({ id: 'me' } as never, { limit: 20 })).resolves.toEqual([
			expect.objectContaining({ id: created.id, unread: true, lastStatus: expect.objectContaining({ id: '402' }) }),
		]);
	});

	test('reads an existing conversation by its indexed last status even after it falls outside the newest 200 direct notes', async () => {
		const old = note('100', 'old-thread', 'alice', ['me']);
		const { service, setNotes, notesRepository } = createService([old]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });
		setNotes([
			...Array.from({ length: 201 }, (_, index) => note((500 - index).toString(), `new-thread-${index}`, 'alice', ['me'])),
			old,
		]);

		await expect(service.read({ id: 'me' } as never, created.id)).resolves.toMatchObject({ id: created.id, unread: false });
		expect(notesRepository.findOneBy).toHaveBeenCalledWith({ id: '100' });
	});

	test('deletes only the projection, keeps a tombstone, and revives newer activity with a new public id', async () => {
		const { service, setNotes, rowsByKey } = createService([note('501', 'thread', 'alice', ['me'])]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });

		await expect(service.delete({ id: 'me' } as never, created.id)).resolves.toEqual({});
		await expect(service.list({ id: 'me' } as never, { limit: 20 })).resolves.toEqual([]);
		expect([...rowsByKey.values()].find(row => row.kind === 'conversation_deleted')?.value).toEqual({ deletedThroughId: '501' });

		setNotes([
			note('502', 'thread', 'alice', ['me']),
			note('501', 'thread', 'alice', ['me']),
		]);
		const [revived] = await service.list({ id: 'me' } as never, { limit: 20 });
		expect(revived).toMatchObject({ unread: true, lastStatus: expect.objectContaining({ id: '502' }) });
		expect(revived.id).not.toBe(created.id);
	});

	test('serializes deletion and newer incoming activity so the tombstone cannot erase the revival', async () => {
		const { service, setNotes } = createService([note('550', 'thread', 'alice', ['me'])]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });
		setNotes([
			note('551', 'thread', 'alice', ['me']),
			note('550', 'thread', 'alice', ['me']),
		]);

		const [, [revived]] = await Promise.all([
			service.delete({ id: 'me' } as never, created.id),
			service.list({ id: 'me' } as never, { limit: 20 }),
		]);

		expect(revived.id).not.toBe(created.id);
		expect(revived.lastStatus.id).toBe('551');
	});

	test('falls back to an older status in the bounded candidates when the projected last note was deleted', async () => {
		const { service, setNotes } = createService([
			note('602', 'thread', 'alice', ['me']),
			note('601', 'thread', 'alice', ['me']),
		]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });
		setNotes([note('601', 'thread', 'alice', ['me'])]);

		await expect(service.list({ id: 'me' } as never, { limit: 20 })).resolves.toEqual([
			expect.objectContaining({ id: created.id, lastStatus: expect.objectContaining({ id: '601' }) }),
		]);
	});

	test('applies last-status cursors, descending order, and a maximum page size of 40', async () => {
		const notes = Array.from({ length: 70 }, (_, index) => note((900 - index).toString().padStart(3, '0'), `thread-${index}`, 'alice', ['me']));
		const { service } = createService(notes);

		const result = await service.list({ id: 'me' } as never, { limit: 999, maxId: '890', minId: '840', sinceId: '830' });

		expect(result).toHaveLength(40);
		expect(result.map(value => value.lastStatus.id)).toEqual([...result.map(value => value.lastStatus.id)].sort((a, b) => b.localeCompare(a)));
		expect(result.every(value => value.lastStatus.id < '890' && value.lastStatus.id > '840')).toBe(true);
	});

	test('returns 404 for an unknown or another user public id', async () => {
		const { service, stateService } = createService([note('701', 'thread', 'alice', ['me'])]);
		const [created] = await service.list({ id: 'me' } as never, { limit: 20 });
		const row = await stateService.getById(created.id);
		row.userId = 'someone-else';

		for (const id of ['missing', created.id]) {
			await expect(service.read({ id: 'me' } as never, id)).rejects.toMatchObject({
				statusCode: 404,
			} satisfies Partial<MastodonApiError>);
		}
	});
});
