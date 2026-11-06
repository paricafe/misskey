/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { FanoutTimelineService } from './FanoutTimelineService.js';
import { FanoutTimelineEndpointService } from './FanoutTimelineEndpointService.js';
import { MiNote } from '@/models/Note.js';
import { MiUser } from '@/models/User.js';

function setup(lists: string[][]) {
	const pipeline = { lrange: vi.fn(), exec: vi.fn(async () => lists.map(ids => [null, ids])) };
	const fanout = new FanoutTimelineService({ pipeline: () => pipeline } as never, {} as never);
	let ids: string[] = [];
	const notes = new Map(lists.flat().map(id => [id, new MiNote({
		id, userId: 'author', userHost: null, renoteUserId: null, replyUserId: null,
		user: new MiUser({ isSuspended: false }), fileIds: [],
	})]));
	const query = {
		where: vi.fn((_condition: string, parameters: { noteIds: string[] }) => { ids = parameters.noteIds; return query; }),
		innerJoinAndSelect: vi.fn(() => query),
		leftJoinAndSelect: vi.fn(() => query),
		getMany: vi.fn(async () => ids.map(id => notes.get(id)!).reverse()),
	};
	const endpoint = new FanoutTimelineEndpointService(
		{ createQueryBuilder: () => query } as never,
		{ blockedHosts: [], ugcVisibilityForVisitor: 'all' } as never,
		{} as never, {} as never, fanout,
		{ isBlockedHost: () => false } as never, {} as never,
	);
	return { fanout, endpoint, query };
}

describe('fanout timeline ordering', () => {
	test('merges out-of-order lists and deduplicates before selecting a page', async () => {
		const { endpoint } = setup([['03', '01', '02', '02'], ['04', '02']]);
		const fallback = vi.fn(async () => []);
		const result = await endpoint.getMiNotes({
			untilId: null, sinceId: null, limit: 2, allowPartial: false,
			useDbFallback: true, redisTimelines: ['localTimeline', 'localTimelineWithReplies'],
			excludePureRenotes: false, dbFallback: fallback,
		});
		expect(result.map(note => note.id)).toEqual(['04', '03']);
		expect(fallback).not.toHaveBeenCalled();
	});

	test('preserves exclusive cursor filtering and sort direction', async () => {
		const { fanout } = setup([['03', '01', '04', '02']]);
		expect(await fanout.getMulti(['localTimeline'], '04', '01')).toEqual([['03', '02']]);
		expect(await fanout.getMulti(['localTimeline'], '03')).toEqual([['02', '01']]);
		expect(await fanout.getMulti(['localTimeline'], null, '02')).toEqual([['03', '04']]);
	});

	test('continues after filtered candidates and returns the next visible notes in order', async () => {
		const { endpoint, query } = setup([['01', '06', '03', '05', '02', '04']]);
		const result = await endpoint.getMiNotes({
			untilId: null, sinceId: null, limit: 2, allowPartial: false,
			useDbFallback: true, redisTimelines: ['localTimeline'],
			excludePureRenotes: false, noteFilter: note => note.id < '04', dbFallback: async () => [],
		});
		expect(result.map(note => note.id)).toEqual(['03', '02']);
		expect(query.getMany).toHaveBeenCalledTimes(2);
	});

	test('keeps database fallback bounds after exhausting filtered Redis candidates', async () => {
		const { endpoint } = setup([['03', '01', '02']]);
		const fallback = vi.fn(async () => []);
		await endpoint.getMiNotes({
			untilId: null, sinceId: null, limit: 2, allowPartial: false,
			useDbFallback: true, redisTimelines: ['localTimeline'],
			excludePureRenotes: false, noteFilter: () => false, dbFallback: fallback,
		});
		expect(fallback).toHaveBeenCalledExactlyOnceWith('01', null, 2);
	});
});
