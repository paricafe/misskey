/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { CompatStore, createGateway, installGateway } from '../src/index.js';
import type { Json, NativeTransport } from '../src/types.js';

for (const embedded of [false, true]) for (const unix of [false, true]) {
	test(`${embedded ? 'embedded' : 'standalone'} user streaming preserves native authentication and URLs over ${unix ? 'Unix sockets' : 'TCP'}`, { timeout: 5000 }, async t => {
		const nativeToken = 'native+alice/=?%:token';
		const publicUrl = 'https://social.example';
		const author = { id: 'bob', username: 'bob', host: null, createdAt: '2026-09-01T00:00:00.000Z', pinnedNoteIds: [] };
		const note = { id: 'first', user: author, userId: author.id, createdAt: '2026-09-11T00:00:00.000Z', text: 'Fresh native content', visibility: 'public', files: [], reactions: {} };
		const calls: Array<{ url: string; authorization?: string; body: Json }> = [];
		const upgrades: Array<{ url: string; host?: string }> = [];
		const upstream = createServer((request, response) => {
			void (async () => {
				let raw = '';
				for await (const chunk of request) raw += chunk.toString();
				const body: Json = JSON.parse(raw);
				calls.push({ url: request.url!, authorization: request.headers.authorization, body });
				response.setHeader('content-type', 'application/json');
				if (request.headers.authorization !== `Bearer ${nativeToken}`) { response.statusCode = 401; response.end('{}'); return; }
				if (request.url === '/api/i') response.end(JSON.stringify({ id: 'alice' }));
				else if (request.url === '/api/notes/show') response.end(JSON.stringify(note));
				else if (request.url === '/api/notes/state') response.end(JSON.stringify({ isFavorited: false, isMutedThread: false }));
				else if (request.url === '/api/users/show') response.end(JSON.stringify(Array.isArray(body.userIds) ? [author] : author));
				else { response.statusCode = 404; response.end('{}'); }
			})().catch(() => { response.statusCode = 500; response.end('{}'); });
		});
		const nativeWss = new WebSocketServer({ server: upstream, path: '/streaming' });
		nativeWss.on('connection', (socket, request) => {
			upgrades.push({ url: request.url!, host: request.headers.host });
			socket.on('message', data => {
				const command: Json = JSON.parse(data.toString());
				if (command.type === 'connect' && command.body.channel === 'homeTimeline') {
					socket.send(JSON.stringify({ type: 'channel', body: { id: command.body.id, type: 'note', body: { id: note.id, text: 'Stale event content' } } }));
				}
			});
		});
		let directory: string | undefined;
		let gateway: FastifyInstance | undefined;
		let clientSocket: WebSocket | undefined;
		t.after(async () => {
			clientSocket?.terminate();
			await gateway?.close();
			for (const socket of nativeWss.clients) socket.terminate();
			await new Promise<void>(resolve => nativeWss.close(() => resolve()));
			upstream.closeAllConnections();
			await new Promise<void>(resolve => upstream.close(() => resolve()));
			if (directory) await rm(directory, { recursive: true, force: true });
		});
		let nativeSocketPath: string | undefined;
		let transport: NativeTransport | undefined;
		if (unix) {
			// Keep macOS socket paths short and cover characters that cannot be safely embedded in ws+unix URLs.
			directory = await mkdtemp('/tmp/mastodon-streaming-');
			nativeSocketPath = join(directory, 'native:%socket.sock');
			upstream.listen(nativeSocketPath);
			transport = input => new Promise((resolve, reject) => {
				const outgoing = httpRequest(input.url, { socketPath: nativeSocketPath, method: input.method, headers: input.headers, signal: input.context?.signal }, response => {
					const chunks: Buffer[] = [];
					response.on('data', chunk => chunks.push(Buffer.from(chunk)));
					response.on('error', reject);
					response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) }));
				});
				outgoing.on('error', reject);
				outgoing.end(input.body);
			});
		} else upstream.listen(0, '127.0.0.1');
		await once(upstream, 'listening');
		// No upstream TCP listener exists in the Unix case; the HTTP URL still determines the handshake Host and path.
		const nativeUrl = unix ? 'http://127.0.0.1:1' : `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
		if (unix) assert.equal(upstream.address(), nativeSocketPath);
		const store = new CompatStore(':memory:');
		const { client } = await store.createClient({ name: 'Streaming transport', redirectUris: ['https://client.example/callback'], scopes: ['read'] });
		const { token } = await store.createGrant({ clientId: client.id, kind: 'user', userId: 'alice', nativeToken, scopes: ['read'] });
		const options = { publicUrl, nativeUrl, nativeSocketPath, transport, store };
		gateway = embedded ? Fastify() : await createGateway(options);
		if (embedded) installGateway(gateway, options);
		await gateway.listen({ host: '127.0.0.1', port: 0 });
		const url = new URL(`ws://127.0.0.1:${(gateway.server.address() as AddressInfo).port}/api/v1/streaming`);
		url.searchParams.set('access_token', token);
		url.searchParams.set('stream', 'user');
		clientSocket = new WebSocket(url);
		const received = once(clientSocket, 'message');
		const [, [data]] = await Promise.all([once(clientSocket, 'open'), received]);
		const frame: Json = JSON.parse(data.toString());
		assert.deepEqual(frame.stream, ['user']);
		assert.equal(frame.event, 'update');
		assert.equal(JSON.parse(frame.payload).content, '<p>Fresh native content</p>');
		assert.deepEqual(upgrades, [{ url: `/streaming?${new URLSearchParams({ i: nativeToken })}`, host: new URL(nativeUrl).host }]);
		assert.ok(calls.some(call => call.url === '/api/i'));
		assert.ok(calls.some(call => call.url === '/api/notes/show'));
		assert.ok(calls.every(call => call.authorization === `Bearer ${nativeToken}` && !Object.hasOwn(call.body, 'i')));
	});
}
