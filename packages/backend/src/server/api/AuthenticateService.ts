/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { AccessTokensRepository, AppsRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import { MemoryKVCache } from '@/misc/cache.js';
import type { MiApp } from '@/models/App.js';
import { CacheService } from '@/core/CacheService.js';
import { isNativeUserToken } from '@/misc/token.js';
import { bindThis } from '@/decorators.js';
import type { EntityManager } from 'typeorm';

export type StreamingCredential = {
	token: string;
	userId: string;
	accessTokenId: string | null;
	permissions: string[];
};

type AuthenticationOptions = { fresh?: boolean; updateLastUsedAt?: boolean; timeoutMs?: number };

export class AuthenticationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthenticationError';
	}
}

@Injectable()
export class AuthenticateService implements OnApplicationShutdown {
	private appCache: MemoryKVCache<MiApp>;

	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.accessTokensRepository)
		private accessTokensRepository: AccessTokensRepository,

		@Inject(DI.appsRepository)
		private appsRepository: AppsRepository,

		private cacheService: CacheService,
	) {
		this.appCache = new MemoryKVCache<MiApp>(1000 * 60 * 60 * 24 * 7);
	}

	@bindThis
	public async authenticate(token: string | null | undefined, options: AuthenticationOptions = {}): Promise<[MiLocalUser | null, MiAccessToken | null]> {
		if (token == null) {
			return [null, null];
		}

		if (options.timeoutMs != null) {
			return this.withStreamingTimeout(options.timeoutMs, manager => this.lookup(token, options, manager));
		}
		return this.lookup(token, options);
	}

	private async lookup(token: string, options: AuthenticationOptions, manager?: EntityManager): Promise<[MiLocalUser, MiAccessToken | null]> {
		const users = manager?.withRepository(this.usersRepository) ?? this.usersRepository;
		const tokens = manager?.withRepository(this.accessTokensRepository) ?? this.accessTokensRepository;
		const apps = manager?.withRepository(this.appsRepository) ?? this.appsRepository;

		if (isNativeUserToken(token)) {
			const findUser = () => users.findOneBy({ token }) as Promise<MiLocalUser | null>;
			const user = await (options.fresh ? findUser() : this.cacheService.localUserByNativeTokenCache.fetch(token, findUser));

			if (user == null) {
				throw new AuthenticationError('user not found');
			}

			return [user, null];
		} else {
			const accessToken = await tokens.findOne({
				where: [{
					hash: token.toLowerCase(),
				}, {
					token: token,
				}],
			});

			if (accessToken == null) {
				throw new AuthenticationError('invalid signature');
			}

			if (options.updateLastUsedAt !== false) {
				const update = tokens.update(accessToken.id, {
					lastUsedAt: new Date(),
				});
				if (manager) await update;
			}

			const findUser = () => users.findOneBy({ id: accessToken.userId }) as Promise<MiLocalUser>;
			const user = await (options.fresh ? findUser() : this.cacheService.localUserByIdCache.fetch(accessToken.userId, findUser));
			if (user == null) throw new AuthenticationError('user not found');

			if (accessToken.appId) {
				const findApp = () => apps.findOneByOrFail({ id: accessToken.appId! });
				const app = await (options.fresh ? findApp() : this.appCache.fetch(accessToken.appId, findApp));

				return [user, {
					id: accessToken.id,
					permission: app.permission,
				} as MiAccessToken];
			} else {
				return [user, accessToken];
			}
		}
	}

	@bindThis
	public async verifyStreamingCredentials(credentials: StreamingCredential[], timeoutMs: number): Promise<Set<number>> {
		const rows = await this.withStreamingTimeout(timeoutMs, manager => manager.query<{ position: number }[]>(`
			SELECT c.position
			FROM jsonb_to_recordset($1::jsonb)
				AS c(position integer, token varchar, hash varchar, "userId" varchar, "accessTokenId" varchar, permissions varchar[])
			JOIN "user" u ON u.id = c."userId"
			LEFT JOIN access_token t ON t.id = c."accessTokenId" AND t."userId" = u.id
			LEFT JOIN app a ON a.id = t."appId"
			WHERE NOT u."isSuspended" AND NOT u."isDeleted" AND (
				(c."accessTokenId" IS NULL AND u.token = c.token)
				OR (t.id IS NOT NULL AND (t.token = c.token OR t.hash = c.hash)
					AND c.permissions <@ (CASE WHEN t."appId" IS NULL THEN t.permission ELSE a.permission END))
			)
		`, [JSON.stringify(credentials.map((credential, position) => ({ ...credential, position, hash: credential.token.toLowerCase() })))]));
		return new Set(rows.map(row => row.position));
	}

	private withStreamingTimeout<T>(timeoutMs: number, lookup: (manager: EntityManager) => Promise<T>): Promise<T> {
		const deadline = performance.now() + timeoutMs;
		return this.usersRepository.manager.transaction(async manager => {
			const remaining = Math.floor(deadline - performance.now());
			if (remaining < 1) throw new Error('Authorization check timed out');
			await manager.query(`
				SELECT set_config('statement_timeout', LEAST(NULLIF(setting::integer, 0), $1)::text, true)
				FROM pg_settings WHERE name = 'statement_timeout'
			`, [remaining]);
			return lookup(manager);
		});
	}

	@bindThis
	public dispose(): void {
		this.appCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
