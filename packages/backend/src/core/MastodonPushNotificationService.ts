/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import promiseLimit from 'promise-limit';
import push from 'web-push';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import { getNoteSummary } from '@/misc/get-note-summary.js';
import type { FollowingsRepository, MastodonUserStatesRepository, MiMastodonUserState, MiMeta } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { CacheService } from '@/core/CacheService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';

export const MASTODON_PUSH_ALERT_TYPES = [
	'mention', 'quote', 'status', 'reblog', 'follow', 'follow_request', 'favourite', 'poll', 'update', 'quoted_update', 'admin.sign_up', 'admin.report',
] as const;
export const MASTODON_PUSH_POLICIES = ['all', 'none', 'followed', 'follower'] as const;
export type MastodonPushPolicy = typeof MASTODON_PUSH_POLICIES[number];
export type MastodonPushAlerts = Record<typeof MASTODON_PUSH_ALERT_TYPES[number], boolean>;
export type MastodonPushEncryptedBearer = { version: 1; salt: string; iv: string; tag: string; ciphertext: string };
export type MastodonPushState = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	standard: boolean;
	data: { policy: MastodonPushPolicy; alerts: MastodonPushAlerts };
	bearer: MastodonPushEncryptedBearer;
};

export function parseMastodonPushState(value: unknown): MastodonPushState | null {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
	const state = value as Partial<MastodonPushState>;
	if (typeof state.endpoint !== 'string' || state.keys == null || typeof state.keys.p256dh !== 'string' || typeof state.keys.auth !== 'string') return null;
	if (typeof state.standard !== 'boolean' || state.data == null || !MASTODON_PUSH_POLICIES.includes(state.data.policy) || state.bearer?.version !== 1) return null;
	if (typeof state.bearer.salt !== 'string' || typeof state.bearer.iv !== 'string' || typeof state.bearer.tag !== 'string' || typeof state.bearer.ciphertext !== 'string') return null;
	if (state.data.alerts == null || MASTODON_PUSH_ALERT_TYPES.some(type => typeof state.data!.alerts[type] !== 'boolean')) return null;
	return state as MastodonPushState;
}

