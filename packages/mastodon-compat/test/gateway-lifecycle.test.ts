/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { CompatStore, installGateway } from '../src/index.js';

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Gateway shutdown did not close its active streaming connections')), milliseconds);
		})]);
	} finally { clearTimeout(timer); }
}

test('gateway prunes on startup and periodically without OAuth traffic', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = new CompatStore(':memory:');
	const prunes = t.mock.method(store, 'prune');
	await store.putIdempotency('alice', 'startup', { digest: 'old', expiresAt: Date.now() - 1 });
	const app = Fastify();
	installGateway(app, { publicUrl: 'https://social.example', nativeUrl: 'https://native.example', store });
	t.after(() => app.close());
	await app.ready();
	assert.equal(await store.get('idempotency', 'alice', 'startup'), undefined);
	assert.equal(prunes.mock.callCount(), 1);
	await store.putIdempotency('alice', 'periodic', { digest: 'old', expiresAt: Date.now() - 1 });
	t.mock.timers.tick(60000);
	await setImmediate();
	assert.equal(await store.get('idempotency', 'alice', 'periodic'), undefined);
	assert.equal(prunes.mock.callCount(), 2);
	await app.close();
	t.mock.timers.tick(120000);
	await setImmediate();
	assert.equal(prunes.mock.callCount(), 2);
});

test('pruning retries after a storage error and shutdown waits for the active batch', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = new CompatStore(':memory:');
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	let calls = 0;
	t.mock.method(store, 'prune', async () => {
		if (++calls === 1) throw new Error('Storage temporarily unavailable');
		await pending;
	});
	const app = Fastify();
	installGateway(app, { publicUrl: 'https://social.example', nativeUrl: 'https://native.example', store });
	t.after(async () => { release(); await app.close(); });
	await app.ready();
	t.mock.timers.tick(60000);
	await setImmediate();
	assert.equal(calls, 2);
	let closed = false;
	const closing = app.close().then(() => { closed = true; });
	await setImmediate();
	assert.equal(closed, false);
	release();
	await closing;
	t.mock.timers.tick(120000);
	await setImmediate();
	assert.equal(calls, 2);
});

test('shutdown closes active client and native WebSockets before waiting for HTTP close', async t => {
	const upstream = createServer((request, response) => {
		request.resume();
		response.setHeader('content-type', 'application/json');
		if (request.url === '/api/i' && request.headers.authorization === 'Bearer native-alice') response.end(JSON.stringify({ id: 'alice' }));
		else { response.statusCode = 401; response.end('{}'); }
	});
	const nativeWss = new WebSocketServer({ server: upstream, path: '/streaming' });
	upstream.listen(0, '127.0.0.1');
	await once(upstream, 'listening');
	const store = new CompatStore(':memory:');
	const { client } = await store.createClient({ name: 'Shutdown regression', redirectUris: ['gateway-test://callback'], scopes: ['read'] });
	const { token } = await store.createGrant({ clientId: client.id, kind: 'user', userId: 'alice', nativeToken: 'native-alice', scopes: ['read'] });
	const gateway = Fastify();
	installGateway(gateway, { publicUrl: 'https://social.example', nativeUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, store });
	let clientSocket: WebSocket | undefined;
	t.after(async () => {
		clientSocket?.terminate();
		await gateway.close();
		for (const socket of nativeWss.clients) socket.terminate();
		await new Promise<void>(resolve => nativeWss.close(() => resolve()));
		upstream.closeAllConnections();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	});
	await gateway.listen({ host: '127.0.0.1', port: 0 });
	const nativeConnection = once(nativeWss, 'connection');
	clientSocket = new WebSocket(`ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/api/v1/streaming?access_token=${token}&stream=user`);
	clientSocket.on('error', () => undefined);
	await once(clientSocket, 'open');
	const [nativeSocket] = await nativeConnection as [WebSocket];
	assert.equal(clientSocket.readyState, WebSocket.OPEN);
	assert.equal(nativeSocket.readyState, WebSocket.OPEN);
	const clientClosed = once(clientSocket, 'close');
	const nativeClosed = once(nativeSocket, 'close');
	await within(Promise.all([gateway.close(), clientClosed, nativeClosed]), 2000);
	assert.equal(clientSocket.readyState, WebSocket.CLOSED);
	assert.equal(nativeSocket.readyState, WebSocket.CLOSED);
	assert.equal(gateway.server.listenerCount('upgrade'), 0);
});

