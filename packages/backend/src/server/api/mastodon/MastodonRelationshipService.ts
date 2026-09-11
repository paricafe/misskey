/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RoleService } from '@/core/RoleService.js';
import type { Packed } from '@/misc/json-schema.js';
import { ApiError } from '@/server/api/error.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import { MastodonApiCallService } from './MastodonApiCallService.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';
import { MastodonApiError } from './errors.js';
import type { MastodonUserAuth } from './types.js';

const FOLLOW_KIND = 'relationship_follow';
const MUTE_KIND = 'relationship_mute';
type FollowState = { reblogs: boolean; languages: string[] };
type MuteState = { notifications: boolean; expiresAt: number | null };
type Dictionary = Record<string, unknown>;
type RelationshipUser = Packed<'UserLite'> & Partial<Packed<'UserDetailedNotMeOnly'>>;
export type MastodonRelationshipAction = 'follow' | 'unfollow' | 'block' | 'unblock' | 'mute' | 'unmute';
export type MastodonRelationshipContext = 'home' | 'public' | 'account' | 'thread' | 'notifications';

@Injectable()
export class MastodonRelationshipService {
	constructor(
		private mastodonApiStateService: MastodonApiStateService,
		private mastodonApiCallService: MastodonApiCallService,
		private rateLimiterService: RateLimiterService,
		private roleService: RoleService,
	) {}

	public async action(
		action: MastodonRelationshipAction,
		targetId: string,
		body: Dictionary,
		auth: MastodonUserAuth,
		request: FastifyRequest,
	): Promise<Packed<'UserDetailed'>> {
		if (targetId === auth.user.id) this.invalid('You cannot perform this relationship action on yourself');
		if (action === 'mute' && auth.user.movedToUri) throw new MastodonApiError(403, 'forbidden', 'You have moved your account');
		return await this.mastodonApiStateService.withUserKindLock(auth.user.id, `relationship:${targetId}`, async state => {
			const user = await this.user(targetId, auth, request);
			if (action === 'follow') {
				const previous = this.followState((await state.get(auth.user.id, FOLLOW_KIND, targetId))?.value);
				const reblogs = Object.hasOwn(body, 'reblogs') ? this.boolean(body.reblogs, 'reblogs') : previous?.reblogs ?? !(user.isRenoteMuted ?? false);
				const languages = Object.hasOwn(body, 'languages') || Object.hasOwn(body, 'languages[]')
					? this.languages(body['languages[]'] ?? body.languages)
					: previous?.languages ?? [];
				const notify = Object.hasOwn(body, 'notify') ? this.boolean(body.notify, 'notify') : undefined;
				if (notify === true && !user.isFollowing && (user.hasPendingFollowRequestFromYou || user.isLocked || user.host != null || auth.user.isBot)) {
					// Remote follows and careful-bot follows require approval even when the account is public.
					this.invalid('Enable post notifications after the follow request has been accepted');
				}
				if (!user.hasPendingFollowRequestFromYou) await this.native('following/create', targetId, auth, request, ['ALREADY_FOLLOWING']);
				if (notify != null) {
					const followed = user.isFollowing ? user : await this.user(targetId, auth, request);
					if (notify && !followed.isFollowing) this.invalid('Enable post notifications after the follow request has been accepted');
					if (followed.isFollowing) {
						await this.mastodonApiCallService.invoke('following/update', { userId: targetId, notify: notify ? 'normal' : 'none' }, auth, request);
					}
				}
				await state.put({ userId: auth.user.id, kind: FOLLOW_KIND, key: targetId, value: { reblogs, languages } satisfies FollowState });
			} else if (action === 'unfollow') {
				if (user.hasPendingFollowRequestFromYou) {
					await this.native('following/requests/cancel', targetId, auth, request, ['FOLLOW_REQUEST_NOT_FOUND']);
				}
				await this.native('following/delete', targetId, auth, request, ['NOT_FOLLOWING']);
				await state.delete(auth.user.id, FOLLOW_KIND, targetId);
			} else if (action === 'block' || action === 'unblock') {
				await this.native(`blocking/${action === 'block' ? 'create' : 'delete'}`, targetId, auth, request, [action === 'block' ? 'ALREADY_BLOCKING' : 'NOT_BLOCKING']);
				if (action === 'block') await state.delete(auth.user.id, FOLLOW_KIND, targetId);
			} else if (action === 'mute') {
				const notifications = Object.hasOwn(body, 'notifications') ? this.boolean(body.notifications, 'notifications') : true;
				const duration = this.duration(body.duration);
				if (user.isMuted && (!notifications || duration > 0)) {
					this.invalid('A native Misskey mute must be removed before changing its notification or expiry settings');
				}
				await this.checkMuteRate(auth.user.id);
				const expiresAt = duration === 0 ? null : Date.now() + duration * 1000;
				await state.put({
					userId: auth.user.id,
					kind: MUTE_KIND,
					key: targetId,
					value: { notifications, expiresAt } satisfies MuteState,
					expiresAt: expiresAt == null ? null : new Date(expiresAt),
				});
			} else {
				if (user.isMuted) await this.native('mute/delete', targetId, auth, request, ['NOT_MUTING']);
				await state.delete(auth.user.id, MUTE_KIND, targetId);
			}
			return await this.user(targetId, auth, request) as Packed<'UserDetailed'>;
		});
	}

