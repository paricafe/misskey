/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { IsNull, MoreThan, QueryFailedError } from 'typeorm';
import { AggregateRetentionProcessorService } from './AggregateRetentionProcessorService.js';

const now = new Date('2026-09-12T00:00:00Z');
const dayAgo = new Date(now.getTime() - 1000 * 60 * 60 * 24);

function setup(activeIds = ['active-a', 'active-b']) {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(now);
	const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
	const pastRecords = [
		{ id: 'past-a', userIds: ['active-a', 'inactive', 'active-a', 'active-b'], data: { earlier: 2 } },
		{ id: 'past-b', userIds: ['inactive'], data: {} },
		{ id: 'past-empty', userIds: [], data: {} },
	];
	const users = {
		find: vi.fn().mockResolvedValueOnce([{ id: 'new-a' }, { id: 'new-b' }]).mockResolvedValueOnce(activeIds.map(id => ({ id }))),
	};
	const retention = {
		findBy: vi.fn().mockResolvedValue(pastRecords),
		insert: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
	};
	const logger = { info: vi.fn(), succ: vi.fn() };
	const idService = { gen: vi.fn((date?: number) => date == null ? 'cohort-id' : 'cutoff-id') };
	const service = new AggregateRetentionProcessorService(
		users as never,
		retention as never,
		idService as never,
		{ logger: { createSubLogger: () => logger } } as never,
	);
	return { service, users, retention, logger, idService, pastRecords, dateKey };
}

afterEach(() => vi.useRealTimers());

describe(AggregateRetentionProcessorService, () => {
	test('selects only IDs and keeps cohort counts and previous daily data unchanged', async () => {
		const { service, users, retention, idService, pastRecords, dateKey } = setup();

		await service.process();

		expect(users.find).toHaveBeenNthCalledWith(1, {
			select: { id: true },
			where: { host: IsNull(), id: MoreThan('cutoff-id') },
		});
		expect(users.find).toHaveBeenNthCalledWith(2, {
			select: { id: true },
			where: { host: IsNull(), lastActiveDate: MoreThan(dayAgo) },
		});
		expect(idService.gen).toHaveBeenCalledWith(dayAgo.getTime());
		expect(retention.insert).toHaveBeenCalledExactlyOnceWith({
			id: 'cohort-id', createdAt: now, updatedAt: now, dateKey, userIds: ['new-a', 'new-b'], usersCount: 2,
		});
		expect(retention.update.mock.calls).toEqual([
			['past-a', { updatedAt: now, data: { earlier: 2, [dateKey]: 3 } }],
			['past-b', { updatedAt: now, data: { [dateKey]: 0 } }],
			['past-empty', { updatedAt: now, data: { [dateKey]: 0 } }],
		]);
		expect(pastRecords[0].data).toEqual({ earlier: 2 });
	});

	test('counts zero retention when no local users were active', async () => {
		const { service, retention, dateKey } = setup([]);

		await service.process();

		for (const [, update] of retention.update.mock.calls) {
			expect(update.data[dateKey]).toBe(0);
		}
	});

	test('preserves the existing duplicate-cohort skip behavior', async () => {
		const { service, users, retention } = setup();
		retention.insert.mockRejectedValue(new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate'), { code: '23505' })));

		await service.process();

		expect(users.find).toHaveBeenCalledTimes(1);
		expect(retention.update).not.toHaveBeenCalled();
	});
});
