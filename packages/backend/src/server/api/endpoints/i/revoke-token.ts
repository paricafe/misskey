/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AccessTokensRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { CredentialRevocationService } from '@/core/CredentialRevocationService.js';
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

		private revocations: CredentialRevocationService,
	) {
		super(meta, paramDef, async (ps, me, token) => {
			if (me == null) {
				throw new ApiError(meta.errors.credentialRequired);
			}

			if (!('tokenId' in ps) && !ps.token) return;
			const where = 'tokenId' in ps ? { id: ps.tokenId, userId: me.id } : { token: ps.token!, userId: me.id };
			await this.accessTokensRepository.manager.transaction(async manager => {
				if (token != null) {
					const target = await manager.withRepository(this.accessTokensRepository).findOne({ where, select: { id: true }, lock: { mode: 'pessimistic_write' } });
					if (!target) return;
					if (token.id !== target.id) throw new ApiError(meta.errors.permissionDenied);
					await this.revocations.deleteAccessTokens(manager, { id: target.id, userId: me.id });
				} else {
					await this.revocations.deleteAccessTokens(manager, where);
				}
			});
			void this.revocations.dispatch();
		});
	}
}
