/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { CacheService } from '@/core/CacheService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DI } from '@/di-symbols.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import type { MiUser } from '@/models/User.js';
import type {
	FollowingsRepository,
	NoteThreadMutingsRepository,
	UserProfilesRepository,
	UsersRepository,
} from '@/models/_.js';
import { MastodonApiError } from './errors.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';

const FOLLOWED_TAG_KIND = 'followed_tag';
const FEATURED_TAG_KIND = 'featured_tag';
const ENDORSEMENT_KIND = 'endorsement';
const FOLLOWED_TAG_LIMIT = 20;
const FEATURED_TAG_LIMIT = 10;

export type MastodonUserTagState = {
	id: string;
	name: string;
};

type NormalizedTag = {
	key: string;
	name: string;
};

@Injectable()
export class MastodonUserFeatureService {
	constructor(
		private mastodonApiStateService: MastodonApiStateService,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private noteThreadMutingsRepository: NoteThreadMutingsRepository,

		private cacheService: CacheService,
		private idService: IdService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
	) {}

	public async listFollowedTags(userId: MiUser['id']): Promise<MastodonUserTagState[]> {
		const rows = await this.mastodonApiStateService.list(userId, FOLLOWED_TAG_KIND);
		return rows.map(row => this.tagState(row));
	}

