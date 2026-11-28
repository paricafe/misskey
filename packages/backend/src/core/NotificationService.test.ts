/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiNotification } from '@/models/Notification.js';
import { NotificationService } from './NotificationService.js';

function createStreamEntries(types: MiNotification['type'][]): Array<[string, string[]]> {
	return types.map((type, i) => {
		const ts = 1_700_000_000_000 + i;
		const id = `${ts}-0`;
		const payload: MiNotification = {
			id: `n-${i}`,
			createdAt: new Date(ts).toISOString(),
			type: type as 'follow',
			notifierId: `u-${i}`,
		};
		return [id, ['data', JSON.stringify(payload)]];
	});
}

describe('NotificationService getNotifications filtered scan', () => {
	function createService(entries: Array<[string, string[]]>) {
		const idToStreamId = new Map(entries.map(([streamId, [, json]]) => [(JSON.parse(json) as MiNotification).id, streamId]));

		const xrevrange = vi.fn(async (_key: string, max: string, min: string, _countKw: string, count: number) => {
			const maxExclusive = max.startsWith('(') ? max.slice(1) : null;
			const minExclusive = min.startsWith('(') ? min.slice(1) : null;
			const desc = [...entries].reverse();
			const filtered = desc.filter(([id]) => {
				if (maxExclusive != null && id >= maxExclusive) return false;
				if (minExclusive != null && id <= minExclusive) return false;
				return true;
			});
			return filtered.slice(0, count);
		});

		const xrange = vi.fn(async (_key: string, min: string, _max: string, _countKw: string, count: number) => {
			const minExclusive = min.startsWith('(') ? min.slice(1) : null;
			const filtered = entries.filter(([id]) => minExclusive == null || id > minExclusive);
			return filtered.slice(0, count);
		});

		const service = new NotificationService(
			{ perUserNotificationsMaxCount: 10000 } as never,
			{ xrevrange, xrange } as never,
			{} as never,
			{
				parseFull: (id: string) => {
					const streamId = idToStreamId.get(id)!;
					const [dateStr, seqStr] = streamId.split('-');
					return { date: Number(dateStr), additional: BigInt(seqStr) };
				},
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);

		return { service, xrevrange, xrange };
	}

	test('scans filtered notifications in chunks of at least 64 instead of 1-by-1', async () => {
		const types: MiNotification['type'][] = [
			'follow',
			...Array.from({ length: 1000 }, () => 'reaction' as const),
		];
		const { service, xrevrange } = createService(createStreamEntries(types));

		const result = await service.getNotifications('me', {
			limit: 1,
			includeTypes: ['follow'],
		});

		expect(result.map(n => n.id)).toEqual(['n-0']);
		expect(xrevrange.mock.calls.length).toBeLessThanOrEqual(17);
	});

	test('caps filtered results at limit and preserves descending and ascending cursor order', async () => {
		const types: MiNotification['type'][] = [
			'follow', 'reaction', 'follow', 'reaction', 'follow', 'follow',
		];
		const { service, xrevrange, xrange } = createService(createStreamEntries(types));

		const descResult = await service.getNotifications('me', {
			limit: 2,
			includeTypes: ['follow'],
		});
		expect(descResult.map(n => n.id)).toEqual(['n-5', 'n-4']);
		expect(xrevrange).toHaveBeenCalledTimes(1);

		const ascResult = await service.getNotifications('me', {
			sinceId: 'n-0',
			limit: 2,
			excludeTypes: ['reaction'],
		});
		expect(ascResult.map(n => n.id)).toEqual(['n-2', 'n-4']);
		expect(xrange).toHaveBeenCalledTimes(1);
	});
});