	public async relationship<T extends Dictionary>(userId: string, user: RelationshipUser, base: T): Promise<T> {
		const [followRow, muteRow] = await Promise.all([
			this.mastodonApiStateService.get(userId, FOLLOW_KIND, user.id),
			this.mastodonApiStateService.get(userId, MUTE_KIND, user.id),
		]);
		const follow = user.isFollowing || user.hasPendingFollowRequestFromYou ? this.followState(followRow?.value) : null;
		const mute = this.muteState(muteRow?.value);
		return {
			...base,
			...(follow == null ? {} : { showing_reblogs: follow.reblogs, languages: follow.languages }),
			muting: user.isMuted === true || mute != null,
			muting_notifications: user.isMuted === true || mute?.notifications === true,
		};
	}

	public async listMutes(userId: string): Promise<Array<{ id: string; accountId: string }>> {
		const rows = await this.mastodonApiStateService.list(userId, MUTE_KIND);
		return rows.filter(row => this.muteState(row.value) != null).map(row => ({ id: row.id, accountId: row.key }));
	}

	public async filterStatuses<T extends Dictionary>(userId: string, statuses: readonly T[], context: MastodonRelationshipContext): Promise<T[]> {
		const ids = statuses.flatMap(status => this.statusAccountIds(status));
		const [mutes, follows] = await Promise.all([
			this.stateByAccount(userId, MUTE_KIND, ids),
			context === 'home' ? this.stateByAccount(userId, FOLLOW_KIND, ids) : Promise.resolve(new Map<string, unknown>()),
		]);
		return statuses.filter(status => {
			if (this.statusAccountIds(status).some(id => {
				const mute = this.muteState(mutes.get(id));
				return mute != null && (context !== 'notifications' || mute.notifications);
			})) return false;
			const accountId = this.accountId(status);
			const follow = accountId == null ? null : this.followState(follows.get(accountId));
			if (follow == null) return true;
			if (!follow.reblogs && status.reblog != null) return false;
			// As in Mastodon, an undetermined language passes through a language preference.
			return follow.languages.length === 0 || typeof status.language !== 'string' || status.language === '' || follow.languages.includes(status.language);
		});
	}

	public async filterNotifications<T extends Dictionary>(userId: string, notifications: readonly T[]): Promise<T[]> {
		const ids = notifications.flatMap(notification => {
			const id = this.accountId(notification);
			return id == null ? [] : [id];
		});
		const mutes = await this.stateByAccount(userId, MUTE_KIND, ids);
		return notifications.filter(notification => {
			const id = this.accountId(notification);
			return id == null || this.muteState(mutes.get(id))?.notifications !== true;
		});
	}