	public async followTag(userId: MiUser['id'], rawName: string): Promise<MastodonUserTagState> {
		const tag = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FOLLOWED_TAG_KIND, async stateService => {
			const existing = await stateService.get(userId, FOLLOWED_TAG_KIND, tag.key);
			if (existing != null) return this.tagState(existing);
			const rows = await stateService.list(userId, FOLLOWED_TAG_KIND);
			if (rows.length >= FOLLOWED_TAG_LIMIT) this.invalid(`You cannot follow more than ${FOLLOWED_TAG_LIMIT} hashtags`);
			const row = await stateService.put({ userId, kind: FOLLOWED_TAG_KIND, key: tag.key, value: { name: tag.name } });
			return this.tagState(row);
		});
	}

	public async unfollowTag(userId: MiUser['id'], rawName: string): Promise<Record<string, never>> {
		const tag = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FOLLOWED_TAG_KIND, async stateService => {
			await stateService.delete(userId, FOLLOWED_TAG_KIND, tag.key);
			return {};
		});
	}

	public async listFeaturedTags(userId: MiUser['id']): Promise<MastodonUserTagState[]> {
		const rows = await this.mastodonApiStateService.list(userId, FEATURED_TAG_KIND);
		return rows.map(row => this.tagState(row));
	}

	public async featureTag(userId: MiUser['id'], rawName: string): Promise<MastodonUserTagState> {
		const tag = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FEATURED_TAG_KIND, async stateService => {
			const existing = await stateService.get(userId, FEATURED_TAG_KIND, tag.key);
			if (existing != null) return this.tagState(existing);
			const rows = await stateService.list(userId, FEATURED_TAG_KIND);
			if (rows.length >= FEATURED_TAG_LIMIT) this.invalid(`You cannot feature more than ${FEATURED_TAG_LIMIT} hashtags`);
			const row = await stateService.put({ userId, kind: FEATURED_TAG_KIND, key: tag.key, value: { name: tag.name } });
			return this.tagState(row);
		});
	}

	public async unfeatureTag(userId: MiUser['id'], rawName: string): Promise<Record<string, never>> {
		const tag = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FEATURED_TAG_KIND, async stateService => {
			await stateService.delete(userId, FEATURED_TAG_KIND, tag.key);
			return {};
		});
	}

	public async unfeatureTagById(userId: MiUser['id'], stateId: string): Promise<Record<string, never>> {
		return await this.mastodonApiStateService.withUserKindLock(userId, FEATURED_TAG_KIND, async stateService => {
			const row = (await stateService.list(userId, FEATURED_TAG_KIND)).find(value => value.id === stateId);
			if (row == null) this.notFound('Featured tag not found');
			await stateService.delete(userId, FEATURED_TAG_KIND, row.key);
			return {};
		});
	}

	public async tagFlags(userId: MiUser['id'], rawName: string): Promise<{ name: string; following: boolean; featuring: boolean }> {
		const tag = this.normalizeTag(rawName);
		const [followed, featured] = await Promise.all([
			this.mastodonApiStateService.get(userId, FOLLOWED_TAG_KIND, tag.key),
			this.mastodonApiStateService.get(userId, FEATURED_TAG_KIND, tag.key),
		]);
		return {
			name: followed != null ? this.tagState(followed).name : featured != null ? this.tagState(featured).name : tag.name,
			following: followed != null,
			featuring: featured != null,
		};
	}

	public async listEndorsementIds(userId: MiUser['id']): Promise<MiUser['id'][]> {
		return await this.mastodonApiStateService.withUserKindLock(userId, ENDORSEMENT_KIND, async stateService => {
			const rows = await stateService.list(userId, ENDORSEMENT_KIND);
			const ids = rows.map(row => row.key);
			if (ids.length === 0) return [];
			const [users, followings] = await Promise.all([
				this.usersRepository.findBy({ id: In(ids) }),
				this.followingsRepository.findBy({ followerId: userId, followeeId: In(ids) }),
			]);
			const existingIds = new Set(users.map(user => user.id));
			const followedIds = new Set(followings.map(following => following.followeeId));
			const validIds: MiUser['id'][] = [];
			for (const row of rows) {
				if (existingIds.has(row.key) && followedIds.has(row.key)) validIds.push(row.key);
				else await stateService.delete(userId, ENDORSEMENT_KIND, row.key);
			}
			return validIds;
		});
	}

	public async endorse(userId: MiUser['id'], targetUserId: MiUser['id']): Promise<{ accountId: MiUser['id'] }> {
		return await this.mastodonApiStateService.withUserKindLock(userId, ENDORSEMENT_KIND, async stateService => {
			const existing = await stateService.get(userId, ENDORSEMENT_KIND, targetUserId);
			const [exists, follows] = await Promise.all([
				this.usersRepository.existsBy({ id: targetUserId }),
				this.followingsRepository.existsBy({ followerId: userId, followeeId: targetUserId }),
			]);
			if (!exists || !follows) this.invalid('You can endorse only an account you follow');
			if (existing == null) {
				await stateService.put({ userId, kind: ENDORSEMENT_KIND, key: targetUserId, value: { accountId: targetUserId } });
			}
			return { accountId: targetUserId };
		});
	}

	public async unendorse(userId: MiUser['id'], targetUserId: MiUser['id']): Promise<Record<string, never>> {
		return await this.mastodonApiStateService.withUserKindLock(userId, ENDORSEMENT_KIND, async stateService => {
			await stateService.delete(userId, ENDORSEMENT_KIND, targetUserId);
			return {};
		});
	}

	public async isEndorsed(userId: MiUser['id'], targetUserId: MiUser['id']): Promise<boolean> {
		return await this.mastodonApiStateService.withUserKindLock(userId, ENDORSEMENT_KIND, async stateService => {
			const row = await stateService.get(userId, ENDORSEMENT_KIND, targetUserId);
			if (row == null) return false;
			const [exists, follows] = await Promise.all([
				this.usersRepository.existsBy({ id: targetUserId }),
				this.followingsRepository.existsBy({ followerId: userId, followeeId: targetUserId }),
			]);
			if (exists && follows) return true;
			await stateService.delete(userId, ENDORSEMENT_KIND, targetUserId);
			return false;
		});
	}

	public async listDomainBlocks(userId: MiUser['id']): Promise<string[]> {
		const profile = await this.cacheService.userProfileCache.fetch(userId);
		return [...new Set(profile.mutedInstances.map(domain => domain.toLowerCase()))];
	}

	public async blockDomain(userId: MiUser['id'], rawDomain: string): Promise<Record<string, never>> {
		return await this.mutateDomainBlocks(userId, rawDomain, true);
	}

	public async unblockDomain(userId: MiUser['id'], rawDomain: string): Promise<Record<string, never>> {
		return await this.mutateDomainBlocks(userId, rawDomain, false);
	}

	public async muteThread(userId: MiUser['id'], threadId: string): Promise<Record<string, never>> {
		await this.noteThreadMutingsRepository.query(`
			INSERT INTO "note_thread_muting" ("id", "userId", "threadId")
			VALUES ($1, $2, $3)
			ON CONFLICT ("userId", "threadId") DO NOTHING
		`, [this.idService.gen(), userId, threadId]);
		return {};
	}

	public async unmuteThread(userId: MiUser['id'], threadId: string): Promise<Record<string, never>> {
		await this.noteThreadMutingsRepository.delete({ userId, threadId });
		return {};
	}

	public async mutedNoteIds(userId: MiUser['id'], noteIds: string[]): Promise<Set<string>> {
		if (noteIds.length === 0) return new Set();
		const ids = [...new Set(noteIds)];
		const rows = await this.noteThreadMutingsRepository.query(`
			SELECT note."id" AS "id"
			FROM "note" note
			INNER JOIN "note_thread_muting" muting
				ON muting."userId" = $1
				AND muting."threadId" = COALESCE(note."threadId", note."id")
			WHERE note."id" = ANY($2::varchar[])
		`, [userId, ids]) as { id: string }[];
		return new Set(rows.map(row => row.id));
	}

	private normalizeTag(rawName: string): NormalizedTag {
		const name = rawName.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase();
		if (name === '' || [...name].length > 100 || !/^[\p{L}\p{M}\p{N}_]+$/u.test(name)) this.invalid('Invalid hashtag name');
		const key = name.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC');
		return { key, name };
	}

	private tagState(row: { id: string; key: string; value: unknown }): MastodonUserTagState {
		const value = row.value;
		const name = value != null && typeof value === 'object' && !Array.isArray(value) && typeof (value as { name?: unknown }).name === 'string'
			? (value as { name: string }).name
			: row.key;
		return { id: row.id, name };
	}

	private normalizeDomain(rawDomain: string): string {
		const value = rawDomain.normalize('NFKC').trim().replace(/^\.+|\.+$/gu, '').toLowerCase();
		const domain = domainToASCII(value).toLowerCase();
		if (domain === '' || domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(domain) || domain.includes('..')) {
			this.invalid('Invalid domain');
		}
		return domain;
	}

	private async mutateDomainBlocks(userId: MiUser['id'], rawDomain: string, blocked: boolean): Promise<Record<string, never>> {
		const domain = this.normalizeDomain(rawDomain);
		await this.userProfilesRepository.manager.transaction(async manager => {
			const repository = manager.getRepository(MiUserProfile);
			const profile = await repository.findOne({ where: { userId }, lock: { mode: 'pessimistic_write' } });
			if (profile == null) this.notFound('Account profile not found');
			const current = new Set(profile.mutedInstances.map(value => value.toLowerCase()));
			if (blocked) current.add(domain);
			else current.delete(domain);
			const mutedInstances = [...current];
			await repository.update({ userId }, { mutedInstances });
		});
		// mutedInstances is private local filtering state. Refresh connected clients, but deliberately avoid a federation account update.
		await this.cacheService.userProfileCache.delete(userId);
		const packed = await this.userEntityService.pack(userId, { id: userId }, { schema: 'MeDetailed', includeSecrets: true });
		this.globalEventService.publishMainStream(userId, 'meUpdated', packed);
		return {};
	}

	private invalid(message: string): never {
		throw new MastodonApiError(422, 'unprocessable_entity', message);
	}

	private notFound(message: string): never {
		throw new MastodonApiError(404, 'not_found', message);
	}
}
