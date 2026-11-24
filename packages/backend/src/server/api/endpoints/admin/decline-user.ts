/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import type { UsedUsernamesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { DI } from '@/di-symbols.js';
import { EmailService } from '@/core/EmailService.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:decline-user',

	errors: {
		noSuchUser: {
			message: 'No such user.',
			code: 'NO_SUCH_USER',
			id: 'fa87acf5-be30-4ef8-a0e4-57e90f7a9172',
		},
		alreadyApproved: {
			message: 'The user is already approved.',
			code: 'ALREADY_APPROVED',
			id: '631d94cf-c229-4c66-9bd3-241389083fab',
		},
		notLocal: {
			message: 'The user is not local.',
			code: 'NOT_LOCAL_USER',
			id: '82f7233d-cf7d-4c24-95d1-35728cfbfbf5',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userId: { type: 'string', format: 'misskey:id' },
	},
	required: ['userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.usedUsernamesRepository)
		private usedUsernamesRepository: UsedUsernamesRepository,

		private moderationLogService: ModerationLogService,
		private emailService: EmailService,
		private deleteAccountService: DeleteAccountService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const user = await this.usersRepository.findOneBy({ id: ps.userId });

			if (user == null || user.isDeleted) {
				throw new ApiError(meta.errors.noSuchUser);
			}

			if (user.approved) {
				throw new ApiError(meta.errors.alreadyApproved);
			}

			if (user.host) {
				throw new ApiError(meta.errors.notLocal);
			}

			const claimed = await this.usersRepository.update({
				id: user.id,
				host: IsNull(),
				isDeleted: false,
				isSuspended: false,
				approved: false,
			}, {
				isSuspended: true,
			});

			if (claimed?.affected === 0) {
				const latest = await this.usersRepository.findOneBy({ id: user.id });
				if (latest?.approved) {
					throw new ApiError(meta.errors.alreadyApproved);
				}
				throw new ApiError(meta.errors.noSuchUser);
			}

			let profile: Awaited<ReturnType<UserProfilesRepository['findOneBy']>>;
			try {
				profile = await this.userProfilesRepository.findOneBy({ userId: ps.userId });

				await this.usedUsernamesRepository.delete({ username: user.username.toLowerCase() });

				await this.deleteAccountService.deleteAccount(user);
			} catch (err) {
				const deleteJobEnqueued = err != null && typeof err === 'object' && 'deleteJobEnqueued' in err && err.deleteJobEnqueued === true;
				if (!deleteJobEnqueued) {
					await this.usersRepository.update({ id: user.id, isDeleted: false, approved: false }, { isSuspended: false }).catch(() => {});
				}
				throw err;
			}

			if (profile?.email) {
				void Promise.resolve(this.emailService.sendEmail(profile.email, 'Account Declined',
					'Your Account has been declined!',
					'Your Account has been declined!')).catch(() => {});
			}

			void Promise.resolve(this.moderationLogService.log(me, 'decline', {
				userId: user.id,
				userUsername: user.username,
				userHost: user.host,
			})).catch(() => {});
		});
	}
}
