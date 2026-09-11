/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompatStore } from '../src/store.js';

test('encrypted credentials survive restart while bearer and client secrets are stored only as hashes', t => {
	const directory = mkdtempSync(join(tmpdir(), 'mastodon-store-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const filename = join(directory, 'compat.sqlite');
	const store = new CompatStore(filename);
	const { client, clientSecret } = store.createClient({ name: 'Test', scopes: ['read'], redirectUris: ['test://callback'] });
	const token = store.createGrant({ kind: 'user', clientId: client.id, scopes: ['read'], userId: 'user', nativeToken: 'native-app-credential-never-plaintext' });
	const code = store.issueCode({ clientId: client.id, redirectUri: 'test://callback', scopes: ['read'], userId: 'user', nativeToken: 'native-app-credential-never-plaintext' }, Date.now() + 10000);
	store.putOperation('pending', 'one', { credential: 'operation-secret' }, Date.now() + 10000);
	store.put('push', 'user', 'subscription', { auth: 'metadata-secret' });
	assert.equal(store.getGrant(token.token)?.nativeToken, 'native-app-credential-never-plaintext');
	assert.equal(store.verifyClient(client.id, clientSecret)?.id, client.id);
	assert.equal(store.verifyClient(client.id, 'wrong'), undefined);
	for (const file of readdirSync(directory)) {
		assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
		const bytes = readFileSync(join(directory, file));
		for (const secret of [clientSecret, token.token, code, 'native-app-credential-never-plaintext', 'operation-secret', 'metadata-secret']) assert.equal(bytes.includes(Buffer.from(secret)), false);
	}
	store.close();
	const reopened = new CompatStore(filename);
	assert.equal(reopened.getGrant(token.token)?.nativeToken, 'native-app-credential-never-plaintext');
	assert.equal(reopened.getCode(code)?.nativeToken, 'native-app-credential-never-plaintext');
	assert.equal(reopened.verifyClient(client.id, clientSecret)?.id, client.id);
	reopened.close();
	unlinkSync(`${filename}.key`);
	assert.throws(() => new CompatStore(filename), /encryption key is missing/u);
});

test('metadata is isolated by namespace and owner, with synchronous replacement and deletion', () => {
	const store = new CompatStore(':memory:');
	try {
		store.put('filter', 'alice', 'one', { value: 1 });
		store.put('filter', 'bob', 'one', { value: 2 });
		store.put('marker', 'alice', 'one', { value: 3 });
		store.put('filter', 'alice', 'one', { value: 4 });
		assert.deepEqual(store.list('filter', 'alice'), [{ key: 'one', value: { value: 4 } }]);
		assert.deepEqual(store.get('filter', 'bob', 'one'), { value: 2 });
		assert.equal(store.delete('filter', 'alice', 'one'), true);
		assert.equal(store.delete('filter', 'alice', 'one'), false);
		assert.equal(store.get('filter', 'alice', 'one'), undefined);
		assert.deepEqual(store.get('marker', 'alice', 'one'), { value: 3 });
	} finally { store.close(); }
});

test('expired states and codes are unusable, operations are consumed once, transactions roll back', () => {
	const store = new CompatStore(':memory:');
	try {
		store.putOperation('state', 'a', { session: 'abc' }, 100);
		assert.deepEqual(store.takeOperation('state', 'a', 99), { session: 'abc' });
		assert.equal(store.takeOperation('state', 'a', 99), undefined);
		store.putOperation('state', 'b', { session: 'abc' }, 100);
		assert.equal(store.takeOperation('state', 'b', 100), undefined);
		const code = store.issueCode({ clientId: 'c', redirectUri: 'test://callback', scopes: ['read'], userId: 'u', nativeToken: 'app-token' }, 100);
		assert.equal(store.getCode(code, 100), undefined);
		assert.throws(() => store.transaction(() => { store.put('a', 'b', 'c', 4); throw new Error('failed'); }), /failed/u);
		assert.equal(store.get('a', 'b', 'c'), undefined);
		assert.equal(store.transaction(() => { store.put('a', 'b', 'c', 5); return 7; }), 7);
		assert.equal(store.get('a', 'b', 'c'), 5);
	} finally { store.close(); }
});

test('two connections cannot consume the same operation or read a revoked grant', t => {
	const directory = mkdtempSync(join(tmpdir(), 'mastodon-concurrent-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const filename = join(directory, 'compat.sqlite');
	const first = new CompatStore(filename);
	const second = new CompatStore(filename);
	try {
		first.putOperation('state', 'a', 'payload', 100);
		assert.equal(first.takeOperation('state', 'a', 1), 'payload');
		assert.equal(second.takeOperation('state', 'a', 1), undefined);
		const { client } = first.createClient({ name: 'App', redirectUris: ['app://callback'], scopes: ['read'] });
		const { token } = first.createGrant({ kind: 'app', clientId: client.id, scopes: ['read'] });
		assert.equal(second.getGrant(token)?.kind, 'app');
		assert.equal(second.revokeGrant(token, 'other-client'), false);
		assert.equal(first.getGrant(token)?.kind, 'app');
		assert.equal(second.revokeGrant(token, client.id), true);
		assert.equal(first.getGrant(token), undefined);
	} finally { first.close(); second.close(); }
});
