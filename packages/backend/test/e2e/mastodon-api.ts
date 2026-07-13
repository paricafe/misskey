/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert';
import { beforeAll, describe, test } from 'vitest';
import * as htmlParser from 'node-html-parser';
import { api, relativeFetch, signup } from '../utils.js';
import type * as misskey from 'misskey-js';

describe('Mastodon API compatibility', () => {
	let alice: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'mastodon_alice' });
	});

	test('registers, authorizes without PKCE, calls REST, and keeps tokens isolated', async () => {
		const registrationResponse = await relativeFetch('/api/v1/apps', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Mastodon compatibility test',
				redirect_uris: 'mastodon-test://oauth',
				scopes: 'read write follow push',
			}),
		});
		assert.strictEqual(registrationResponse.status, 200);
		const application = await registrationResponse.json() as { client_id: string; client_secret: string };

		const authorizeUrl = new URL('/oauth/authorize', 'http://misskey.local');
		authorizeUrl.search = new URLSearchParams({
			client_id: application.client_id,
			redirect_uri: 'mastodon-test://oauth',
			response_type: 'code',
			scope: 'read write:statuses',
			state: 'mastodon-state',
		}).toString();
		const authorizationResponse = await relativeFetch(authorizeUrl.pathname + authorizeUrl.search);
		assert.strictEqual(authorizationResponse.status, 200);
		const page = htmlParser.parse(await authorizationResponse.text());
		const transactionId = page.querySelector('meta[name="misskey:oauth:transaction-id"]')?.attributes.content;
		assert.ok(transactionId?.startsWith('mastodon:'));
		if (transactionId == null) throw new Error('Missing OAuth transaction ID');

		const decisionResponse = await relativeFetch('/oauth/decision', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ transaction_id: transactionId, login_token: alice.token }),
			redirect: 'manual',
		});
		assert.strictEqual(decisionResponse.status, 302);
		const redirect = new URL(decisionResponse.headers.get('location')!);
		assert.strictEqual(redirect.protocol, 'mastodon-test:');
		assert.strictEqual(redirect.searchParams.get('state'), 'mastodon-state');
		const code = redirect.searchParams.get('code');
		assert.ok(code);

		const tokenResponse = await relativeFetch('/oauth/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: application.client_id,
				client_secret: application.client_secret,
				redirect_uri: 'mastodon-test://oauth',
			}),
		});
		assert.strictEqual(tokenResponse.status, 200);
		const token = await tokenResponse.json() as { access_token: string; token_type: string; scope: string };
		assert.strictEqual(token.token_type, 'Bearer');

		const verifyResponse = await relativeFetch('/api/v1/accounts/verify_credentials', {
			headers: { authorization: `Bearer ${token.access_token}` },
		});
		assert.strictEqual(verifyResponse.status, 200);
		assert.strictEqual((await verifyResponse.json() as { username: string }).username, alice.username);

		const statusResponse = await relativeFetch('/api/v1/statuses', {
			method: 'POST',
			headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'posted through Mastodon API', visibility: 'public' }),
		});
		assert.strictEqual(statusResponse.status, 200);
		assert.match((await statusResponse.json() as { content: string }).content, /posted through Mastodon API/u);

		const nativeTokenOnMastodon = await relativeFetch('/api/v1/accounts/verify_credentials', {
			headers: { authorization: `Bearer ${alice.token}` },
		});
		assert.strictEqual(nativeTokenOnMastodon.status, 401);
		const mastodonTokenOnNative = await api('i', {}, { token: token.access_token, bearer: true });
		assert.strictEqual(mastodonTokenOnNative.status, 401);

		const revokeResponse = await relativeFetch('/oauth/revoke', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: application.client_id,
				client_secret: application.client_secret,
				token: token.access_token,
			}),
		});
		assert.strictEqual(revokeResponse.status, 200);
		const revokedResponse = await relativeFetch('/api/v1/accounts/verify_credentials', {
			headers: { authorization: `Bearer ${token.access_token}` },
		});
		assert.strictEqual(revokedResponse.status, 401);
	});
});
