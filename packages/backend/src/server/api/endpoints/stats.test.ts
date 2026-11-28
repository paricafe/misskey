/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import StatsEndpoint from './stats.js';

describe('stats', () => {
	test('returns 30-day local activeUsersCount alongside instances count', async () => {
		const usersCount = vi.fn().mockResolvedValue(42);
		const endpoint = new StatsEndpoint(
			{ count: vi.fn().mockResolvedValue(15) } as never,
			{ count: vi.fn().mockResolvedValue(99) } as never,
			{ count: usersCount } as never,
			{ getChart: vi.fn().mockResolvedValue({ local: { total: [10] }, remote: { total: [20] } }) } as never,
			{ getChart: vi.fn().mockResolvedValue({ local: { total: [5] }, remote: { total: [7] } }) } as never,
		);

		const res = await endpoint.exec({}, null, null);
		expect(res).toEqual({
			notesCount: 30,
			originalNotesCount: 10,
			usersCount: 12,
			originalUsersCount: 5,
			reactionsCount: 99,
			instances: 15,
			activeUsersCount: 42,
			driveUsageLocal: 0,
			driveUsageRemote: 0,
		});
		expect(usersCount).toHaveBeenCalledTimes(1);
		expect(usersCount.mock.calls[0][0]).toMatchObject({ cache: 3600000 });
	});
});
