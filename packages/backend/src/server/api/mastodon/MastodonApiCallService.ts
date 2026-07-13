/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { MiAccessToken } from '@/models/AccessToken.js';
import { ApiCallService } from '@/server/api/ApiCallService.js';
import endpoints, { type IEndpoint } from '@/server/api/endpoints.js';
import { MastodonApiError } from './errors.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import type { MastodonAuth } from './types.js';

type NativeEndpoint = IEndpoint & { exec: (...args: any[]) => Promise<unknown> };
type NativeRequest = FastifyRequest<{ Body: Record<string, unknown> | undefined, Querystring: Record<string, unknown> }>;

@Injectable()
export class MastodonApiCallService {
	private readonly endpointByName = new Map(endpoints.map(endpoint => [endpoint.name, endpoint]));

	constructor(
		private moduleRef: ModuleRef,
		private apiCallService: ApiCallService,
		private mastodonScopeService: MastodonScopeService,
	) {}

	public async invoke(
		name: string,
		data: Record<string, unknown>,
		auth: MastodonAuth,
		request: NativeRequest,
		file: { name: string; path: string } | null = null,
	): Promise<unknown> {
		const definition = this.endpointByName.get(name);
		if (definition == null) {
			throw new MastodonApiError(500, 'server_error', `Unknown native endpoint: ${name}`);
		}

		const endpoint = this.moduleRef.get<{ exec: NativeEndpoint['exec'] }>(`ep:${name}`, { strict: false });
		const token = {
			id: auth.token.id,
			permission: this.mastodonScopeService.toMisskeyPermissions(auth.token.scopes),
		} as MiAccessToken;

		return await this.apiCallService.invoke(
			{ ...definition, exec: endpoint.exec },
			auth.user,
			token,
			data,
			file,
			request,
		);
	}
}
