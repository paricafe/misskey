/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import UnrenoteEndpoint from './unrenote.js';

describe('notes/unrenote', () => {
	test('deletes only pure renotes and awaits completion while preserving quote notes', async () => {
		const actor = { id: '9x00000001', host: null };
		const targetId = '9x00000002';
		const pureRenote = { id: '9x00000010', userId: actor.id, renoteId: targetId, replyId: null, text: null, cw: null, fileIds: [], hasPoll: false };
		const quoteWithText = { id: '9x00000011', userId: actor.id, renoteId: targetId, replyId: null, text: 'comment', cw: null, fileIds: [], hasPoll: false };
		const quoteWithFile = { id: '9x00000012', userId: actor.id, renoteId: targetId, replyId: null, text: null, cw: null, fileIds: ['9x00000020'], hasPoll: false };
		const quoteWithPoll = { id: '9x00000013', userId: actor.id, renoteId: targetId, replyId: null, text: null, cw: null, fileIds: [], hasPoll: true };
		const quoteWithCw = { id: '9x00000014', userId: actor.id, renoteId: targetId, replyId: null, text: null, cw: 'cw', fileIds: [], hasPoll: false };
		const replyRenote = { id: '9x00000015', userId: actor.id, renoteId: targetId, replyId: '9x00000030', text: null, cw: null, fileIds: [], hasPoll: false };

		let deletionFinished = false;
		const deleteMock = vi.fn(async () => {
			await new Promise(resolve => setTimeout(resolve, 10));
			deletionFinished = true;
		});

		const endpoint = new UnrenoteEndpoint(
			{ findOneByOrFail: vi.fn().mockResolvedValue(actor) } as never,
			{ findBy: vi.fn().mockResolvedValue([pureRenote, quoteWithText, quoteWithFile, quoteWithPoll, quoteWithCw, replyRenote]) } as never,
			{ getNote: vi.fn().mockResolvedValue({ id: targetId }) } as never,
			{ delete: deleteMock } as never,
		);

		await endpoint.exec({ noteId: targetId }, actor as never, null);

		expect(deletionFinished).toBe(true);
		expect(deleteMock).toHaveBeenCalledTimes(1);
		expect(deleteMock).toHaveBeenCalledWith(actor, pureRenote);
	});
});
