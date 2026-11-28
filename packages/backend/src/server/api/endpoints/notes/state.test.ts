/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../error.js';
import StateEndpoint from './state.js';

describe('notes/state', () => {
	test('throws 404 NO_SUCH_NOTE when the target note does not exist', async () => {
		const endpoint = new StateEndpoint(
			{ findOneBy: vi.fn().mockResolvedValue(null) } as never,
			{ count: vi.fn() } as never,
			{ count: vi.fn() } as never,
		);
		await expect(endpoint.exec({ noteId: '9x00000001' }, { id: '9x00000002' } as never, null)).rejects.toMatchObject({
			code: 'NO_SUCH_NOTE',
			httpStatusCode: 404,
		} satisfies Partial<ApiError>);
	});

	test('returns myRenoteId from a pure renote query and null when none exists', async () => {
		const makeQuery = (result: { id: string } | null) => {
			const query = new DataSource({ type: 'postgres' }).createQueryBuilder().select('renote.id').from('note', 'renote');
			vi.spyOn(query, 'getOne').mockResolvedValue(result);
			return query;
		};

		const foundQuery = makeQuery({ id: '9x00000009' });
		const endpointFound = new StateEndpoint(
			{
				findOneBy: vi.fn().mockResolvedValue({ id: '9x00000001', threadId: null }),
				createQueryBuilder: () => foundQuery,
			} as never,
			{ count: vi.fn().mockResolvedValue(0) } as never,
			{ count: vi.fn().mockResolvedValue(1) } as never,
		);
		const found = await endpointFound.exec({ noteId: '9x00000001' }, { id: '9x00000002' } as never, null);
		expect(found).toEqual({ isFavorited: true, isMutedThread: false, myRenoteId: '9x00000009' });
		const [sql] = foundQuery.getQueryAndParameters();
		expect(sql).toContain('renote.replyId IS NULL');
		expect(sql).toContain('renote.text IS NULL');
		expect(sql).toContain('renote.cw IS NULL');
		expect(sql).toContain('renote.hasPoll = FALSE');
		expect(sql).toContain("renote.fileIds = '{}'");

		const missingQuery = makeQuery(null);
		const endpointMissing = new StateEndpoint(
			{
				findOneBy: vi.fn().mockResolvedValue({ id: '9x00000001', threadId: null }),
				createQueryBuilder: () => missingQuery,
			} as never,
			{ count: vi.fn().mockResolvedValue(0) } as never,
			{ count: vi.fn().mockResolvedValue(0) } as never,
		);
		const missing = await endpointMissing.exec({ noteId: '9x00000001' }, { id: '9x00000002' } as never, null);
		expect(missing).toEqual({ isFavorited: false, isMutedThread: false, myRenoteId: null });
	});
});
