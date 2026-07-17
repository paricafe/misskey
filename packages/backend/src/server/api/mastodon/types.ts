/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiMastodonOAuthToken } from '@/models/MastodonOAuthToken.js';
import type { MiLocalUser } from '@/models/User.js';

export type MastodonApplicationAuth = {
	kind: 'application';
	user: null;
	token: MiMastodonOAuthToken;
};

export type MastodonUserAuth = {
	kind: 'user';
	user: MiLocalUser;
	token: MiMastodonOAuthToken;
};

export type MastodonAuth = MastodonApplicationAuth | MastodonUserAuth;

export type MastodonApplicationRegistration = {
	client_name: string;
	redirect_uris: string | string[];
	scopes?: string | string[];
	website?: string;
};

export type MastodonCredentialApplication = {
	id: string;
	name: string;
	website: string | null;
	redirect_uri: string;
	redirect_uris: string[];
	scopes: string[];
	client_id: string;
	client_secret: string;
	client_secret_expires_at: 0;
};
