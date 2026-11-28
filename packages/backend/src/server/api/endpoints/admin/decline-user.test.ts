/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import ApproveUserEndpoint from './approve-user.js';
import DeclineUserEndpoint from './decline-user.js';

interface FakeUser {
	id: string;
	username: string;
	host: string | null;
	approved: boolean;
	isSuspended: boolean;
	isDeleted: boolean;
}

function createFixture() {
	const user: FakeUser = {
		id: 'u1',
		username: 'alice',
		host: null,
		approved: false,
		isSuspended: false,
		isDeleted: false,
	};
	let failNextProfileRead = false;
	let failNextIsDeletedUpdate = false;

	const usersRepository = {
		findOneBy: vi.fn(async ({ id }: { id: string }) => (id === user.id ? { ...user } : null)),
		findOneByOrFail: vi.fn(async ({ id }: { id: string }) => {
			if (id !== user.id) throw new Error('not found');
			return { ...user };
		}),
		update: vi.fn(async (criteria: any, patch: Partial<FakeUser>) => {
			if (typeof criteria === 'string') {
				if (patch.isDeleted && failNextIsDeletedUpdate) {
					failNextIsDeletedUpdate = false;
					throw new Error('db write failed');
				}
				Object.assign(user, patch);
				return { affected: 1 };
			}
			if (criteria.id !== user.id) return { affected: 0 };
			if (criteria.isDeleted !== undefined && user.isDeleted !== criteria.isDeleted) return { affected: 0 };
			if (criteria.isSuspended !== undefined && user.isSuspended !== criteria.isSuspended) return { affected: 0 };
			if (criteria.approved !== undefined && user.approved !== criteria.approved) return { affected: 0 };
			Object.assign(user, patch);
			return { affected: 1 };
		}),
	};

	const queueService = {
		createDeleteAccountJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
		deliver: vi.fn().mockResolvedValue({ id: 'deliver-1' }),
	};

	const deleteAccountService = new DeleteAccountService(
		{ rootUserId: 'root' } as never,
		usersRepository as never,
		{ find: vi.fn().mockResolvedValue([]) } as never,
		{ isLocalUser: () => true, genLocalUserUri: (id: string) => `https://local.example/users/${id}` } as never,
		{ renderDelete: () => ({ type: 'Delete' }), addContext: (x: any) => x } as never,
		queueService as never,
		{ publishInternalEvent: vi.fn() } as never,
		{ log: vi.fn() } as never,
		{} as never,
	);

	const emailService = { sendEmail: vi.fn().mockResolvedValue(undefined) };
	const moderationLogService = { log: vi.fn().mockResolvedValue(undefined) };
	const userProfilesRepository = {
		findOneBy: vi.fn(async () => {
			if (failNextProfileRead) {
				failNextProfileRead = false;
				throw new Error('profile read failed');
			}
			return { userId: 'u1', email: 'alice@example.com' };
		}),
	};
	const usedUsernamesRepository = { delete: vi.fn().mockResolvedValue(undefined) };

	const declineEndpoint = new DeclineUserEndpoint(
		usersRepository as never,
		userProfilesRepository as never,
		usedUsernamesRepository as never,
		moderationLogService as never,
		emailService as never,
		deleteAccountService,
	);
	const approveEndpoint = new ApproveUserEndpoint(
		usersRepository as never,
		userProfilesRepository as never,
		moderationLogService as never,
		emailService as never,
	);
	const me = { id: 'admin', isModerator: true } as never;

	return {
		user,
		queueService,
		emailService,
		moderationLogService,
		setFailNextProfileRead: (v: boolean) => { failNextProfileRead = v; },
		setFailNextIsDeletedUpdate: (v: boolean) => { failNextIsDeletedUpdate = v; },
		decline: () => declineEndpoint.exec({ userId: 'u1' }, me, null),
		approve: () => approveEndpoint.exec({ userId: 'u1' }, me, null),
	};
}

describe('admin/decline-user & admin/approve-user mutual exclusion', () => {
	test('prevents approving a user once declined and sends email/log once', async () => {
		const f = createFixture();
		await f.decline();
		expect(f.user.isSuspended).toBe(true);
		expect(f.user.isDeleted).toBe(true);
		expect(f.queueService.createDeleteAccountJob).toHaveBeenCalledTimes(1);
		expect(f.emailService.sendEmail).toHaveBeenCalledTimes(1);
		expect(f.moderationLogService.log).toHaveBeenCalledTimes(1);

		await expect(f.approve()).rejects.toThrow('No such user.');
		await expect(f.decline()).rejects.toThrow('No such user.');
	});

	test('rolls back suspension when failure occurs before delete job enqueue', async () => {
		const f = createFixture();
		f.setFailNextProfileRead(true);
		await expect(f.decline()).rejects.toThrow('profile read failed');
		expect(f.user.isSuspended).toBe(false);
		expect(f.emailService.sendEmail).not.toHaveBeenCalled();
		expect(f.moderationLogService.log).not.toHaveBeenCalled();

		await f.decline();
		expect(f.user.isDeleted).toBe(true);
	});

	test('keeps suspension when isDeleted update fails after delete job is enqueued', async () => {
		const f = createFixture();
		f.setFailNextIsDeletedUpdate(true);
		await expect(f.decline()).rejects.toThrow('db write failed');
		expect(f.user.isSuspended).toBe(true);
		expect(f.queueService.createDeleteAccountJob).toHaveBeenCalledTimes(1);
		await expect(f.approve()).rejects.toThrow('No such user.');
	});
});
