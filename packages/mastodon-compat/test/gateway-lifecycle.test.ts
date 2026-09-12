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
import { CompatStore, createGateway, installGateway } from '../src/index.js';

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Gateway shutdown did not close its active streaming connections')), milliseconds);
		})]);
	} finally { clearTimeout(timer); }
}

for (const embedded of [false, true]) test(`${embedded ? 'embedded' : 'standalone'} gateway prunes on startup and periodically without OAuth traffic`, async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const store = new CompatStore(':memory:');
	const prunes = t.mock.method(store, 'prune');
	const options = { publicUrl: 'https://social.example', nativeUrl: 'https://native.example', store };
	await store.put('idempotency', 'alice', 'startup', { digest: 'old', expiresAt: Date.now() - 1 });
	const app = embedded ? Fastify() : await createGateway(options);
	if (embedded) installGateway(app, options);
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
	const app = await createGateway({ publicUrl: 'https://social.example', nativeUrl: 'https://native.example', store });
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

test('standalone shutdown closes active client and native WebSockets before waiting for HTTP close', async t => {
	const upstream = createServer((request, response) => {
		request.resume();
		response.setHeader('content-type', 'application/json');
		if (request.url?.startsWith('/api/miauth/')) response.end(JSON.stringify({ ok: true, token: 'native-alice', user: { id: 'alice' } }));
		else if (request.url === '/api/i' && request.headers.authorization === 'Bearer native-alice') response.end(JSON.stringify({ id: 'alice' }));
		else { response.statusCode = 401; response.end('{}'); }
	});
	const nativeWss = new WebSocketServer({ server: upstream, path: '/streaming' });
	upstream.listen(0, '127.0.0.1');
	await once(upstream, 'listening');
	const gateway = await createGateway({ publicUrl: 'https://social.example', nativeUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, store: new CompatStore(':memory:') });
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
	const registered = await gateway.inject({ method: 'POST', url: '/api/v1/apps', payload: { client_name: 'Shutdown regression', redirect_uris: 'gateway-test://callback', scopes: 'read' } });
	assert.equal(registered.statusCode, 200);
	const client = registered.json();
	const authorize = await gateway.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: 'gateway-test://callback', response_type: 'code', scope: 'read' })}` });
	assert.equal(authorize.statusCode, 302);
	const callback = new URL(new URL(String(authorize.headers.location)).searchParams.get('callback')!);
	const accepted = await gateway.inject({ method: 'GET', url: callback.pathname + callback.search });
	assert.equal(accepted.statusCode, 302);
	const code = new URL(String(accepted.headers.location)).searchParams.get('code');
	const exchange = await gateway.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'authorization_code', client_id: client.client_id, client_secret: client.client_secret, redirect_uri: 'gateway-test://callback', code } });
	assert.equal(exchange.statusCode, 200);
	const nativeConnection = once(nativeWss, 'connection');
	clientSocket = new WebSocket(`ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/api/v1/streaming?access_token=${exchange.json().access_token}&stream=user`);
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
