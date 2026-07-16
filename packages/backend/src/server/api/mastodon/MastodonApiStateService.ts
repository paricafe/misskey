/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import type { MiMastodonOAuthToken } from '@/models/MastodonOAuthToken.js';
import type { MiUser } from '@/models/User.js';
import {
	MiMastodonUserState,
	miRepository,
	type MastodonUserStatesRepository,
	type MiRepository,
} from '@/models/_.js';
import { MastodonApiError } from './errors.js';

export type MastodonApiStateWrite = {
	userId: MiUser['id'];
	tokenId?: MiMastodonOAuthToken['id'] | null;
	kind: string;
	key: string;
	value: unknown;
	expiresAt?: Date | null;
};

export type MastodonApiStateConditionalWrite = MastodonApiStateWrite & {
	expectedVersion: number;
};

@Injectable()
export class MastodonApiStateService {
	constructor(
		@Inject(DI.mastodonUserStatesRepository)
		private mastodonUserStatesRepository: MastodonUserStatesRepository,
		private idService: IdService,
	) {}

	public async list(userId: MiUser['id'], kind: string): Promise<MiMastodonUserState[]> {
		return await this.mastodonUserStatesRepository.find({
			where: { userId, kind },
			order: { updatedAt: 'DESC' },
		});
	}

	public async get(userId: MiUser['id'], kind: string, key: string): Promise<MiMastodonUserState | null> {
		return await this.mastodonUserStatesRepository.findOneBy({ userId, kind, key });
	}

	public async put(input: MastodonApiStateWrite): Promise<MiMastodonUserState> {
		const now = new Date();
		const rows: MiMastodonUserState[] = await this.mastodonUserStatesRepository.query(`
			INSERT INTO "mastodon_user_state" ("id", "userId", "tokenId", "kind", "key", "value", "version", "createdAt", "updatedAt", "expiresAt")
			VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, $7, $7, $8)
			ON CONFLICT ("userId", "kind", "key") DO UPDATE SET
				"tokenId" = EXCLUDED."tokenId",
				"value" = EXCLUDED."value",
				"version" = "mastodon_user_state"."version" + 1,
				"updatedAt" = EXCLUDED."updatedAt",
				"expiresAt" = EXCLUDED."expiresAt"
			RETURNING *
		`, [
			this.idService.gen(),
			input.userId,
			input.tokenId ?? null,
			input.kind,
			input.key,
			JSON.stringify(input.value),
			now,
			input.expiresAt ?? null,
		]);
		return rows[0];
	}

	public async createIfAbsent(input: MastodonApiStateWrite): Promise<MiMastodonUserState> {
		const now = new Date();
		const rows: MiMastodonUserState[] = await this.mastodonUserStatesRepository.query(`
			INSERT INTO "mastodon_user_state" ("id", "userId", "tokenId", "kind", "key", "value", "version", "createdAt", "updatedAt", "expiresAt")
			VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, $7, $7, $8)
			ON CONFLICT ("userId", "kind", "key") DO NOTHING
			RETURNING *
		`, [
			this.idService.gen(),
			input.userId,
			input.tokenId ?? null,
			input.kind,
			input.key,
			JSON.stringify(input.value),
			now,
			input.expiresAt ?? null,
		]);
		const row = rows[0];
		if (row == null) this.conflict();
		return row;
	}

	public async withUserKindLock<T>(
		userId: MiUser['id'],
		kind: string,
		callback: (stateService: MastodonApiStateService) => Promise<T>,
	): Promise<T> {
		return await this.mastodonUserStatesRepository.manager.transaction(async manager => {
			const repository = manager.getRepository(MiMastodonUserState)
				.extend(miRepository as MiRepository<MiMastodonUserState>);
			await repository.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}\0${kind}`]);
			return await callback(new MastodonApiStateService(repository, this.idService));
		});
	}

	public async compareAndSet(input: MastodonApiStateConditionalWrite): Promise<MiMastodonUserState> {
		const rows: MiMastodonUserState[] = await this.mastodonUserStatesRepository.query(`
			UPDATE "mastodon_user_state" SET
				"tokenId" = $5,
				"value" = $6::jsonb,
				"version" = "version" + 1,
				"updatedAt" = $7,
				"expiresAt" = $8
			WHERE "userId" = $1 AND "kind" = $2 AND "key" = $3
				AND "version" = $4
			RETURNING *
		`, [
			input.userId,
			input.kind,
			input.key,
			input.expectedVersion,
			input.tokenId ?? null,
			JSON.stringify(input.value),
			new Date(),
			input.expiresAt ?? null,
		]);
		const row = rows[0];
		if (row == null) this.conflict();
		return row;
	}

	public async delete(userId: MiUser['id'], kind: string, key: string): Promise<boolean> {
		const result = await this.mastodonUserStatesRepository.delete({ userId, kind, key });
		return (result.affected ?? 0) > 0;
	}

	public async deleteExpired(now = new Date()): Promise<number> {
		const rows: { id: MiMastodonUserState['id'] }[] = await this.mastodonUserStatesRepository.query(`
			DELETE FROM "mastodon_user_state"
			WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= $1
			RETURNING "id"
		`, [now]);
		return rows.length;
	}

	private conflict(): never {
		throw Object.assign(
			new MastodonApiError(409, 'conflict', 'The compatibility state has changed'),
			{ code: 'conflict' as const },
		);
	}
}
