/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApiError } from '@/server/api/error.js';
import { collectMastodonReplies, MastodonQueryService } from './MastodonQueryService.js';

describe(MastodonQueryService, () => {
	type Note = { id: string; replyId?: string | null; renoteId?: string | null; isHidden?: boolean };
	const auth = { user: { id: 'viewer' }, token: { id: 'token', scopes: ['read:statuses', 'read:search'] } } as never;
	const request = {} as never;

	function createService(notes: Note[] = []) {
		const byId = new Map(notes.map(note => [note.id, note]));
		const api = {
			invoke: vi.fn(async () => ({ id: 'resolved', username: 'alice', host: 'remote.example' })),
			invokePublic: vi.fn(async (endpoint: string, data: { noteId?: string; limit?: number; offset?: number; userId?: string }) => {
				if (endpoint === 'users/show') return { id: data.userId };
				if (endpoint === 'notes/show') return byId.get(data.noteId!);
				const ancestors: Note[] = [];
				let current = byId.get(data.noteId!);
				while (current?.replyId != null && ancestors.length < notes.length) {
					current = byId.get(current.replyId);
					if (current != null) ancestors.push(current);
				}
				return ancestors.slice(data.offset ?? 0, (data.offset ?? 0) + (data.limit ?? 10));
			}),
		};
		let parentIds: string[] = [];
		let limit = 0;
		const builder = {
			where: vi.fn((_sql: string, values: { parentIds: string[] }) => { parentIds = values.parentIds; return builder; }),
			innerJoinAndSelect: vi.fn(() => builder),
			leftJoinAndSelect: vi.fn(() => builder),
			orderBy: vi.fn(() => builder),
			limit: vi.fn((value: number) => { limit = value; return builder; }),
			getMany: vi.fn(async () => notes.filter(note => note.replyId != null && parentIds.includes(note.replyId) && !note.isHidden).slice(0, limit)),
		};
		const query = { generateVisibilityQuery: vi.fn(), generateBaseNoteFilteringQuery: vi.fn() };
		const users = { findOneBy: vi.fn(async () => ({ id: 'known' })) };
		const service = new MastodonQueryService(api as never, { createQueryBuilder: () => builder } as never, query as never, { packMany: async (page: Note[]) => page } as never, users as never, {
			url: 'https://misskey.example', host: 'misskey.example', hostname: 'misskey.example',
		} as never);
		return { service, api, builder, query, users };
	}

	test('includes grandchildren in thread order and excludes quotes, invisible replies, and their subtree', async () => {
		const { service, query, builder } = createService([
			{ id: '100' },
			{ id: '110', replyId: '100' },
			{ id: '120', replyId: '100' },
			{ id: '130', replyId: '110' },
			{ id: '140', renoteId: '100' },
			{ id: '150', replyId: '100', isHidden: true },
			{ id: '160', replyId: '150' },
		]);
		const context = await service.context('100', auth, request);
		expect(context.descendants.map(note => note.id)).toEqual(['110', '130', '120']);
		expect(query.generateVisibilityQuery).toHaveBeenCalledWith(builder, { id: 'viewer' });
		expect(query.generateBaseNoteFilteringQuery).toHaveBeenCalledWith(builder, { id: 'viewer' });
	});

	test('paginates ancestors beyond the native default and applies separate public limits', async () => {
		const notes = Array.from({ length: 121 }, (_, index) => ({ id: String(index).padStart(3, '0'), replyId: index === 0 ? null : String(index - 1).padStart(3, '0') }));
		const { service, api } = createService(notes);
		expect((await service.context('120', auth, request)).ancestors).toHaveLength(120);
		expect(api.invokePublic).toHaveBeenCalledWith('notes/conversation', { noteId: '120', limit: 100, offset: 100 }, auth, request);
		const publicContext = await service.context('120', null, request);
		expect(publicContext.ancestors.map(note => note.id)).toEqual(notes.slice(80, 120).map(note => note.id));
		expect((await service.context('000', null, request)).descendants).toHaveLength(20);
	});

	test('rejects an inaccessible root before loading any related content', async () => {
		const { service, builder } = createService([{ id: '100', isHidden: true }, { id: '110', replyId: '100' }]);
		await expect(service.context('100', auth, request)).rejects.toMatchObject({ statusCode: 404 });
		expect(builder.getMany).not.toHaveBeenCalled();
	});

	test('bounds reply traversal and terminates despite malformed cycles or unrelated records', async () => {
		const load = vi.fn(async (parents: string[]) => [
			{ id: 'root', replyId: parents[0] },
			{ id: String(parents.length + load.mock.calls.length), replyId: parents[0] },
			{ id: 'unrelated', replyId: 'somewhere-else' },
		]);
		const result = await collectMastodonReplies('root', load, { count: 2, depth: 20 });
		expect(result).toHaveLength(2);
		expect(new Set(result.map(note => note.id)).size).toBe(2);
		expect(load).toHaveBeenCalledTimes(2);
	});

	test('resolves complete remote addresses through the native federation resolver', async () => {
		const { service, api } = createService();
		await expect(service.resolveAccount('@Alice@REMOTE.example', auth, request)).resolves.toMatchObject({ id: 'resolved' });
		expect(api.invoke).toHaveBeenCalledWith('users/show', { username: 'Alice', host: 'remote.example' }, auth, request);
		await service.resolveAccount('Alice@misskey.example', auth, request);
		expect(api.invoke).toHaveBeenLastCalledWith('users/show', { username: 'Alice' }, auth, request);
	});

	test.each(['ordinary search', 'alice', 'alice@remote.example/path', 'alice@@remote.example', 'https://remote.example/@alice'])('does not resolve non-account query %s', async raw => {
		const { service, api } = createService();
		await expect(service.resolveAccount(raw, auth, request)).resolves.toBeNull();
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test('lookup finds only already-known accounts and never requests remote resolution', async () => {
		const { service, api, users } = createService();
		await service.lookupAccount('ALICE@remote.example', null, request);
		expect(users.findOneBy).toHaveBeenCalledWith({ usernameLower: 'alice', host: 'remote.example' });
		expect(api.invokePublic).toHaveBeenCalledWith('users/show', { userId: 'known' }, null, request);
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test('treats failed discovery as no match but preserves unrelated authorization failures', async () => {
		const { service, api } = createService();
		api.invoke.mockRejectedValueOnce(new ApiError({ code: 'FAILED_TO_RESOLVE_REMOTE_USER', message: 'Unavailable', id: 'missing' }));
		await expect(service.resolveAccount('alice@remote.example', auth, request)).resolves.toBeNull();
		api.invoke.mockRejectedValueOnce(new ApiError({ code: 'PERMISSION_DENIED', message: 'Denied', id: 'denied' }));
		await expect(service.resolveAccount('alice@remote.example', auth, request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
	});
});
