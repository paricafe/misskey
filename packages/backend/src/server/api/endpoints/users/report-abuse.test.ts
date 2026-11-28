/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import ReportAbuseEndpoint from './report-abuse.js';

describe('users/report-abuse', () => {
	test('returns the created abuse report ID', async () => {
		const report = vi.fn().mockResolvedValue([{ id: '9x00000099' }]);
		const endpoint = new ReportAbuseEndpoint(
			{ getUser: vi.fn().mockResolvedValue({ id: '9x00000002', host: null }) } as never,
			{ isAdministrator: vi.fn().mockResolvedValue(false) } as never,
			{ report } as never,
		);

		const res = await endpoint.exec(
			{ userId: '9x00000002', comment: 'spam' },
			{ id: '9x00000001' } as never,
			null,
		);
		expect(res).toEqual({ id: '9x00000099' });
		expect(report).toHaveBeenCalledOnce();
	});
});
