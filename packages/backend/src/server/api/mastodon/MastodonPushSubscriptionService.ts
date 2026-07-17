/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ECDH } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import ipaddr from 'ipaddr.js';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import {
	encryptMastodonPushBearer,
	MASTODON_PUSH_ALERT_TYPES,
	MASTODON_PUSH_POLICIES,
	parseMastodonPushState,
	type MastodonPushAlerts,
	type MastodonPushPolicy,
	type MastodonPushState,
} from '@/core/MastodonPushNotificationService.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';
import { MastodonApiError } from './errors.js';
import type { MastodonUserAuth } from './types.js';

const STATE_KIND = 'push_subscription';
const MAX_SUBSCRIPTIONS_PER_USER = 64;

type Dictionary = Record<string, unknown>;

@Injectable()
export class MastodonPushSubscriptionService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,
		private mastodonApiStateService: MastodonApiStateService,
		private idService: IdService,
	) {}

	public async create(auth: MastodonUserAuth, accessToken: string, body: Dictionary): Promise<Dictionary> {
		return await this.mastodonApiStateService.withUserKindLock(auth.user.id, STATE_KIND, async stateService => {
			const existing = await stateService.get(auth.user.id, STATE_KIND, auth.token.id);
			if (existing == null && (await stateService.list(auth.user.id, STATE_KIND)).length >= MAX_SUBSCRIPTIONS_PER_USER) {
				throw this.invalid('A user can have at most 64 push subscriptions');
			}
			const id = this.idService.gen();
			const value = this.parseCreate(body, auth.user.id, auth.token.id, id, accessToken);
			if (existing != null) await stateService.delete(auth.user.id, STATE_KIND, auth.token.id);
			const row = await stateService.createWithId({
				id,
				userId: auth.user.id,
				tokenId: auth.token.id,
				kind: STATE_KIND,
				key: auth.token.id,
				value,
			});
			return this.entity(row.id, value);
		});
	}

	public async get(auth: MastodonUserAuth): Promise<Dictionary> {
		this.ensureAvailable();
		const row = await this.mastodonApiStateService.get(auth.user.id, STATE_KIND, auth.token.id);
		const value = row == null ? null : parseMastodonPushState(row.value);
		if (row == null || value == null || row.tokenId !== auth.token.id) {
			throw new MastodonApiError(404, 'not_found', 'Record not found');
		}
		return this.entity(row.id, value);
	}

	public async update(auth: MastodonUserAuth, body: Dictionary): Promise<Dictionary> {
		this.ensureAvailable();
		return await this.mastodonApiStateService.withUserKindLock(auth.user.id, STATE_KIND, async stateService => {
			const row = await stateService.get(auth.user.id, STATE_KIND, auth.token.id);
			const previous = row == null ? null : parseMastodonPushState(row.value);
			if (row == null || previous == null || row.tokenId !== auth.token.id) {
				throw new MastodonApiError(404, 'not_found', 'Record not found');
			}
			const data = this.parseData(body);
			const value = { ...previous, data };
			const updated = await stateService.put({
				userId: auth.user.id,
				tokenId: auth.token.id,
				kind: STATE_KIND,
				key: auth.token.id,
				value,
			});
			return this.entity(updated.id, value);
		});
	}

	public async delete(auth: MastodonUserAuth): Promise<Dictionary> {
		await this.mastodonApiStateService.delete(auth.user.id, STATE_KIND, auth.token.id);
		return {};
	}

	public vapidPublicKey(): string {
		return this.meta.enableServiceWorker && this.meta.swPublicKey != null && this.meta.swPrivateKey != null
			? this.meta.swPublicKey
			: '';
	}

	private parseCreate(body: Dictionary, userId: string, tokenId: string, subscriptionId: string, accessToken: string): MastodonPushState {
		this.ensureAvailable();
		if (accessToken === '') throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
		const subscription = this.object(body.subscription);
		const keys = this.object(subscription?.keys);
		const endpoint = this.read(body, subscription, 'subscription[endpoint]', 'endpoint');
		const p256dh = this.read(body, keys, 'subscription[keys][p256dh]', 'p256dh');
		const auth = this.read(body, keys, 'subscription[keys][auth]', 'auth');
		if (typeof endpoint !== 'string') throw this.invalid('subscription.endpoint is required');
		if (typeof p256dh !== 'string') throw this.invalid('subscription.keys.p256dh is required');
		if (typeof auth !== 'string') throw this.invalid('subscription.keys.auth is required');
		this.validateEndpoint(endpoint);
		this.validateP256dh(p256dh);
		this.validateAuthSecret(auth);
		const value: MastodonPushState = {
			endpoint,
			keys: { p256dh, auth },
			standard: this.parseBoolean(this.read(body, subscription, 'subscription[standard]', 'standard'), false),
			data: this.parseData(body),
			bearer: encryptMastodonPushBearer(accessToken, userId, tokenId, subscriptionId, this.meta.swPrivateKey!),
		};
		if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw this.invalid('Push subscription is too large');
		return value;
	}

	private parseData(body: Dictionary): MastodonPushState['data'] {
		const data = this.object(body.data);
		const alerts = this.object(data?.alerts);
		const policyValue = this.read(body, data, 'data[policy]', 'policy');
		const policy = policyValue == null ? 'all' : policyValue;
		if (typeof policy !== 'string' || !MASTODON_PUSH_POLICIES.includes(policy as MastodonPushPolicy)) throw this.invalid('data.policy is invalid');
		const parsedAlerts = Object.fromEntries(MASTODON_PUSH_ALERT_TYPES.map(type => {
			const value = this.read(body, alerts, `data[alerts][${type}]`, type);
			return [type, type.startsWith('admin.') ? false : value == null ? false : this.parseBoolean(value)];
		})) as MastodonPushAlerts;
		return { policy: policy as MastodonPushPolicy, alerts: parsedAlerts };
	}

	private entity(id: string, value: MastodonPushState): Dictionary {
		return {
			id,
			endpoint: value.endpoint,
			standard: value.standard,
			alerts: value.data.alerts,
			server_key: this.vapidPublicKey(),
		};
	}

	private validateEndpoint(value: string): void {
		if (value.length > 2048) throw this.invalid('subscription.endpoint is too long');
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw this.invalid('subscription.endpoint must be a valid HTTPS URL');
		}
		if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || url.hostname === '') {
			throw this.invalid('subscription.endpoint must be a valid HTTPS URL');
		}
		const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
		if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw this.invalid('subscription.endpoint must be public');
		if (ipaddr.isValid(hostname) && ipaddr.parse(hostname).range() !== 'unicast') throw this.invalid('subscription.endpoint must be public');
	}

	private validateP256dh(value: string): void {
		const decoded = this.decodeBase64Url(value, 'subscription.keys.p256dh', 128);
		if (decoded.length !== 65 || decoded[0] !== 4) throw this.invalid('subscription.keys.p256dh is invalid');
		try {
			ECDH.convertKey(decoded, 'prime256v1', undefined, undefined, 'uncompressed');
		} catch {
			throw this.invalid('subscription.keys.p256dh is invalid');
		}
	}

	private validateAuthSecret(value: string): void {
		if (this.decodeBase64Url(value, 'subscription.keys.auth', 64).length !== 16) throw this.invalid('subscription.keys.auth is invalid');
	}

	private decodeBase64Url(value: string, name: string, maxLength: number): Buffer {
		if (value.length > maxLength || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) throw this.invalid(`${name} is invalid`);
		const unpadded = value.replace(/=+$/u, '');
		const decoded = Buffer.from(unpadded, 'base64url');
		const canonical = decoded.toString('base64url');
		const padded = canonical.padEnd(Math.ceil(canonical.length / 4) * 4, '=');
		if (value !== canonical && value !== padded) throw this.invalid(`${name} is invalid`);
		return decoded;
	}

	private parseBoolean(value: unknown, fallback?: boolean): boolean {
		if (value == null && fallback != null) return fallback;
		if (value === true || value === 1) return true;
		if (value === false || value === 0) return false;
		if (typeof value === 'string') {
			const normalized = value.toLowerCase();
			if (normalized === '1' || normalized === 'true' || normalized === 't' || normalized === 'on') return true;
			if (normalized === '0' || normalized === 'false' || normalized === 'f' || normalized === 'off') return false;
		}
		throw this.invalid('Boolean field is invalid');
	}

	private ensureAvailable(): void {
		if (this.vapidPublicKey() === '') throw this.invalid('Web push is not configured');
	}

	private read(body: Dictionary, nested: Dictionary | null, bracketKey: string, nestedKey: string): unknown {
		const hasBracket = Object.hasOwn(body, bracketKey);
		const hasNested = nested != null && Object.hasOwn(nested, nestedKey);
		if (hasBracket && hasNested) throw this.invalid(`Conflicting values for ${bracketKey}`);
		const value = hasBracket ? body[bracketKey] : hasNested ? nested![nestedKey] : undefined;
		if (Array.isArray(value)) throw this.invalid(`Repeated values for ${bracketKey}`);
		return value;
	}

	private object(value: unknown): Dictionary | null {
		return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Dictionary : null;
	}

	private invalid(message: string): MastodonApiError {
		return new MastodonApiError(422, 'unprocessable_entity', message);
	}
}