export function encryptMastodonPushBearer(accessToken: string, userId: string, tokenId: string, subscriptionId: string, privateKey: string): MastodonPushEncryptedBearer {
	const salt = randomBytes(32);
	const iv = randomBytes(12);
	const aad = mastodonPushAad(userId, tokenId, subscriptionId);
	const cipher = createCipheriv('aes-256-gcm', mastodonPushEncryptionKey(privateKey, salt), iv);
	cipher.setAAD(aad);
	const ciphertext = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
	return { version: 1, salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function decryptMastodonPushBearer(value: MastodonPushEncryptedBearer, userId: string, tokenId: string, subscriptionId: string, privateKey: string): string {
	const decipher = createDecipheriv('aes-256-gcm', mastodonPushEncryptionKey(privateKey, Buffer.from(value.salt, 'base64url')), Buffer.from(value.iv, 'base64url'));
	decipher.setAAD(mastodonPushAad(userId, tokenId, subscriptionId));
	decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function mastodonPushEncryptionKey(privateKey: string, salt: Buffer): Buffer {
	return Buffer.from(hkdfSync('sha256', Buffer.from(privateKey, 'base64url'), salt, Buffer.from('misskey-mastodon-push-token-v1'), 32));
}

function mastodonPushAad(userId: string, tokenId: string, subscriptionId: string): Buffer {
	return Buffer.from(`${userId}\0${tokenId}\0${subscriptionId}`);
}

const SEND_CONCURRENCY = 8;
const SEND_TIMEOUT = 10_000;
const SEND_TTL = 48 * 60 * 60;

const notificationTypes = {
	mention: 'mention',
	reply: 'mention',
	quote: 'quote',
	reaction: 'favourite',
	'reaction:grouped': 'favourite',
	renote: 'reblog',
	'renote:grouped': 'reblog',
	follow: 'follow',
	receiveFollowRequest: 'follow_request',
	pollEnded: 'poll',
	note: 'status',
} as const;

export type MastodonNotificationType = typeof notificationTypes[keyof typeof notificationTypes];

export function mastodonPushTitle(actorName: string, type: MastodonNotificationType): string {
	return {
		mention: `You were mentioned by ${actorName}`,
		quote: `${actorName} quoted your post`,
		favourite: `${actorName} favorited your post`,
		reblog: `${actorName} boosted your post`,
		follow: `${actorName} is now following you`,
		follow_request: `Pending follower: ${actorName}`,
		poll: `A poll by ${actorName} has ended`,
		status: `${actorName} just posted`,
	}[type];
}

@Injectable()
export class MastodonPushNotificationService {
	constructor(
		@Inject(DI.config)
		private config: Config,
		@Inject(DI.meta)
		private meta: MiMeta,
		@Inject(DI.mastodonUserStatesRepository)
		private mastodonUserStatesRepository: MastodonUserStatesRepository,
		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,
		private cacheService: CacheService,
		private httpRequestService: HttpRequestService,
	) {}

	@bindThis
	public async pushNotification(userId: string, notification: Packed<'Notification'>): Promise<void> {
		if (!this.available()) return;
		const type = notificationTypes[notification.type as keyof typeof notificationTypes];
		if (type == null) return;
		const rows = await this.mastodonUserStatesRepository.find({ where: { userId, kind: 'push_subscription' }, take: 64 });
		if (rows.length === 0) return;
		const preferredLocale = await this.cacheService.userProfileCache.fetch(userId).then(profile => profile.lang ?? 'en').catch(() => 'en');
		const policies = new Set(rows.flatMap(row => {
			const state = parseMastodonPushState(row.value);
			return state == null ? [] : [state.data.policy];
		}));
		const actorId = notification.user?.id;
		const [followed, follower] = actorId == null ? [false, false] : await Promise.all([
			policies.has('followed') ? this.followingsRepository.existsBy({ followerId: userId, followeeId: actorId }) : false,
			policies.has('follower') ? this.followingsRepository.existsBy({ followerId: actorId, followeeId: userId }) : false,
		]);
		const limit = promiseLimit<void>(SEND_CONCURRENCY);
		await Promise.all(rows.map(row => limit(async () => {
			await this.deliver(row, notification, type, preferredLocale, { followed, follower });
		})));
	}

	private async deliver(row: MiMastodonUserState, notification: Packed<'Notification'>, type: MastodonNotificationType, preferredLocale: string, relations: { followed: boolean; follower: boolean }): Promise<void> {
		const state = parseMastodonPushState(row.value);
		if (state == null || row.tokenId == null) {
			await this.cleanup(row);
			return;
		}
		if (!state.data.alerts[type] || !this.allowsPolicy(state.data.policy, relations)) return;
		let accessToken: string;
		try {
			accessToken = decryptMastodonPushBearer(state.bearer, row.userId, row.tokenId, row.id, this.meta.swPrivateKey!);
		} catch {
			await this.cleanup(row);
			return;
		}
		try {
			const endpoint = new URL(state.endpoint);
			await push.sendNotification({ endpoint: state.endpoint, keys: state.keys }, JSON.stringify(this.payload(accessToken, preferredLocale, notification, type)), {
				contentEncoding: state.standard ? 'aes128gcm' : 'aesgcm',
				TTL: SEND_TTL,
				timeout: SEND_TIMEOUT,
				vapidDetails: {
					subject: this.config.url,
					publicKey: this.meta.swPublicKey!,
					privateKey: this.meta.swPrivateKey!,
				},
				agent: this.httpRequestService.getAgentForHttps(endpoint),
			});
		} catch (error) {
			const statusCode = this.statusCode(error);
			if (statusCode != null && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) await this.cleanup(row);
		}
	}

	private payload(accessToken: string, preferredLocale: string, notification: Packed<'Notification'>, type: MastodonNotificationType): Record<string, string> {
		const actor = notification.user;
		const actorName = actor?.name?.trim() || actor?.username || this.config.host;
		const rawBody = notification.note == null ? actorName : notification.note.cw ?? getNoteSummary(notification.note);
		const body = this.cleanText(rawBody);
		return {
			access_token: accessToken,
			preferred_locale: preferredLocale,
			notification_id: notification.id,
			notification_type: type,
			icon: actor?.avatarUrl ?? this.meta.iconUrl ?? new URL('/favicon.ico', this.config.url).toString(),
			title: mastodonPushTitle(actorName, type),
			body: [...body].slice(0, 140).join(''),
		};
	}

	private allowsPolicy(policy: MastodonPushPolicy, relations: { followed: boolean; follower: boolean }): boolean {
		if (policy === 'all') return true;
		if (policy === 'none') return false;
		return policy === 'followed' ? relations.followed : relations.follower;
	}

	private cleanText(value: string): string {
		return value
			.replace(/<[^>]*>/gu, '')
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, ' ')
			.replace(/\s+/gu, ' ')
			.trim();
	}

	private available(): boolean {
		return this.meta.enableServiceWorker && this.meta.swPublicKey != null && this.meta.swPrivateKey != null;
	}

	private statusCode(error: unknown): number | null {
		return typeof error === 'object' && error != null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
	}

	private async cleanup(row: MiMastodonUserState): Promise<void> {
		await this.mastodonUserStatesRepository.delete({ id: row.id });
	}
}
