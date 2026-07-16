/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { domainToASCII } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
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
	) {}

	public async listFollowedTags(userId: MiUser['id']): Promise<MastodonUserTagState[]> {
		const rows = await this.mastodonApiStateService.list(userId, FOLLOWED_TAG_KIND);
		return rows.map(row => ({ id: row.id, name: row.key }));
	}

	public async followTag(userId: MiUser['id'], rawName: string): Promise<MastodonUserTagState> {
		const name = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FOLLOWED_TAG_KIND, async stateService => {
			const existing = await stateService.get(userId, FOLLOWED_TAG_KIND, name);
			if (existing != null) return { id: existing.id, name: existing.key };
			const rows = await stateService.list(userId, FOLLOWED_TAG_KIND);
			if (rows.length >= FOLLOWED_TAG_LIMIT) this.invalid(`You cannot follow more than ${FOLLOWED_TAG_LIMIT} hashtags`);
			const row = await stateService.put({ userId, kind: FOLLOWED_TAG_KIND, key: name, value: { name } });
			return { id: row.id, name: row.key };
		});
	}

	public async unfollowTag(userId: MiUser['id'], rawName: string): Promise<Record<string, never>> {
		const name = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FOLLOWED_TAG_KIND, async stateService => {
			await stateService.delete(userId, FOLLOWED_TAG_KIND, name);
			return {};
		});
	}

	public async listFeaturedTags(userId: MiUser['id']): Promise<MastodonUserTagState[]> {
		const rows = await this.mastodonApiStateService.list(userId, FEATURED_TAG_KIND);
		return rows.map(row => ({ id: row.id, name: row.key }));
	}

	public async featureTag(userId: MiUser['id'], rawName: string): Promise<MastodonUserTagState> {
		const name = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FEATURED_TAG_KIND, async stateService => {
			const existing = await stateService.get(userId, FEATURED_TAG_KIND, name);
			if (existing != null) return { id: existing.id, name: existing.key };
			const rows = await stateService.list(userId, FEATURED_TAG_KIND);
			if (rows.length >= FEATURED_TAG_LIMIT) this.invalid(`You cannot feature more than ${FEATURED_TAG_LIMIT} hashtags`);
			const row = await stateService.put({ userId, kind: FEATURED_TAG_KIND, key: name, value: { name } });
			return { id: row.id, name: row.key };
		});
	}

	public async unfeatureTag(userId: MiUser['id'], rawName: string): Promise<Record<string, never>> {
		const name = this.normalizeTag(rawName);
		return await this.mastodonApiStateService.withUserKindLock(userId, FEATURED_TAG_KIND, async stateService => {
			await stateService.delete(userId, FEATURED_TAG_KIND, name);
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
		const name = this.normalizeTag(rawName);
		const [followed, featured] = await Promise.all([
			this.mastodonApiStateService.get(userId, FOLLOWED_TAG_KIND, name),
			this.mastodonApiStateService.get(userId, FEATURED_TAG_KIND, name),
		]);
		return { name, following: followed != null, featuring: featured != null };
	}

	public async listEndorsementIds(userId: MiUser['id']): Promise<MiUser['id'][]> {
		return (await this.mastodonApiStateService.list(userId, ENDORSEMENT_KIND)).map(row => row.key);
	}

	public async endorse(userId: MiUser['id'], targetUserId: MiUser['id']): Promise<{ accountId: MiUser['id'] }> {
		const [exists, follows] = await Promise.all([
			this.usersRepository.existsBy({ id: targetUserId }),
			this.followingsRepository.existsBy({ followerId: userId, followeeId: targetUserId }),
		]);
		if (!exists || !follows) this.invalid('You can endorse only an account you follow');
		return await this.mastodonApiStateService.withUserKindLock(userId, ENDORSEMENT_KIND, async stateService => {
			const existing = await stateService.get(userId, ENDORSEMENT_KIND, targetUserId);
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
		return await this.mastodonApiStateService.get(userId, ENDORSEMENT_KIND, targetUserId) != null;
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

	private normalizeTag(rawName: string): string {
		const name = rawName.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase();
		if (name === '' || name.length > 100 || /[\s#,]/u.test(name)) this.invalid('Invalid hashtag name');
		return name;
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
		const updatedProfile = await this.userProfilesRepository.manager.transaction(async manager => {
			const repository = manager.getRepository(MiUserProfile);
			const profile = await repository.findOne({ where: { userId }, lock: { mode: 'pessimistic_write' } });
			if (profile == null) this.notFound('Account profile not found');
			const current = new Set(profile.mutedInstances.map(value => value.toLowerCase()));
			if (blocked) current.add(domain);
			else current.delete(domain);
			const mutedInstances = [...current];
			await repository.update({ userId }, { mutedInstances });
			return { ...profile, mutedInstances };
		});
		await this.cacheService.userProfileCache.set(userId, updatedProfile);
		return {};
	}

	private invalid(message: string): never {
		throw new MastodonApiError(422, 'unprocessable_entity', message);
	}

	private notFound(message: string): never {
		throw new MastodonApiError(404, 'not_found', message);
	}
}
