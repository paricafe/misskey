/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { NativeClient, NativeError } from '../src/native-client.js';
import type { Json, NativeTransportRequest } from '../src/types.js';

async function server(t: TestContext, handler: RequestListener): Promise<string> {
	const instance = createServer(handler);
	await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		instance.closeAllConnections();
		await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
	});
	return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}

test('uses a real HTTP request with the native credential while preserving string IDs', async t => {
	let captured: Json = {};
	const baseUrl = await server(t, async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		captured = { url: request.url, method: request.method, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ id: '9zzzzzzzzzzzzzzzzzzzzzzzz', userId: '18446744073709551617' }));
	});
	const client = new NativeClient({ baseUrl, publicUrl: 'https://social.example' });
	const result = await client.call<Json>('notes/show', { noteId: '9zzzzzzzzzzzzzzzzzzzzzzzz', i: 'injected-token' }, 'native-token', { ip: '203.0.113.9', userAgent: 'A public client' });
	assert.equal(result.userId, '18446744073709551617');
	assert.equal(captured.method, 'POST');
	assert.equal(captured.url, '/api/notes/show');
	assert.equal(captured.headers.authorization, 'Bearer native-token');
	assert.equal(captured.headers['user-agent'], 'A public client');
	assert.equal(captured.headers['x-forwarded-for'], undefined);
	assert.deepEqual(captured.body, { noteId: '9zzzzzzzzzzzzzzzzzzzzzzzz' });
});

test('lets a host transport preserve trusted IP and cancellation context', async () => {
	let captured: NativeTransportRequest | undefined;
	const controller = new AbortController();
	const context = { ip: '203.0.113.9', userAgent: 'Client', signal: controller.signal };
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async request => {
		captured = request;
		return { status: 200, body: new TextEncoder().encode('{"name":"Native"}') };
	} });
	assert.deepEqual(await client.call('meta', {}, undefined, context), { name: 'Native' });
	assert.equal(captured?.context, context);
	assert.equal(captured?.headers.authorization, undefined);
});

test('encodes real multipart bytes and prevents fields from replacing file or authentication', async () => {
	let uploaded: FormData | undefined;
	let captured: NativeTransportRequest | undefined;
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async request => {
		captured = request;
		uploaded = await new Request(request.url, { method: request.method, headers: request.headers, body: Buffer.from(request.body) }).formData();
		return { status: 200, body: '{"id":"file-opaque"}' };
	} });
	const bytes = new Uint8Array([0, 255, 13, 10, 34, 99]);
	assert.deepEqual(await client.upload(new Blob([bytes], { type: 'image/png' }), 'picture.png', { i: 'bad-token', file: 'bad-file', force: true, comment: 'alt text', undefined: undefined }, 'native-token'), { id: 'file-opaque' });
	assert.equal(captured?.url, 'http://native.test/api/drive/files/create');
	assert.equal(captured?.headers.authorization, 'Bearer native-token');
	assert.equal(uploaded?.get('i'), null);
	assert.equal(uploaded?.get('force'), 'true');
	assert.equal(uploaded?.get('comment'), 'alt text');
	assert.equal(uploaded?.get('undefined'), null);
	const file = uploaded?.get('file') as File;
	assert.equal(file.name, 'picture.png');
	assert.equal(file.type, 'image/png');
	assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
});

test('preserves native error codes and rate limit headers', async () => {
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async () => ({
		status: 429,
		body: JSON.stringify({ error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Please wait' } }),
		headers: { 'retry-after': '3' },
	}) });
	await assert.rejects(client.call('notes/create', { text: 'hello' }, 'native-token'), error => {
		assert.ok(error instanceof NativeError);
		assert.equal(error.status, 429);
		assert.equal(error.code, 'RATE_LIMIT_EXCEEDED');
		assert.equal(error.message, 'Please wait');
		assert.equal(error.headers['retry-after'], '3');
		return true;
	});
});

test('does not retry a write when the connection closes after the server receives it', async t => {
	let mutations = 0;
	const baseUrl = await server(t, async (request, response) => {
		for await (const _chunk of request) { /* Consume the complete write request. */ }
		mutations += 1;
		response.destroy();
	});
	const client = new NativeClient({ baseUrl, publicUrl: 'https://social.example' });
	await assert.rejects(client.call('notes/create', { text: 'hello' }, 'native-token'), { code: 'NATIVE_CONNECTION_FAILED', status: 502 });
	assert.equal(mutations, 1);
});

test('never forwards a credential through an upstream redirect', async t => {
	let destinationRequests = 0;
	const destination = await server(t, (_request, response) => {
		destinationRequests += 1;
		response.end('{}');
	});
	const baseUrl = await server(t, (_request, response) => {
		response.writeHead(307, { location: `${destination}/unexpected` });
		response.end();
	});
	const client = new NativeClient({ baseUrl, publicUrl: 'https://social.example' });
	await assert.rejects(client.call('i', {}, 'native-token'), { status: 307, code: 'NATIVE_HTTP_ERROR' });
	assert.equal(destinationRequests, 0);
});

test('does not send a request when the caller has already cancelled', async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort();
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async () => {
		calls += 1;
		return { status: 204, body: '' };
	} });
	await assert.rejects(client.call('notes/create', {}, 'native-token', { signal: controller.signal }), { status: 499, code: 'REQUEST_ABORTED' });
	assert.equal(calls, 0);
});

test('supports successful native endpoints with no response body', async () => {
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async () => ({ status: 204, body: '' }) });
	assert.equal(await client.call('notes/delete', { noteId: 'opaque' }, 'native-token'), undefined);
});

test('reports malformed success responses without exposing raw HTML', async () => {
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async () => ({ status: 200, body: '<html>internal diagnostics</html>' }) });
	await assert.rejects(client.call('i', {}, 'native-token'), { status: 502, code: 'INVALID_NATIVE_RESPONSE', message: 'The native API returned an invalid JSON response' });
});

test('rejects path traversal and absolute endpoints before contacting a transport', async () => {
	let calls = 0;
	const client = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.example', transport: async () => {
		calls += 1;
		return { status: 200, body: '{}' };
	} });
	for (const endpoint of ['../admin', 'notes/show?i=secret', '//other.test', 'https://other.test', 'notes/%2e%2e/i']) {
		await assert.rejects(client.call(endpoint, {}), TypeError);
	}
	assert.equal(calls, 0);
});

test('builds native websocket URLs without altering opaque credentials', () => {
	const client = new NativeClient({ baseUrl: 'https://native.example', publicUrl: 'https://social.example' });
	const url = new URL(client.socketUrl('opaque+token/=?'));
	assert.equal(url.origin, 'wss://native.example');
	assert.equal(url.pathname, '/streaming');
	assert.equal(url.searchParams.get('i'), 'opaque+token/=?');
	assert.equal(new URL(client.socketUrl()).search, '');
});
