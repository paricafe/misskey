/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@/core/CacheService.js';
import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import type { MastodonOAuthTokensRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { IsNull } from 'typeorm';
import { MastodonApiError } from './errors.js';
import type { MastodonAuth } from './types.js';
import { digestCredential } from './utils.js';

@Injectable()
export class MastodonAuthenticateService {
	constructor(
		@Inject(DI.mastodonOAuthTokensRepository)
		private mastodonOAuthTokensRepository: MastodonOAuthTokensRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private cacheService: CacheService,
	) {}

	@bindThis
	public async isActiveUserToken(tokenId: string, userId: string): Promise<boolean> {
		return this.mastodonOAuthTokensRepository.exists({ where: { id: tokenId, userId } });
	}

	@bindThis
	public async authenticate(rawToken: string | null | undefined): Promise<MastodonAuth> {
		if (rawToken == null || rawToken === '') {
			throw this.authenticationError();
		}

		const token = await this.mastodonOAuthTokensRepository.findOneBy({
			tokenHash: digestCredential(rawToken),
		});
		if (token == null) {
			throw this.authenticationError();
		}
		const userId = token.userId;
		if (userId == null) {
			await this.mastodonOAuthTokensRepository.update(token.id, { lastUsedAt: new Date() });
			return { kind: 'application', user: null, token };
		}

		const user = await this.cacheService.localUserByIdCache.fetch(userId, () => (
			this.usersRepository.findOneByOrFail({ id: userId, host: IsNull() }) as Promise<MiLocalUser>
		)).catch(() => null);
		if (user == null || user.isDeleted || user.isSuspended) {
			throw this.authenticationError();
		}

		await this.mastodonOAuthTokensRepository.update(token.id, { lastUsedAt: new Date() });

		return { kind: 'user', user, token };
	}

	private authenticationError(): MastodonApiError {
		return new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
	}
}
