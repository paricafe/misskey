/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AccessTokensRepository, MastodonOAuthTokensRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { digestCredential } from '@/server/api/mastodon/utils.js';
import type { Config } from '@/config.js';

export const meta = {
	requireCredential: true,

	secure: true,
} as const;

export const paramDef = {
	anyOf: [
		{
			type: 'object',
			properties: {
				tokenId: { type: 'string', format: 'misskey:id' },
			},
			required: ['tokenId'],
		},
		{
			type: 'object',
			properties: {
				token: { type: 'string', nullable: true },
			},
			required: ['token'],
		},
	],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		@Inject(DI.mastodonOAuthTokensRepository)
		private mastodonOAuthTokensRepository: MastodonOAuthTokensRepository,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redis: Redis.Redis,
	) {
		super(meta, paramDef, async (ps, me) => {
			if ('tokenId' in ps) {
				await this.accessTokensRepository.delete({ id: ps.tokenId, userId: me.id });
				const result = await this.mastodonOAuthTokensRepository.delete({ id: ps.tokenId, userId: me.id });
				if (result.affected) await this.publishMastodonTokenRevoked(ps.tokenId);
			} else if (ps.token) {
				await this.accessTokensRepository.delete({ token: ps.token, userId: me.id });
				const mastodonToken = await this.mastodonOAuthTokensRepository.findOneBy({
					tokenHash: digestCredential(ps.token),
					userId: me.id,
				});
				if (mastodonToken == null) return;

				const result = await this.mastodonOAuthTokensRepository.delete({ id: mastodonToken.id, userId: me.id });
				if (result.affected) await this.publishMastodonTokenRevoked(mastodonToken.id);
			}
		});
	}

	private async publishMastodonTokenRevoked(tokenId: string): Promise<void> {
		await this.redis.publish(this.config.host, JSON.stringify({
			channel: `mastodonTokenRevoked:${tokenId}`,
			message: null,
		}));
	}
}
