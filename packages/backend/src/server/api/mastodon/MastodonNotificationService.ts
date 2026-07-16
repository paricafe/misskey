/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import type { MiGroupedNotification } from '@/models/Notification.js';
import type { MiMastodonUserState } from '@/models/MastodonUserState.js';
import type { FollowingsRepository, UsersRepository } from '@/models/_.js';
import { MastodonApiError } from './errors.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';
import { digestCredential } from './utils.js';

const DISMISSAL_TTL_SECONDS = 90 * 24 * 60 * 60;
const DISMISSAL_TTL_MILLISECONDS = DISMISSAL_TTL_SECONDS * 1000;
const POLICY_KIND = 'notification_policy';
const REQUEST_KIND = 'notification_request';
const GROUP_DISMISS_KIND = 'notification_group_dismissed';
const POLICY_KEY = 'policy';
const DEFAULT_GROUPED_TYPES = ['favourite', 'reblog', 'follow'] as const;

type Dictionary = Record<string, unknown>;
type PolicyAction = 'accept' | 'filter' | 'drop';
type PolicyContext = {
	createdAtByActorId: Map<string, Date>;
	silencedActorIds: Set<string>;
	followingActorIds: Set<string>;
	followerActorIds: Set<string>;
};

export type MastodonNotificationSource = {
	native: { id: string; createdAt: string } & Dictionary;
	entity: {
		id: string;
		type: string;
		created_at: string;
		account: Dictionary & { id: string };
		status?: Dictionary & { id: string };
	} & Dictionary;
	policy?: PolicyAction;
};

export type MastodonNotificationPolicy = {
	for_not_following: PolicyAction;
	for_not_followers: PolicyAction;
	for_new_accounts: PolicyAction;
	for_private_mentions: PolicyAction;
	for_limited_accounts: PolicyAction;
	summary: {
		pending_requests_count: number;
		pending_notifications_count: number;
	};
};

export type MastodonNotificationGroup = {
	group_key: string;
	notifications_count: number;
	type: string;
	most_recent_notification_id: string;
	page_min_id: string;
	page_max_id: string;
	latest_page_notification_at: string;
	sample_account_ids: string[];
	status_id?: string;
};

export type MastodonGroupedNotificationsResults = {
	accounts: Dictionary[];
	statuses: Dictionary[];
	notification_groups: MastodonNotificationGroup[];
};

export type MastodonNotificationGroupAccountsPage = {
	accounts: Dictionary[];
	notifications: { id: string }[];
};

export type MastodonNotificationRequest = {
	id: string;
	created_at: string;
	updated_at: string;
	notifications_count: string;
	account: Dictionary;
	last_status: Dictionary | null;
};

export type MastodonLegacyNotificationPolicy = {
	filter_not_following: boolean;
	filter_not_followers: boolean;
	filter_new_accounts: boolean;
	filter_private_mentions: boolean;
	summary: MastodonNotificationPolicy['summary'];
};

type StoredRequest = {
	actorId: string;
	createdAt: string;
	updatedAt: string;
	lastNotificationId: string;
	dismissedThroughId: string | null;
	accepted: boolean;
};

const DEFAULT_POLICY: Omit<MastodonNotificationPolicy, 'summary'> = {
	for_not_following: 'accept',
	for_not_followers: 'accept',
	for_new_accounts: 'accept',
	for_private_mentions: 'drop',
	for_limited_accounts: 'filter',
};

