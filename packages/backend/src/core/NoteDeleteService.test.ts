/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiNote } from '@/models/Note.js';
import { NoteDeleteService } from './NoteDeleteService.js';

describe('note deletion recipients after edits', () => {
	test.each(['stored IDs', 'legacy text', 'legacy CW'])('deletes remote copies addressed through %s', async (historyKind) => {
		const alice = { id: 'alice', host: 'alice.example', uri: 'https://alice.example/users/alice' };
		const bob = { id: 'bob', host: 'bob.example', uri: 'https://bob.example/users/bob' };
		const history = historyKind === 'stored IDs' ? [{ text: 'Old text', mentions: [bob.id] }]
			: [{ text: historyKind === 'legacy text' ? '@bob@bob.example' : 'Old text', cw: historyKind === 'legacy CW' ? '@bob@bob.example' : null }];
		const current = {
			id: 'note', userId: 'author', userHost: null, text: 'Latest text', cw: null,
			mentions: [alice.id], mentionedRemoteUsers: JSON.stringify([{ uri: alice.uri }]),
			fileIds: ['attachment'],
			history, visibility: 'home', localOnly: false, replyId: null, renoteId: null,
		} as unknown as MiNote;
		const service = Object.create(NoteDeleteService.prototype) as NoteDeleteService;
		// Partial TypeORM entities can have undefined own properties for unselected columns.
		const manager = { findOne: vi.fn().mockResolvedValue({ ...current, fileIds: undefined }), delete: vi.fn().mockResolvedValue({ affected: 1 }) };
		const updateChart = vi.fn();
		const find = vi.fn(async ({ where }: { where: Array<{ id?: { value: string[] }; uri?: { value: string[] } }> }) =>
			[alice, bob].filter(user => where.some(condition => condition.id?.value.includes(user.id) || condition.uri?.value.includes(user.uri))));
		const resolveUser = vi.fn().mockResolvedValue(bob);
		const deliverToUsers = vi.fn();
		const query = { leftJoinAndSelect: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValue([]) };
		Object.assign(service, {
			db: { transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback(manager) },
			meta: {}, config: { url: 'https://local.example' },
			notesRepository: { createQueryBuilder: () => query }, usersRepository: { find },
			remoteUserResolveService: { resolveUser },
			userEntityService: { isLocalUser: () => true },
			globalEventService: { publishNoteStream: vi.fn() },
			apRendererService: { addContext: (value: unknown) => value, renderTombstone: vi.fn(), renderDelete: () => ({ type: 'Delete' }) },
			apDeliverManagerService: { deliverToFollowers: vi.fn(), deliverToUsers },
			relayService: { deliverToRelays: vi.fn() },
			notesChart: { update: updateChart }, perUserNotesChart: { update: vi.fn() }, searchService: { unindexNote: vi.fn() },
		});
		// Simulate a caller holding a note from before the last edit.
		await service.delete({ id: 'author', uri: null, host: null, isBot: false }, { ...current, mentions: [], mentionedRemoteUsers: '[]', history: null });
		await vi.waitFor(() => expect(deliverToUsers).toHaveBeenCalledWith(expect.anything(), { type: 'Delete' }, [alice, bob]));
		expect(manager.findOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lock: { mode: 'pessimistic_write' }, select: expect.objectContaining({ history: true }) }));
		expect(updateChart).toHaveBeenCalledWith(expect.objectContaining({ fileIds: ['attachment'] }), false);
		if (historyKind === 'stored IDs') expect(resolveUser).not.toHaveBeenCalled();
	});
});
