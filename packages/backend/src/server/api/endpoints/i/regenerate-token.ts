/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import bcrypt from 'bcryptjs';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { UsersRepository, UserProfilesRepository } from '@/models/_.js';
import { generateNativeUserToken, nativeTokenFingerprint } from '@/misc/token.js';
import { CredentialRevocationService } from '@/core/CredentialRevocationService.js';
import { MiCredentialRevocation } from '@/models/CredentialRevocation.js';
import { MiSwSubscription } from '@/models/SwSubscription.js';
import { DI } from '@/di-symbols.js';

export const meta = {
	requireCredential: true,

	secure: true,
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		password: { type: 'string' },
		pushSubscription: {
			type: 'object',
			properties: {
				endpoint: { type: 'string' },
				auth: { type: 'string' },
				publickey: { type: 'string' },
			},
			required: ['endpoint', 'auth', 'publickey'],
		},
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

		private revocations: CredentialRevocationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const profile = await this.userProfilesRepository.findOneByOrFail({ userId: me.id });

			const same = await bcrypt.compare(ps.password, profile.password!);

			if (!same) {
				throw new Error('incorrect password');
			}

			const newToken = generateNativeUserToken();

			await this.usersRepository.manager.transaction(async manager => {
				const users = manager.withRepository(this.usersRepository);
				const user = await users.findOneOrFail({ where: { id: me.id }, select: { token: true }, lock: { mode: 'pessimistic_write' } });
				await users.update(me.id, { token: newToken });
				if (ps.pushSubscription) {
					const { endpoint, auth, publickey } = ps.pushSubscription;
					await manager.delete(MiSwSubscription, { userId: me.id, endpoint, auth, publickey });
				}
				await manager.insert(MiCredentialRevocation, { userId: me.id, event: 'userTokenRegenerated', credentialId: nativeTokenFingerprint(user.token!) });
			});

			void this.revocations.dispatch();
		});
	}
}
