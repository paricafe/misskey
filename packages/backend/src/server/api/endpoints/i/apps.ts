/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AccessTokensRepository, MastodonOAuthTokensRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { MastodonScopeService } from '@/server/api/mastodon/MastodonScopeService.js';
import type { Config } from '@/config.js';

export const meta = {
	requireCredential: true,

	secure: true,

	res: {
		type: 'array',
		items: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					optional: false,
					format: 'misskey:id',
				},
				name: {
					type: 'string',
					optional: true,
				},
				createdAt: {
					type: 'string',
					optional: false,
					format: 'date-time',
				},
				lastUsedAt: {
					type: 'string',
					optional: true,
					format: 'date-time',
				},
				permission: {
					type: 'array',
					optional: false,
					uniqueItems: true,
					items: {
						type: 'string',
					},
				},
				iconUrl: {
					type: 'string',
					optional: true, nullable: true,
				},
				description: {
					type: 'string',
					optional: true, nullable: true,
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		sort: { type: 'string', enum: ['+createdAt', '-createdAt', '+lastUsedAt', '-lastUsedAt'] },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		@Inject(DI.mastodonOAuthTokensRepository)
		private mastodonOAuthTokensRepository: MastodonOAuthTokensRepository,

		private idService: IdService,
		private mastodonScopeService: MastodonScopeService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = this.accessTokensRepository.createQueryBuilder('token')
				.where('token.userId = :userId', { userId: me.id })
				.leftJoinAndSelect('token.app', 'app');

			switch (ps.sort) {
				case '+createdAt': query.orderBy('token.id', 'DESC'); break;
				case '-createdAt': query.orderBy('token.id', 'ASC'); break;
				case '+lastUsedAt': query.orderBy('token.lastUsedAt', 'DESC'); break;
				case '-lastUsedAt': query.orderBy('token.lastUsedAt', 'ASC'); break;
				default: query.orderBy('token.id', 'ASC'); break;
			}

			const tokens = await query.getMany();
			const mastodonTokens = this.config.enableMastodonApi
				? await this.mastodonOAuthTokensRepository.find({
					where: { userId: me.id },
					relations: { client: true },
				})
				: [];

			const nativeItems = await Promise.all(tokens.map(token => ({
				id: token.id,
				name: token.name ?? token.app?.name,
				createdAt: this.idService.parse(token.id).date.toISOString(),
				lastUsedAt: token.lastUsedAt?.toISOString(),
				permission: token.app ? token.app.permission : token.permission,
				iconUrl: token.iconUrl,
				description: token.description ?? token.app?.description ?? null,
			})));
			const mastodonItems = mastodonTokens.map(token => ({
				id: token.id,
				name: token.client.name,
				createdAt: token.createdAt.toISOString(),
				lastUsedAt: token.lastUsedAt?.toISOString(),
				permission: this.mastodonScopeService.toMisskeyPermissions(token.scopes),
				iconUrl: null,
				description: token.client.website ?? 'Mastodon API',
			}));
			const items = [...nativeItems, ...mastodonItems];
			const compareStrings = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
			const sortItems = (field: 'createdAt' | 'lastUsedAt', direction: 'ASC' | 'DESC') => {
				items.sort((a, b) => {
					const aValue = a[field];
					const bValue = b[field];
					const idOrder = direction === 'ASC'
						? compareStrings(a.id, b.id)
						: compareStrings(b.id, a.id);

					if (aValue == null && bValue == null) return idOrder;
					if (aValue == null) return direction === 'ASC' ? 1 : -1;
					if (bValue == null) return direction === 'ASC' ? -1 : 1;

					const valueOrder = compareStrings(aValue, bValue);
					if (valueOrder !== 0) return direction === 'ASC' ? valueOrder : -valueOrder;
					return idOrder;
				});
			};

			switch (ps.sort) {
				case '+createdAt': sortItems('createdAt', 'DESC'); break;
				case '-createdAt': sortItems('createdAt', 'ASC'); break;
				case '+lastUsedAt': sortItems('lastUsedAt', 'DESC'); break;
				case '-lastUsedAt': sortItems('lastUsedAt', 'ASC'); break;
				default: items.sort((a, b) => compareStrings(a.id, b.id)); break;
			}

			return items;
		});
	}
}
