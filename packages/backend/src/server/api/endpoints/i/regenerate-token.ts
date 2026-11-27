/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import bcrypt from 'bcryptjs';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { UsersRepository, UserProfilesRepository } from '@/models/_.js';
import { MiUser } from '@/models/_.js';
import { generateNativeUserToken } from '@/misc/token.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	requireCredential: true,

	secure: true,
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		password: { type: 'string' },
	},
	required: ['password'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private globalEventService: GlobalEventService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: me.id });

			const same = await bcrypt.compare(ps.password, profile.password!);

			if (!same) {
				throw new Error('incorrect password');
			}

			const newToken = generateNativeUserToken();
			const oldToken = await this.usersRepository.manager.transaction(async em => {
				const usersRepo = em.getRepository(MiUser);
				const freshUser = await usersRepo.findOne({
					where: { id: me.id },
					lock: { mode: 'pessimistic_write' },
				});
				if (freshUser == null || freshUser.token == null) {
					throw new Error('user not found');
				}
				await usersRepo.update(me.id, {
					token: newToken,
				});
				return freshUser.token;
			});

			await this.globalEventService.publishInternalEvent('userTokenRegenerated', { id: me.id, oldToken, newToken });
			this.globalEventService.publishMainStream(me.id, 'myTokenRegenerated');
		});
	}
}
