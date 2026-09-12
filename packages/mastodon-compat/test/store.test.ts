/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { CompatStore, hashCredential } from '../src/store.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	return { promise, resolve };
}

test('batch metadata reads preserve namespace and owner isolation without aliasing values', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	await store.put('status', 'alice', 'one', { language: 'ja' });
	await store.put('status', 'bob', 'one', { language: 'en' });
	await store.put('media', 'alice', 'one', { focus: { x: 0, y: 1 } });
	const keys = [
		{ namespace: 'status', owner: 'alice', key: 'one' },
		{ namespace: 'media', owner: 'alice', key: 'one' },
		{ namespace: 'status', owner: 'alice', key: 'missing' },
	];
	const entries = await store.getMany(keys);
	assert.equal(entries.length, 2);
	assert.ok(entries.every(entry => entry.owner === 'alice'));
	(entries[0].value as { language: string }).language = 'changed';
	assert.deepEqual(await store.get('status', 'alice', 'one'), { language: 'ja' });
	assert.deepEqual(await store.getMany([]), []);
});

test('credentials authenticate their client, grant and code and revoked tokens become unusable', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	const { client, clientSecret } = await store.createClient({ name: 'Test', scopes: ['read'], redirectUris: ['test://callback'] });
	const { token, grant } = await store.createGrant({ kind: 'user', clientId: client.id, scopes: ['read'], userId: 'user', nativeToken: 'native-app-credential' });
	const code = await store.issueCode({ clientId: client.id, redirectUri: 'test://callback', scopes: ['read'], userId: 'user', nativeToken: 'native-app-credential' }, Date.now() + 10000);
	assert.equal((await store.getGrant(token))?.nativeToken, 'native-app-credential');
	assert.equal((await store.verifyClient(client.id, clientSecret))?.id, client.id);
	assert.equal(await store.verifyClient(client.id, 'wrong'), undefined);
	assert.equal(grant.tokenHash, hashCredential(token));
	assert.deepEqual(await store.getGrant(token), grant);
	assert.equal(await store.getGrant('wrong'), undefined);
	assert.equal((await store.getCode(code))?.nativeToken, 'native-app-credential');
	assert.equal(await store.getCode('wrong'), undefined);
	assert.equal(await store.revokeGrant(token, 'other'), false);
	assert.ok(await store.getGrant(token));
	assert.equal(await store.revokeGrant(token, client.id), true);
	assert.equal(await store.getGrant(token), undefined);
});

test('metadata is isolated by namespace and owner, and stored values cannot be mutated through references', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	const input = { value: 1 };
	await store.put('filter', 'alice', 'one', input);
	input.value = 99;
	await store.put('filter', 'bob', 'one', { value: 2 });
	await store.put('marker', 'alice', 'one', { value: 3 });
	assert.deepEqual(await store.get('filter', 'alice', 'one'), { value: 1 });
	const received = (await store.get<{ value: number }>('filter', 'alice', 'one'))!;
	received.value = 100;
	assert.deepEqual(await store.get('filter', 'alice', 'one'), { value: 1 });
	await store.put('filter', 'alice', 'one', { value: 4 });
	assert.deepEqual(await store.list('filter', 'alice'), [{ key: 'one', value: { value: 4 } }]);
	assert.deepEqual(await store.get('filter', 'bob', 'one'), { value: 2 });
	assert.equal(await store.delete('filter', 'alice', 'one'), true);
	assert.equal(await store.delete('filter', 'alice', 'one'), false);
	assert.equal(await store.get('filter', 'alice', 'one'), undefined);
	assert.deepEqual(await store.get('marker', 'alice', 'one'), { value: 3 });
	await assert.rejects(store.put('filter', 'alice', 'bad', undefined), /JSON serializable/u);
	assert.equal(await store.get('filter', 'alice', 'bad'), undefined);
});

test('expired codes and operations are unusable and concurrent operation consumption occurs once', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	await store.putOperation('state', 'a', { session: 'abc' }, 100);
	const consumed = await Promise.all([store.takeOperation('state', 'a', 99), store.takeOperation('state', 'a', 99)]);
	assert.equal(consumed.filter(value => value !== undefined).length, 1);
	await store.putOperation('state', 'b', { session: 'abc' }, 100);
	assert.equal(await store.getOperation('state', 'b', 100), undefined);
	const code = await store.issueCode({ clientId: 'c', redirectUri: 'test://callback', scopes: ['read'], userId: 'u', nativeToken: 'app-token' }, 100);
	assert.equal(await store.getCode(code, 100), undefined);
	await store.prune(100);
	assert.equal(await store.deleteCode(code), false);
	assert.equal(await store.deleteOperation('state', 'b'), false);
});

test('awaited and nested transactions roll back together without leaking state or overwriting concurrent writes', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	const started = deferred();
	const finish = deferred();
	const transaction = store.transaction(async () => {
		await store.put('a', 'b', 'c', 4);
		await store.transaction(async () => { await store.put('a', 'b', 'nested', 5); });
		started.resolve();
		await finish.promise;
		throw new Error('failed');
	});
	await started.promise;
	let readFinished = false;
	const externalRead = store.get('a', 'b', 'c').then(value => { readFinished = true; return value; });
	const externalWrite = store.put('a', 'b', 'outside', 6);
	await setImmediate();
	assert.equal(readFinished, false);
	finish.resolve();
	await assert.rejects(transaction, /failed/u);
	assert.equal(await externalRead, undefined);
	await externalWrite;
	assert.equal(await store.get('a', 'b', 'nested'), undefined);
	assert.equal(await store.get('a', 'b', 'outside'), 6);
	assert.equal(await store.transaction(async () => { await store.put('a', 'b', 'c', 7); return 8; }), 8);
	assert.equal(await store.get('a', 'b', 'c'), 7);
});

test('a detached task cannot reuse a completed memory transaction', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	const released = deferred();
	let detached!: Promise<unknown>;
	await store.transaction(() => {
		detached = released.promise.then(() => store.put('a', 'b', 'c', 1));
	});
	released.resolve();
	await assert.rejects(detached, /transaction has ended/u);
	assert.equal(await store.get('a', 'b', 'c'), undefined);
});
