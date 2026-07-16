/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { MastodonApiError } from './errors.js';

const GRANULAR_SCOPES = [
	'profile',
	'read:accounts',
	'read:blocks',
	'read:bookmarks',
	'read:favourites',
	'read:filters',
	'read:follows',
	'read:lists',
	'read:mutes',
	'read:notifications',
	'read:search',
	'read:statuses',
	'write:accounts',
	'write:blocks',
	'write:bookmarks',
	'write:conversations',
	'write:favourites',
	'write:filters',
	'write:follows',
	'write:lists',
	'write:media',
	'write:mutes',
	'write:notifications',
	'write:reports',
	'write:statuses',
] as const;

const SUPPORTED_SCOPES = new Set<string>([
	'read',
	'write',
	'follow',
	'push',
	'read:collections',
	'write:collections',
	...GRANULAR_SCOPES,
]);

const MISSKEY_PERMISSIONS_BY_SCOPE: Readonly<Record<(typeof GRANULAR_SCOPES)[number], readonly string[]>> = {
	profile: ['read:account'],
	'read:accounts': ['read:account'],
	'read:blocks': ['read:blocks'],
	'read:bookmarks': ['read:favorites'],
	'read:favourites': ['read:account'],
	'read:filters': ['read:account'],
	'read:follows': ['read:following'],
	'read:lists': ['read:account'],
	'read:mutes': ['read:mutes'],
	'read:notifications': ['read:notifications'],
	'read:search': ['read:account'],
	'read:statuses': ['read:account'],
	'write:accounts': ['write:account'],
	'write:blocks': ['write:blocks'],
	'write:bookmarks': ['write:favorites'],
	'write:conversations': ['write:account'],
	'write:favourites': ['write:reactions'],
	'write:filters': ['write:account'],
	'write:follows': ['write:following'],
	'write:lists': ['write:account'],
	'write:media': ['read:drive', 'write:drive'],
	'write:mutes': ['write:mutes'],
	'write:notifications': ['write:notifications'],
	'write:reports': ['write:report-abuse'],
	'write:statuses': ['write:drive', 'write:notes', 'write:votes'],
};

@Injectable()
export class MastodonScopeService {
	public getSupportedScopes(): string[] {
		return [...SUPPORTED_SCOPES];
	}

	public normalize(value: string | string[] | undefined, defaultScopes: string[] = ['read']): string[] {
		const scopes = value == null
			? defaultScopes
			: (Array.isArray(value) ? value : [value]).flatMap(scope => scope.split(/\s+/u));
		const normalized = [...new Set(scopes.map(scope => scope.trim()).filter(scope => scope !== ''))];

		if (normalized.length === 0) {
			throw new TypeError('at least one scope is required');
		}
		for (const scope of normalized) {
			if (!SUPPORTED_SCOPES.has(scope)) {
				throw new TypeError(`unsupported scope: ${scope}`);
			}
		}

		return normalized;
	}

	public allows(tokenScopes: readonly string[], requiredScope: string): boolean {
		if (tokenScopes.includes(requiredScope)) return true;
		if (requiredScope.startsWith('read:') && tokenScopes.includes('read')) return true;
		if (requiredScope.startsWith('write:') && tokenScopes.includes('write')) return true;
		if ((requiredScope === 'read:follows' || requiredScope === 'write:follows') && tokenScopes.includes('follow')) return true;

		return false;
	}

	public assert(tokenScopes: readonly string[], requiredScope: string): void {
		if (!this.allows(tokenScopes, requiredScope)) {
			throw new MastodonApiError(403, 'insufficient_scope', `Scope ${requiredScope} is required`);
		}
	}

	public allowsAny(tokenScopes: readonly string[], requiredScopes: readonly string[]): boolean {
		return requiredScopes.some(requiredScope => this.allows(tokenScopes, requiredScope));
	}

	public assertAny(tokenScopes: readonly string[], requiredScopes: readonly string[]): void {
		if (!this.allowsAny(tokenScopes, requiredScopes)) {
			throw new MastodonApiError(403, 'insufficient_scope', `One of these scopes is required: ${requiredScopes.join(', ')}`);
		}
	}

	public toMisskeyPermissions(scopes: readonly string[]): string[] {
		const granular = new Set<string>();
		for (const scope of scopes) {
			if (scope === 'read') {
				for (const child of GRANULAR_SCOPES) if (child.startsWith('read:')) granular.add(child);
			} else if (scope === 'write') {
				for (const child of GRANULAR_SCOPES) if (child.startsWith('write:')) granular.add(child);
			} else if (scope === 'follow') {
				granular.add('read:follows');
				granular.add('write:follows');
			} else if (scope !== 'push') {
				granular.add(scope);
			}
		}

		const permissions = new Set<string>();
		for (const scope of GRANULAR_SCOPES) {
			if (!granular.has(scope)) continue;
			for (const permission of MISSKEY_PERMISSIONS_BY_SCOPE[scope]) permissions.add(permission);
		}

		return [...permissions];
	}
}