@Injectable()
export class MastodonNotificationService {
	private readonly misskeyTypes: Readonly<Record<string, MiGroupedNotification['type'][]>> = {
		mention: ['mention', 'reply', 'quote'],
		status: ['note'],
		reblog: ['renote', 'renote:grouped'],
		favourite: ['reaction', 'reaction:grouped'],
		follow: ['follow', 'followRequestAccepted'],
		follow_request: ['receiveFollowRequest'],
		poll: ['pollEnded'],
	};

	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,
		private mastodonApiStateService: MastodonApiStateService,
		private idService: IdService,
		private roleService: RoleService,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,
	) {}

	public toMisskeyTypes(types: readonly string[]): MiGroupedNotification['type'][] {
		return types.flatMap(type => this.misskeyTypes[type] ?? []);
	}

	public async dismiss(userId: string, notificationId: string): Promise<void> {
		await this.dismissMany(userId, [notificationId]);
	}

	public async dismissMany(userId: string, notificationIds: string[]): Promise<void> {
		const uniqueIds = [...new Set(notificationIds)];
		if (uniqueIds.length > 100) this.invalid('notification IDs must contain at most 100 items');
		if (uniqueIds.length === 0) return;
		const key = this.key(userId);
		const now = Date.now();
		await this.redis.zadd(key, ...uniqueIds.flatMap(id => [now, id]));
		await this.redis.zremrangebyscore(key, 0, now - DISMISSAL_TTL_MILLISECONDS);
		await this.redis.zremrangebyrank(key, 0, -1001);
		await this.redis.expire(key, DISMISSAL_TTL_SECONDS);
	}

	public async filterDismissed<T extends { id: string }>(userId: string, values: readonly T[]): Promise<T[]> {
		const key = this.key(userId);
		const scores = await Promise.all(values.map(value => this.redis.zscore(key, value.id)));
		return values.filter((_value, index) => scores[index] == null);
	}

	public async grouped(
		userId: string,
		notifications: MastodonNotificationSource[],
		options: { groupedTypes?: string[]; limit: number },
	): Promise<MastodonGroupedNotificationsResults> {
		const groupedTypes = new Set(options.groupedTypes ?? DEFAULT_GROUPED_TYPES);
		const visible = await this.visibleNotifications(this.mastodonApiStateService, userId, notifications);
		const limit = Math.min(80, Math.max(1, Math.floor(options.limit)));
		return this.groupResults([...this.notificationGroupPage(visible, groupedTypes, limit).entries()]);
	}

	public async group(userId: string, notifications: MastodonNotificationSource[], groupKey: string, groupedTypes: string[] = [...DEFAULT_GROUPED_TYPES]): Promise<MastodonGroupedNotificationsResults> {
		const visible = await this.visibleGroupValues(userId, notifications, groupKey, groupedTypes);
		return this.groupResults([[groupKey, visible]]);
	}

	public async groupAccounts(userId: string, notifications: MastodonNotificationSource[], groupKey: string, groupedTypes: string[] = [...DEFAULT_GROUPED_TYPES]): Promise<Dictionary[]> {
		return (await this.group(userId, notifications, groupKey, groupedTypes)).accounts;
	}

	public async groupAccountsPage(
		userId: string,
		notifications: MastodonNotificationSource[],
		groupKey: string,
		options: { limit: number; maxId?: string; minId?: string; sinceId?: string },
	): Promise<MastodonNotificationGroupAccountsPage> {
		const values = this.groupValues(notifications, groupKey, [...DEFAULT_GROUPED_TYPES]);
		if (values == null || values.length === 0) return { accounts: [], notifications: [] };
		const visible = await this.visibleNotifications(this.mastodonApiStateService, userId, values);
		if (visible.length === 0) return { accounts: [], notifications: [] };
		const lowerId = this.lowerId(options.minId, options.sinceId);
		const filtered = visible
			.filter(value => options.maxId == null || options.maxId === '' || value.entity.id < options.maxId)
			.filter(value => lowerId == null || lowerId === '' || value.entity.id > lowerId)
			.sort((left, right) => (options.minId == null || options.minId === '' ? 1 : -1) * right.entity.id.localeCompare(left.entity.id));
		const limit = Math.min(80, Math.max(1, Math.floor(options.limit)));
		const selected: MastodonNotificationSource[] = [];
		const actorIds = new Set<string>();
		for (const value of filtered) {
			const actorId = value.entity.account.id;
			if (!actorIds.has(actorId) && actorIds.size >= limit) break;
			selected.push(value);
			actorIds.add(actorId);
		}
		const descending = selected.sort((left, right) => right.entity.id.localeCompare(left.entity.id));
		const accounts = new Map<string, Dictionary>();
		for (const value of descending) accounts.set(value.entity.account.id, value.entity.account);
		return { accounts: [...accounts.values()], notifications: descending.map(value => ({ id: value.entity.id })) };
	}

	public async dismissGroup(userId: string, notifications: MastodonNotificationSource[], groupKey: string, groupedTypes: string[] = [...DEFAULT_GROUPED_TYPES]): Promise<Record<string, never>> {
		const values = this.groupValues(notifications, groupKey, groupedTypes);
		if (values == null || values.length === 0) this.notFound('Notification group not found');
		await this.dismissMany(userId, values.map(value => value.entity.id));
		const identity = this.canonicalIdentity(values[0]!);
		if (!groupKey.startsWith('ungrouped-') && groupKey === identity) {
			await this.mastodonApiStateService.withUserKindLock(userId, GROUP_DISMISS_KIND, async stateService => {
				await stateService.put({
					userId,
					kind: GROUP_DISMISS_KIND,
					key: digestCredential(identity),
					value: { identity, dismissedThroughId: values[0]!.entity.id },
					expiresAt: new Date(Date.now() + DISMISSAL_TTL_MILLISECONDS),
				});
			});
		}
		return {};
	}

	public async clearGroups(userId: string, notifications: MastodonNotificationSource[], _groupedTypes?: string[]): Promise<Record<string, never>> {
		const groups = this.notificationGroups(notifications, new Set<string>(DEFAULT_GROUPED_TYPES));
		await this.dismissMany(userId, notifications.map(value => value.entity.id));
		await this.mastodonApiStateService.withUserKindLock(userId, GROUP_DISMISS_KIND, async stateService => {
			const expiresAt = new Date(Date.now() + DISMISSAL_TTL_MILLISECONDS);
			for (const [groupKey, values] of groups) {
				const identity = this.canonicalIdentity(values[0]!);
				if (groupKey.startsWith('ungrouped-') || groupKey !== identity) continue;
				await stateService.put({ userId, kind: GROUP_DISMISS_KIND, key: digestCredential(identity), value: { identity, dismissedThroughId: values[0]!.entity.id }, expiresAt });
			}
		});
		return {};
	}

	private groupResults(selected: [string, MastodonNotificationSource[]][]): MastodonGroupedNotificationsResults {
		const accounts = new Map<string, Dictionary>();
		const statuses = new Map<string, Dictionary>();
		const notificationGroups = selected.map(([groupKey, values]) => {
			const ids = values.map(value => value.entity.id).sort();
			const sampleAccountIds: string[] = [];
			for (const value of values) {
				if (!accounts.has(value.entity.account.id)) accounts.set(value.entity.account.id, value.entity.account);
				if (!sampleAccountIds.includes(value.entity.account.id) && sampleAccountIds.length < 8) sampleAccountIds.push(value.entity.account.id);
				if (value.entity.status != null && !statuses.has(value.entity.status.id)) statuses.set(value.entity.status.id, value.entity.status);
			}
			const latest = values[0]!;
			const statusId = this.targetStatusId(latest);
			return {
				group_key: groupKey,
				notifications_count: values.length,
				type: latest.entity.type,
				most_recent_notification_id: latest.entity.id,
				page_min_id: ids[0]!,
				page_max_id: ids.at(-1)!,
				latest_page_notification_at: latest.native.createdAt,
				sample_account_ids: sampleAccountIds,
				...(statusId == null ? {} : { status_id: statusId }),
			};
		});
		return {
			accounts: [...accounts.values()],
			statuses: [...statuses.values()],
			notification_groups: notificationGroups,
		};
	}

	public async getPolicy(userId: string): Promise<MastodonNotificationPolicy> {
		const row = await this.mastodonApiStateService.get(userId, POLICY_KIND, POLICY_KEY);
		return this.policy(row);
	}

	public async updatePolicy(userId: string, input: Dictionary): Promise<MastodonNotificationPolicy> {
		const allowed = new Set(Object.keys(DEFAULT_POLICY));
		const entries = Object.entries(input).filter(([key]) => allowed.has(key));
		for (const [key, value] of entries) {
			if (value !== 'accept' && value !== 'filter' && value !== 'drop') this.invalid(`${key} must be accept, filter, or drop`);
		}
		return await this.mastodonApiStateService.withUserKindLock(userId, POLICY_KIND, async stateService => {
			const current = this.policy(await stateService.get(userId, POLICY_KIND, POLICY_KEY));
			const value = { ...this.policyValue(current), ...Object.fromEntries(entries) };
			const row = await stateService.put({ userId, kind: POLICY_KIND, key: POLICY_KEY, value });
			return this.policy(row);
		});
	}

	public async policyWithSummary(userId: string, notifications: MastodonNotificationSource[]): Promise<MastodonNotificationPolicy> {
		const [policy, requests] = await Promise.all([
			this.getPolicy(userId),
			this.requests(userId, notifications.slice(0, 100), { limit: 100 }),
		]);
		return {
			...policy,
			summary: {
				pending_requests_count: Math.min(100, requests.length),
				pending_notifications_count: Math.min(100, requests.reduce((total, request) => total + Number(request.notifications_count), 0)),
			},
		};
	}

	public legacyPolicy(policy: MastodonNotificationPolicy): MastodonLegacyNotificationPolicy {
		return {
			filter_not_following: policy.for_not_following !== 'accept',
			filter_not_followers: policy.for_not_followers !== 'accept',
			filter_new_accounts: policy.for_new_accounts !== 'accept',
			filter_private_mentions: policy.for_private_mentions !== 'accept',
			summary: policy.summary,
		};
	}

	public async updateLegacyPolicy(userId: string, input: Dictionary): Promise<MastodonNotificationPolicy> {
		const mapping: Readonly<Record<string, keyof Omit<MastodonNotificationPolicy, 'summary'>>> = {
			filter_not_following: 'for_not_following',
			filter_not_followers: 'for_not_followers',
			filter_new_accounts: 'for_new_accounts',
			filter_private_mentions: 'for_private_mentions',
		};
		const update: Dictionary = {};
		for (const [key, target] of Object.entries(mapping)) {
			if (input[key] == null) continue;
			if (typeof input[key] !== 'boolean') this.invalid(`${key} must be a boolean`);
			update[target] = input[key] ? 'filter' : 'accept';
		}
		return await this.updatePolicy(userId, update);
	}

	public async evaluatePolicy(userId: string, notifications: MastodonNotificationSource[]): Promise<MastodonNotificationSource[]> {
		if (notifications.length === 0) return [];
		const actorIds = [...new Set(notifications.map(value => value.entity.account.id))];
		const [context, policyRow, requestRows] = await Promise.all([
			this.policyContext(userId, notifications),
			this.mastodonApiStateService.get(userId, POLICY_KIND, POLICY_KEY),
			this.mastodonApiStateService.getMany(userId, REQUEST_KIND, actorIds),
		]);
		return this.evaluatePolicyLocked(userId, notifications, this.policy(policyRow), context, requestRows);
	}

	public async list(
		userId: string,
		notifications: MastodonNotificationSource[],
		options: { types?: string[]; excludeTypes?: string[]; accountId?: string; includeFiltered?: boolean; groupedTypes?: string[] },
	): Promise<MastodonNotificationSource[]> {
		const types = new Set(options.types ?? []);
		const excluded = new Set(options.excludeTypes ?? []);
		let values = notifications
			.filter(value => types.size === 0 || types.has(value.entity.type))
			.filter(value => !excluded.has(value.entity.type))
			.filter(value => options.accountId == null || value.entity.account.id === options.accountId);
		values = await this.evaluatePolicy(userId, values);
		values = values.filter(value => value.policy !== 'drop' && (options.includeFiltered || value.policy !== 'filter'));
		const visibleEntities = await this.filterDismissed(userId, values.map(value => value.entity));
		const visibleIds = new Set(visibleEntities.map(value => value.id));
		values = values.filter(value => visibleIds.has(value.entity.id));
		const groupedTypes = new Set(options.groupedTypes ?? DEFAULT_GROUPED_TYPES);
		return await this.visibleGroups(this.mastodonApiStateService, userId, values, groupedTypes, true);
	}

	public async unreadCount(
		userId: string,
		notifications: MastodonNotificationSource[],
		options: {
			lastReadId?: string;
			includeFiltered: boolean;
			limit: number;
			types?: string[];
			excludeTypes?: string[];
			accountId?: string;
			groupedTypes?: string[];
			grouped?: boolean;
		},
	): Promise<{ count: number }> {
		const visible = await this.list(userId, notifications, options);
		const limit = Math.min(100, Math.min(1000, Math.max(1, Math.floor(options.limit))));
		const unread = visible.filter(value => options.lastReadId == null || value.entity.id > options.lastReadId!);
		if (options.grouped) {
			const groupKeys = new Set(unread.map(value => typeof value.entity.group_key === 'string' ? value.entity.group_key : value.entity.id));
			return { count: Math.min(limit, groupKeys.size) };
		}
		return { count: unread.slice(0, limit).length };
	}

	public async requests(
		userId: string,
		notifications: MastodonNotificationSource[],
		options: { limit: number; maxId?: string; minId?: string; sinceId?: string },
	): Promise<MastodonNotificationRequest[]> {
		let visible = notifications.slice(0, 100);
		const visibleEntities = await this.filterDismissed(userId, visible.map(value => value.entity));
		const visibleIds = new Set(visibleEntities.map(value => value.id));
		visible = visible.filter(value => visibleIds.has(value.entity.id));
		visible = await this.visibleGroups(this.mastodonApiStateService, userId, visible, new Set<string>(DEFAULT_GROUPED_TYPES), false);
		const context = await this.policyContext(userId, visible);
		return await this.mastodonApiStateService.withUserKindLocks([
			{ userId, kind: POLICY_KIND },
			{ userId, kind: REQUEST_KIND },
		], async stateService => {
			const policy = this.policy(await stateService.get(userId, POLICY_KIND, POLICY_KEY));
			const requestRows = await stateService.getMany(userId, REQUEST_KIND, [...new Set(visible.map(value => value.entity.account.id))]);
			const evaluated = this.evaluatePolicyLocked(userId, visible, policy, context, requestRows);
			const byActor = new Map<string, MastodonNotificationSource[]>();
			for (const notification of evaluated.filter(value => value.policy === 'filter').sort((left, right) => right.entity.id.localeCompare(left.entity.id))) {
				const actorId = notification.entity.account.id;
				const current = byActor.get(actorId) ?? [];
				current.push(notification);
				byActor.set(actorId, current);
			}
			const result: MastodonNotificationRequest[] = [];
			for (const [actorId, values] of byActor) {
				const first = values.at(-1)!;
				const latest = values[0]!;
				const current = requestRows.get(actorId) ?? null;
				const stored = this.storedRequest(current);
				const next: StoredRequest = {
					actorId,
					createdAt: stored?.createdAt ?? first.native.createdAt,
					updatedAt: latest.native.createdAt,
					lastNotificationId: latest.entity.id,
					dismissedThroughId: stored?.dismissedThroughId ?? null,
					accepted: stored?.accepted ?? false,
				};
				if (next.accepted || (next.dismissedThroughId != null && next.dismissedThroughId >= next.lastNotificationId)) continue;
				let row = current;
				if (row == null) {
					const id = this.idService.gen();
					row = await stateService.createWithId({ id, userId, kind: REQUEST_KIND, key: actorId, value: next });
				} else if (stored == null || !this.sameStoredRequest(stored, next)) {
					row = await stateService.put({ userId, kind: REQUEST_KIND, key: actorId, value: next });
				}
				result.push({
					id: row.id,
					created_at: next.createdAt,
					updated_at: next.updatedAt,
					notifications_count: values.length.toString(),
					account: latest.entity.account,
					last_status: latest.entity.status ?? null,
				});
			}
			const lowerId = this.lowerId(options.minId, options.sinceId);
			const filtered = result
				.filter(request => options.maxId == null || options.maxId === '' || request.id < options.maxId)
				.filter(request => lowerId == null || lowerId === '' || request.id > lowerId);
			const limit = Math.min(100, Math.max(1, Math.floor(options.limit)));
			const window = options.minId == null || options.minId === ''
				? filtered.sort((left, right) => right.id.localeCompare(left.id)).slice(0, limit)
				: filtered.sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
			return window.sort((left, right) => right.id.localeCompare(left.id));
		});
	}

	public async getRequest(userId: string, notifications: MastodonNotificationSource[], requestId: string): Promise<MastodonNotificationRequest> {
		const row = await this.mastodonApiStateService.getById(requestId);
		if (row == null || row.userId !== userId || row.kind !== REQUEST_KIND) this.notFound('Notification request not found');
		const request = (await this.requests(userId, notifications, { limit: 100 })).find(value => value.id === requestId);
		if (request == null) this.notFound('Notification request not found');
		return request;
	}

	public async acceptRequest(userId: string, requestId: string): Promise<{ merged: true }> {
		return await this.acceptRequests(userId, [requestId]);
	}

	public async acceptRequests(userId: string, requestIds: string[]): Promise<{ merged: true }> {
		if (requestIds.length > 80) this.invalid('request IDs must contain at most 80 items');
		return await this.mastodonApiStateService.withUserKindLock(userId, REQUEST_KIND, async stateService => {
			for (const requestId of [...new Set(requestIds)]) {
				const row = await this.ownedRequest(stateService, userId, requestId);
				const stored = this.storedRequest(row);
				if (stored == null) this.notFound('Notification request not found');
				await stateService.put({ userId, kind: REQUEST_KIND, key: row.key, value: { ...stored, accepted: true } });
			}
			return { merged: true };
		});
	}

	public async dismissRequest(userId: string, requestId: string): Promise<Record<string, never>> {
		await this.dismissRequests(userId, [requestId]);
		return {};
	}

	public async dismissRequests(userId: string, requestIds: string[]): Promise<Record<string, never>> {
		if (requestIds.length > 80) this.invalid('request IDs must contain at most 80 items');
		return await this.mastodonApiStateService.withUserKindLock(userId, REQUEST_KIND, async stateService => {
			for (const requestId of [...new Set(requestIds)]) {
				const row = await this.ownedRequest(stateService, userId, requestId);
				const stored = this.storedRequest(row);
				if (stored == null) this.notFound('Notification request not found');
				await stateService.put({ userId, kind: REQUEST_KIND, key: row.key, value: { ...stored, dismissedThroughId: stored.lastNotificationId } });
			}
			return {};
		});
	}

	private async policyContext(userId: string, notifications: MastodonNotificationSource[]): Promise<PolicyContext> {
		const actorIds = [...new Set(notifications.map(value => value.entity.account.id))];
		if (actorIds.length === 0) {
			return {
				createdAtByActorId: new Map(),
				silencedActorIds: new Set(),
				followingActorIds: new Set(),
				followerActorIds: new Set(),
			};
		}
		const [users, following, followers] = await Promise.all([
			this.usersRepository.findBy({ id: In(actorIds) }),
			this.followingsRepository.findBy({ followerId: userId, followeeId: In(actorIds) }),
			this.followingsRepository.findBy({ followeeId: userId, followerId: In(actorIds) }),
		]);
		const policies = await Promise.all(users.map(async user => [user.id, await this.roleService.getUserPolicies(user.id)] as const));
		return {
			createdAtByActorId: new Map(users.map(user => [user.id, this.idService.parse(user.id).date] as const)),
			silencedActorIds: new Set(policies.filter(([, policy]) => !policy.canPublicNote).map(([actorId]) => actorId)),
			followingActorIds: new Set(following.map(value => value.followeeId)),
			followerActorIds: new Set(followers.map(value => value.followerId)),
		};
	}

	private evaluatePolicyLocked(
		userId: string,
		notifications: MastodonNotificationSource[],
		policy: MastodonNotificationPolicy,
		context: PolicyContext,
		requestRows: Map<string, MiMastodonUserState>,
	): MastodonNotificationSource[] {
		const now = Date.now();
		return notifications.map(notification => {
			if (notification.policy != null) return notification;
			const actorId = notification.entity.account.id;
			const request = this.storedRequest(requestRows.get(actorId) ?? null);
			if (request?.accepted) return { ...notification, policy: 'accept' as const };
			const actions: PolicyAction[] = [];
			if (!context.followingActorIds.has(actorId)) actions.push(policy.for_not_following);
			if (!context.followerActorIds.has(actorId)) actions.push(policy.for_not_followers);
			const actorCreatedAt = context.createdAtByActorId.get(actorId);
			if (actorCreatedAt != null && now - actorCreatedAt.getTime() < 30 * 24 * 60 * 60 * 1000) actions.push(policy.for_new_accounts);
			if (context.silencedActorIds.has(actorId)) actions.push(policy.for_limited_accounts);
			if (this.isPrivateMention(notification, userId) && !context.followingActorIds.has(actorId) && !this.userStartedThread(notification, userId)) {
				actions.push(policy.for_private_mentions);
			}
			return { ...notification, policy: this.strictest(actions) };
		});
	}

	private async visibleGroups(
		stateService: MastodonApiStateService,
		userId: string,
		notifications: MastodonNotificationSource[],
		groupedTypes: Set<string>,
		attachGroupKey: boolean,
	): Promise<MastodonNotificationSource[]> {
		const visible = await this.visibleNotifications(stateService, userId, notifications);
		const result: MastodonNotificationSource[] = [];
		for (const [groupKey, groupValues] of this.notificationGroups(visible, groupedTypes)) {
			for (const value of groupValues) {
				result.push(attachGroupKey ? { ...value, entity: { ...value.entity, group_key: groupKey } } : value);
			}
		}
		return result.sort((left, right) => right.entity.id.localeCompare(left.entity.id));
	}

	private async visibleNotifications(
		stateService: MastodonApiStateService,
		userId: string,
		notifications: MastodonNotificationSource[],
	): Promise<MastodonNotificationSource[]> {
		const identities = [...new Set(notifications.map(notification => this.canonicalIdentity(notification)))];
		const rows = await stateService.getMany(userId, GROUP_DISMISS_KIND, identities.map(identity => digestCredential(identity)));
		return notifications.filter(notification => {
			const identity = this.canonicalIdentity(notification);
			const dismissedThroughId = this.dismissedThrough(rows.get(digestCredential(identity)) ?? null, identity);
			return dismissedThroughId == null || notification.entity.id > dismissedThroughId;
		});
	}

	private async visibleGroupValues(
		userId: string,
		notifications: MastodonNotificationSource[],
		groupKey: string,
		groupedTypes: string[],
	): Promise<MastodonNotificationSource[]> {
		const values = this.groupValues(notifications, groupKey, groupedTypes);
		if (values == null || values.length === 0) this.notFound('Notification group not found');
		const visible = await this.visibleNotifications(this.mastodonApiStateService, userId, values);
		if (visible.length === 0) this.notFound('Notification group not found');
		return visible;
	}

	private groupValues(notifications: MastodonNotificationSource[], groupKey: string, groupedTypes: string[]): MastodonNotificationSource[] | undefined {
		const ungroupedId = groupKey.startsWith('ungrouped-') ? groupKey.slice('ungrouped-'.length) : null;
		return ungroupedId == null
			? this.notificationGroups(notifications, new Set(groupedTypes)).get(groupKey)
			: notifications.filter(notification => notification.entity.id === ungroupedId);
	}

	private notificationGroups(notifications: MastodonNotificationSource[], groupedTypes: Set<string>): Map<string, MastodonNotificationSource[]> {
		const groups = new Map<string, MastodonNotificationSource[]>();
		for (const notification of [...notifications].sort((left, right) => right.entity.id.localeCompare(left.entity.id))) {
			const key = this.groupKey(notification, groupedTypes);
			const current = groups.get(key) ?? [];
			current.push(notification);
			groups.set(key, current);
		}
		return groups;
	}

	private notificationGroupPage(notifications: MastodonNotificationSource[], groupedTypes: Set<string>, limit: number): Map<string, MastodonNotificationSource[]> {
		const groups = new Map<string, MastodonNotificationSource[]>();
		for (const notification of [...notifications].sort((left, right) => right.entity.id.localeCompare(left.entity.id))) {
			const key = this.groupKey(notification, groupedTypes);
			const current = groups.get(key);
			if (current == null && groups.size >= limit) break;
			if (current == null) groups.set(key, [notification]);
			else current.push(notification);
		}
		return groups;
	}

	private groupKey(notification: MastodonNotificationSource, groupedTypes: Set<string>): string {
		const type = notification.entity.type;
		if (!groupedTypes.has(type) || !['favourite', 'reblog', 'follow'].includes(type)) return `ungrouped-${notification.entity.id}`;
		const target = this.targetStatusId(notification);
		if ((type === 'favourite' || type === 'reblog') && target == null) return `ungrouped-${notification.entity.id}`;
		const hour = Math.floor(Date.parse(notification.native.createdAt) / 3_600_000);
		return [type, target, hour].filter(value => value != null && value !== '').join('-');
	}

	private canonicalIdentity(notification: MastodonNotificationSource): string {
		return this.groupKey(notification, new Set<string>(DEFAULT_GROUPED_TYPES));
	}

	private targetStatusId(notification: MastodonNotificationSource): string | null {
		return notification.entity.type === 'favourite' || notification.entity.type === 'reblog'
			? notification.entity.status?.id ?? null
			: null;
	}

	private dismissedThrough(row: MiMastodonUserState | null, identity: string): string | null {
		if (row == null || (row.expiresAt != null && row.expiresAt.getTime() <= Date.now()) || row.kind !== GROUP_DISMISS_KIND || row.value == null || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
		const value = row.value as { identity?: unknown; dismissedThroughId?: unknown };
		return value.identity === identity && typeof value.dismissedThroughId === 'string' ? value.dismissedThroughId : null;
	}

	private strictest(actions: PolicyAction[]): PolicyAction {
		if (actions.includes('drop')) return 'drop';
		if (actions.includes('filter')) return 'filter';
		return 'accept';
	}

	private lowerId(minId: string | undefined, sinceId: string | undefined): string | undefined {
		if (minId == null || minId === '') return sinceId;
		if (sinceId == null || sinceId === '') return minId;
		return minId > sinceId ? minId : sinceId;
	}

	private isPrivateMention(notification: MastodonNotificationSource, userId: string): boolean {
		if (!['mention', 'reply', 'quote'].includes(notification.entity.type)) return false;
		const note = notification.native.note;
		return note != null && typeof note === 'object' && !Array.isArray(note) &&
			(note as Dictionary).visibility === 'specified' && (note as Dictionary).userId !== userId;
	}

	private userStartedThread(notification: MastodonNotificationSource, userId: string): boolean {
		const note = notification.native.note;
		if (note == null || typeof note !== 'object' || Array.isArray(note)) return false;
		const seenIds = new Set<string>();
		const seenObjects = new Set<object>();
		let reply = (note as Dictionary).reply;
		for (let depth = 0; depth < 32; depth++) {
			if (reply == null || typeof reply !== 'object' || Array.isArray(reply)) return false;
			const current = reply as Dictionary;
			if (current.userId === userId) return true;
			const id = typeof current.id === 'string' ? current.id : null;
			if ((id != null && seenIds.has(id)) || seenObjects.has(reply)) return false;
			if (id != null) seenIds.add(id);
			seenObjects.add(reply);
			reply = current.reply;
		}
		return false;
	}

	private policy(row: MiMastodonUserState | null): MastodonNotificationPolicy {
		const value = row?.value != null && typeof row.value === 'object' && !Array.isArray(row.value) ? row.value as Dictionary : {};
		const stored = Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([key, fallback]) => {
			const current = value[key];
			return [key, current === 'accept' || current === 'filter' || current === 'drop' ? current : fallback];
		})) as Omit<MastodonNotificationPolicy, 'summary'>;
		return { ...stored, summary: { pending_requests_count: 0, pending_notifications_count: 0 } };
	}

	private policyValue(policy: MastodonNotificationPolicy): Omit<MastodonNotificationPolicy, 'summary'> {
		const { summary: _summary, ...value } = policy;
		return value;
	}

	private storedRequest(row: MiMastodonUserState | null): StoredRequest | null {
		if (row == null || row.kind !== REQUEST_KIND || row.value == null || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
		const value = row.value as Partial<StoredRequest>;
		if (typeof value.actorId !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' ||
			typeof value.lastNotificationId !== 'string' || (value.dismissedThroughId != null && typeof value.dismissedThroughId !== 'string') ||
			typeof value.accepted !== 'boolean') return null;
		return { ...value, dismissedThroughId: value.dismissedThroughId ?? null } as StoredRequest;
	}

	private sameStoredRequest(left: StoredRequest, right: StoredRequest): boolean {
		return left.actorId === right.actorId &&
			left.createdAt === right.createdAt &&
			left.updatedAt === right.updatedAt &&
			left.lastNotificationId === right.lastNotificationId &&
			left.dismissedThroughId === right.dismissedThroughId &&
			left.accepted === right.accepted;
	}

	private async ownedRequest(stateService: MastodonApiStateService, userId: string, requestId: string): Promise<MiMastodonUserState> {
		const row = await stateService.getById(requestId);
		if (row == null || row.userId !== userId || row.kind !== REQUEST_KIND) this.notFound('Notification request not found');
		return row;
	}

	private invalid(message: string): never {
		throw new MastodonApiError(422, 'unprocessable_entity', message);
	}

	private notFound(message: string): never {
		throw new MastodonApiError(404, 'not_found', message);
	}

	private key(userId: string): string {
		return `mastodon-api:dismissed-notifications:${userId}`;
	}
}
