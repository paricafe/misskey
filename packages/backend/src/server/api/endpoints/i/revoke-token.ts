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
import { ApiError } from '../../error.js';

export const meta = {
	description: 'Revoke an access token of the authenticated user. Requires credential. When called with an access token (third-party app), only the token currently in use can be revoked.',

	errors: {
		credentialRequired: {
			message: 'Credential required.',
			code: 'CREDENTIAL_REQUIRED',
			id: '6f1f0d3a-3d5b-4b1f-9c3e-2a6d1e5b8c47',
			httpStatusCode: 401,
		},
		permissionDenied: {
			message: 'Permission denied.',
			code: 'PERMISSION_DENIED',
			id: 'fc20d118-5705-4462-b6c5-2b5b43092cf3',
			httpStatusCode: 403,
		},
	},
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
		super(meta, paramDef, async (ps, me, token) => {
			if (me == null) {
				throw new ApiError(meta.errors.credentialRequired);
			}

			const target = 'tokenId' in ps
				? await this.accessTokensRepository.findOneBy({ id: ps.tokenId, userId: me.id })
				: ps.token == null || ps.token === ''
					? null
					: await this.accessTokensRepository.findOneBy({ token: ps.token, userId: me.id });

			// サードパーティアプリ (アクセストークン) からのリクエストでは、いま使われているトークン自身のみ失効できる
			if (token != null) {
				if (target == null) return;
				if (token.id !== target.id) throw new ApiError(meta.errors.permissionDenied);
			}

			if (target != null) {
				await this.accessTokensRepository.delete({ id: target.id });
			}

			if (!this.config.enableMastodonApi) return;

			let mastodonTokenId: string | null = null;
			if ('tokenId' in ps) {
				const result = await this.mastodonOAuthTokensRepository.delete({ id: ps.tokenId, userId: me.id });
				if (result.affected) mastodonTokenId = ps.tokenId;
			} else {
				if (ps.token == null || ps.token === '') return;
				const mastodonToken = await this.mastodonOAuthTokensRepository.findOneBy({
					tokenHash: digestCredential(ps.token),
					userId: me.id,
				});
				if (mastodonToken != null) {
					const result = await this.mastodonOAuthTokensRepository.delete({ id: mastodonToken.id, userId: me.id });
					if (result.affected) mastodonTokenId = mastodonToken.id;
				}
			}

			if (mastodonTokenId != null) await this.publishMastodonTokenRevoked(mastodonTokenId);
		});
	}

	private async publishMastodonTokenRevoked(tokenId: string): Promise<void> {
		await this.redis.publish(this.config.host, JSON.stringify({
			channel: `mastodonTokenRevoked:${tokenId}`,
			message: null,
		}));
	}
}
