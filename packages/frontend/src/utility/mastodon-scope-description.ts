/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { i18n } from '@/i18n.js';

export function mastodonScopeDescription(scope: string): string {
	const descriptions = i18n.ts._auth._mastodonScopes as Readonly<Record<string, string>>;
	return Object.hasOwn(descriptions, scope) ? descriptions[scope] : scope;
}
