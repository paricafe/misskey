/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import ApproveUserEndpoint, { meta as approveMeta } from './approve-user.js';
import DeclineUserEndpoint, { meta as declineMeta } from './decline-user.js';

const moderator = { id: 'moderator-id' } as MiLocalUser;

function createApproveEndpoint(user: Record<string, unknown> | null) {
	return new ApproveUserEndpoint(
		{ findOneBy: vi.fn().mockResolvedValue(user), update: vi.fn() } as never,
		{ findOneBy: vi.fn().mockResolvedValue(null) } as never,
		{ log: vi.fn() } as never,
		{ sendEmail: vi.fn() } as never,
	);
}

function createDeclineEndpoint(user: Record<string, unknown> | null) {
	return new DeclineUserEndpoint(
		{ findOneBy: vi.fn().mockResolvedValue(user) } as never,
		{ findOneBy: vi.fn().mockResolvedValue(null) } as never,
		{ delete: vi.fn() } as never,
		{ log: vi.fn() } as never,
		{ sendEmail: vi.fn() } as never,
		{ deleteAccount: vi.fn() } as never,
	);
}

describe('signup approval endpoints', () => {
	test('approve-user returns a stable API error for an unknown user', async () => {
		const endpoint = createApproveEndpoint(null);

		await expect(endpoint.exec({ userId: 'unknownuserid123' }, moderator, null)).rejects.toMatchObject({
			code: approveMeta.errors.noSuchUser.code,
			id: approveMeta.errors.noSuchUser.id,
		});
	});

	test.each([
		['missing or deleted user', null, declineMeta.errors.noSuchUser],
		['approved user', { id: 'user-id', approved: true, isDeleted: false, host: null }, declineMeta.errors.alreadyApproved],
		['remote user', { id: 'user-id', approved: false, isDeleted: false, host: 'remote.example' }, declineMeta.errors.notLocal],
	])('decline-user returns a stable API error for a %s', async (_label, user, error) => {
		const endpoint = createDeclineEndpoint(user);

		await expect(endpoint.exec({ userId: 'userid1234567890' }, moderator, null)).rejects.toMatchObject({
			code: error.code,
			id: error.id,
		});
	});
});
