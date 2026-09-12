/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const NATIVE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
	profile: ['read:account'],
	'read:accounts': ['read:account'],
	'read:blocks': ['read:blocks'],
	'read:bookmarks': ['read:favorites'],
	'read:favourites': ['read:account'],
	'read:filters': [],
	'read:follows': ['read:following'],
	'read:lists': ['read:account'],
	'read:mutes': ['read:mutes'],
	'read:notifications': ['read:notifications', 'read:account'],
	'read:search': ['read:account'],
	'read:statuses': ['read:account'],
	'read:collections': [],
	'write:accounts': ['write:account', 'write:drive'],
	'write:blocks': ['write:blocks'],
	'write:bookmarks': ['write:favorites'],
	'write:conversations': ['write:account'],
	'write:favourites': ['write:reactions'],
	'write:filters': [],
	'write:follows': ['write:following'],
	'write:lists': ['write:account'],
	'write:media': ['read:drive', 'write:drive'],
	'write:mutes': ['write:mutes', 'write:account'],
	'write:notifications': ['write:notifications', 'write:account', 'read:notifications'],
	'write:reports': ['write:report-abuse'],
	'write:statuses': ['write:notes', 'write:votes'],
	'write:collections': [],
	push: ['read:account', 'read:notifications'],
};
const FOLLOW_SCOPES = new Set(['read:follows', 'write:follows', 'read:blocks', 'write:blocks', 'read:mutes', 'write:mutes']);
export const SUPPORTED_SCOPES = ['read', 'write', 'follow', ...Object.keys(NATIVE_PERMISSIONS)] as const;

export class ScopeError extends Error {
	readonly statusCode = 403;
	readonly code = 'insufficient_scope';
}

export function normalizeScopes(value: unknown, defaults: readonly string[] = ['read']): string[] {
	const values = value == null ? [...defaults] : Array.isArray(value) ? value : [value];
	if (values.some(scope => typeof scope !== 'string')) throw new TypeError('Scopes must be strings');
	const scopes = [...new Set((values as string[]).flatMap(scope => scope.split(/\s+/u)).filter(Boolean))];
	if (!scopes.length || scopes.some(scope => !(SUPPORTED_SCOPES as readonly string[]).includes(scope))) throw new TypeError('Invalid OAuth scope');
	return scopes;
}

export function allowsScope(scopes: readonly string[], required: string): boolean {
	return scopes.includes(required)
		|| (required.startsWith('read:') && scopes.includes('read'))
		|| (required.startsWith('write:') && scopes.includes('write'))
		|| (FOLLOW_SCOPES.has(required) && scopes.includes('follow'));
}

export function assertScope(scopes: readonly string[], required: string): void {
	if (!allowsScope(scopes, required)) throw new ScopeError(`Scope ${required} is required`);
}

export function toNativePermissions(scopes: readonly string[]): string[] {
	return [...new Set(Object.entries(NATIVE_PERMISSIONS)
		.filter(([scope]) => allowsScope(scopes, scope))
		.flatMap(([, permissions]) => permissions))];
}