	private async stateByAccount(userId: string, kind: string, ids: string[]): Promise<Map<string, unknown>> {
		const unique = [...new Set(ids)];
		const result = new Map<string, unknown>();
		for (let offset = 0; offset < unique.length; offset += 100) {
			const rows = await this.mastodonApiStateService.getMany(userId, kind, unique.slice(offset, offset + 100));
			for (const [key, row] of rows) result.set(key, row.value);
		}
		return result;
	}

	private accountId(value: Dictionary): string | null {
		const account = value.account;
		return account != null && typeof account === 'object' && 'id' in account && typeof account.id === 'string' ? account.id : null;
	}

	private statusAccountIds(status: Dictionary): string[] {
		const ids = [this.accountId(status)];
		if (status.reblog != null && typeof status.reblog === 'object') ids.push(this.accountId(status.reblog as Dictionary));
		return ids.filter((id): id is string => id != null);
	}

	private followState(value: unknown): FollowState | null {
		if (value == null || typeof value !== 'object' || !('reblogs' in value) || typeof value.reblogs !== 'boolean' || !('languages' in value) || !Array.isArray(value.languages)) return null;
		return { reblogs: value.reblogs, languages: value.languages.filter((language): language is string => typeof language === 'string') };
	}

	private muteState(value: unknown): MuteState | null {
		if (value == null || typeof value !== 'object' || !('notifications' in value) || typeof value.notifications !== 'boolean' || !('expiresAt' in value)) return null;
		if (value.expiresAt !== null && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now())) return null;
		return { notifications: value.notifications, expiresAt: value.expiresAt };
	}

	private boolean(value: unknown, name: string): boolean {
		if (value === true || value === 'true' || value === '1' || value === 1) return true;
		if (value === false || value === 'false' || value === '0' || value === 0) return false;
		throw new MastodonApiError(400, 'invalid_request', `${name} must be a boolean`);
	}

	private languages(value: unknown): string[] {
		const values = typeof value === 'string' ? [value] : value;
		if (!Array.isArray(values) || values.some(language => typeof language !== 'string' || !/^[a-z]{2,3}$/u.test(language))) {
			throw new MastodonApiError(400, 'invalid_request', 'languages must be an array of language codes');
		}
		return [...new Set(values)];
	}

	private duration(value: unknown): number {
		if (value == null || value === '') return 0;
		if (typeof value !== 'number' && typeof value !== 'string') this.invalid('duration must be a non-negative number of seconds');
		const duration = Number(value);
		if (!Number.isFinite(duration) || duration < 0 || !Number.isSafeInteger(Math.ceil(Date.now() + duration * 1000))) this.invalid('duration must be a non-negative number of seconds');
		return duration;
	}

	private async user(targetId: string, auth: MastodonUserAuth, request: FastifyRequest): Promise<RelationshipUser> {
		return await this.mastodonApiCallService.invoke('users/show', { userId: targetId }, auth, request) as RelationshipUser;
	}

	private async native(endpoint: string, targetId: string, auth: MastodonUserAuth, request: FastifyRequest, idempotentErrors: string[]): Promise<void> {
		try {
			await this.mastodonApiCallService.invoke(endpoint, { userId: targetId }, auth, request);
		} catch (error) {
			if (!(error instanceof ApiError) || !idempotentErrors.includes(error.code)) throw error;
		}
	}

	private async checkMuteRate(userId: string): Promise<void> {
		const factor = (await this.roleService.getUserPolicies(userId)).rateLimitFactor;
		if (factor === 0) return;
		const rate = await this.rateLimiterService.limit({ key: 'mastodon:mute', duration: 3_600_000, max: 20 }, userId, factor);
		if (rate != null) {
			throw new ApiError({ message: 'Rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED', kind: 'client', id: 'mastodon-relationship-rate-limit', httpStatusCode: 429 }, rate.info);
		}
	}

	private invalid(message: string): never {
		throw new MastodonApiError(422, 'unprocessable_entity', message);
	}
}