test('gateway returns Mastodon 404 JSON on unknown /api/v1 and /api/v2 routes and RFC 6749 JSON on invalid multipart /oauth/token', async t => {
	const store = new CompatStore(':memory:');
	const app = Fastify();
	installGateway(app, { publicUrl: 'https://social.example', nativeUrl: 'https://native.example', store });
	app.post('/oauth/token', async () => ({ ok: true }));
	t.after(() => app.close());

	for (const url of ['/api/v1/unknown-endpoint', '/api/v2/unknown-endpoint']) {
		const res = await app.inject({ method: 'GET', url });
		assert.equal(res.statusCode, 404, res.body);
		assert.deepEqual(res.json(), { error: 'Record not found' });
	}

	const duplicateForm = new FormData();
	duplicateForm.append('grant_type', 'client_credentials');
	duplicateForm.append('grant_type', 'authorization_code');
	const dupReq = new Request('https://social.example/oauth/token', { method: 'POST', body: duplicateForm });
	const dupRes = await app.inject({
		method: 'POST',
		url: '/oauth/token',
		headers: { 'content-type': dupReq.headers.get('content-type')! },
		payload: Buffer.from(await dupReq.arrayBuffer()),
	});
	assert.equal(dupRes.statusCode, 400, dupRes.body);
	assert.equal(dupRes.headers['cache-control'], 'no-store');
	assert.equal(dupRes.json().error, 'invalid_request');

	const bigForm = new FormData();
	bigForm.append('grant_type', 'x'.repeat(70000));
	const bigReq = new Request('https://social.example/oauth/token', { method: 'POST', body: bigForm });
	const bigRes = await app.inject({
		method: 'POST',
		url: '/oauth/token',
		headers: { 'content-type': bigReq.headers.get('content-type')! },
		payload: Buffer.from(await bigReq.arrayBuffer()),
	});
	assert.equal(bigRes.statusCode, 413, bigRes.body);
	assert.equal(bigRes.headers['cache-control'], 'no-store');
	assert.equal(bigRes.json().error, 'invalid_request');
});

test('gateway decodes unindexed media_attributes[][...] in both urlencoded and multipart status edits', async t => {
	const store = new CompatStore(':memory:');
	const { client } = await store.createClient({ name: 'EditForm', redirectUris: ['app://cb'], scopes: ['read', 'write'] });
	const { token } = await store.createGrant({ clientId: client.id, kind: 'user', userId: 'alice', nativeToken: 'native-alice', scopes: ['read:statuses', 'write:statuses'] });
	const alice = { id: 'alice', username: 'alice', name: 'Alice', host: null, createdAt: '2026-01-01T00:00:00Z' };
	const file1 = { id: 'file-1', userId: 'alice', type: 'image/png', url: 'https://social.example/1.png', comment: 'Old 1' };
	const file2 = { id: 'file-2', userId: 'alice', type: 'image/png', url: 'https://social.example/2.png', comment: 'Old 2' };
	const statusNote = { id: 'note-1', userId: 'alice', user: alice, text: 'Initial', visibility: 'public', createdAt: '2026-01-01T00:00:00Z', files: [file1, file2], reactions: {} };
	const updates: Array<Record<string, unknown>> = [];
	const app = Fastify();
	installGateway(app, {
		publicUrl: 'https://social.example',
		nativeUrl: 'https://native.example',
		store,
		transport: async request => {
			const endpoint = new URL(request.url).pathname.slice(5);
			const body = JSON.parse(String(request.body));
			if (endpoint === 'ping') return { status: 200, body: '{"pong":1}' };
			if (endpoint === 'notes/show') return { status: 200, body: JSON.stringify(statusNote) };
			if (endpoint === 'notes/state') return { status: 200, body: JSON.stringify({ isFavorited: false, isMutedThread: false, myRenoteId: null }) };
			if (endpoint === 'users/show') return { status: 200, body: JSON.stringify(Array.isArray(body.userIds) ? [{ ...alice, pinnedNoteIds: [] }] : { ...alice, pinnedNoteIds: [] }) };
			if (endpoint === 'notes/update') {
				updates.push(body);
				if (Array.isArray(body.fileComments)) {
					for (const fc of body.fileComments) {
						if (fc.fileId === 'file-1') file1.comment = fc.comment;
						if (fc.fileId === 'file-2') file2.comment = fc.comment;
					}
				}
				return { status: 200, body: JSON.stringify({ updatedNote: statusNote }) };
			}
			return { status: 404, body: '{}' };
		},
	});
	t.after(() => app.close());

	const formRes = await app.inject({
		method: 'PUT',
		url: '/api/v1/statuses/note-1',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
		payload: 'status=Edited&media_ids[]=file-1&media_ids[]=file-2&media_attributes[][id]=file-1&media_attributes[][description]=Alt+One&media_attributes[][id]=file-2&media_attributes[][focus]=0.2,-0.3',
	});
	assert.equal(formRes.statusCode, 200, formRes.body);
	assert.deepEqual(updates[0].fileComments, [{ fileId: 'file-1', comment: 'Alt One' }]);
	assert.equal(formRes.json().media_attachments[0].description, 'Alt One');
	assert.deepEqual(formRes.json().media_attachments[1].meta.focus, { x: 0.2, y: -0.3 });

	const multi = new FormData();
	multi.append('status', 'Edited Multipart');
	multi.append('media_ids[]', 'file-1');
	multi.append('media_ids[]', 'file-2');
	multi.append('media_attributes[][id]', 'file-1');
	multi.append('media_attributes[][description]', 'Multi One');
	multi.append('media_attributes[][id]', 'file-2');
	multi.append('media_attributes[][description]', 'Multi Two');
	const multiReq = new Request('https://social.example/api/v1/statuses/note-1', { method: 'PUT', body: multi });
	const multiRes = await app.inject({
		method: 'PUT',
		url: '/api/v1/statuses/note-1',
		headers: { authorization: `Bearer ${token}`, 'content-type': multiReq.headers.get('content-type')! },
		payload: Buffer.from(await multiReq.arrayBuffer()),
	});
	assert.equal(multiRes.statusCode, 200, multiRes.body);
	assert.deepEqual(updates[1].fileComments, [
		{ fileId: 'file-1', comment: 'Multi One' },
		{ fileId: 'file-2', comment: 'Multi Two' },
	]);
});
