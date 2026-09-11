/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { EntityConverter } from '../src/entities.js';
import { NativeClient } from '../src/native-client.js';
import { CompatStore } from '../src/store.js';
import { attachStreaming } from '../src/streaming.js';
import type { Json } from '../src/types.js';

class Inbox {
	readonly received: Json[] = [];
	private readonly pending: Json[] = [];
	private readonly listeners = new Set<() => void>();

	constructor(socket: WebSocket) {
		socket.on('message', data => {
			const message: Json = JSON.parse(data.toString());
			this.received.push(message);
			this.pending.push(message);
			for (const listener of this.listeners) listener();
		});
	}

	take(predicate: (message: Json) => boolean, timeout = 2000): Promise<Json> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error(`No matching WebSocket frame: ${JSON.stringify(this.received)}`)); }, timeout);
			const check = () => {
				const index = this.pending.findIndex(predicate);
				if (index < 0) return;
				clearTimeout(timer);
				this.listeners.delete(check);
				resolve(this.pending.splice(index, 1)[0]!);
			};
			this.listeners.add(check);
			check();
		});
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}

const alice = { id: 'alice', username: 'alice', name: 'Alice', host: null, createdAt: '2026-09-01T00:00:00.000Z' };
const bob = { id: 'bob', username: 'bob', name: 'Bob', host: null, createdAt: '2026-09-01T00:00:00.000Z' };

function note(id: string, overrides: Json = {}): Json {
	return {
		id, user: bob, userId: bob.id, createdAt: '2026-09-11T00:00:00.000Z', text: `Native ${id}`,
		visibility: 'public', cw: null, fileIds: [], files: [], tags: [], reactions: {}, renote: null,
		...overrides,
	};
}

type NativeSession = {
	socket: WebSocket;
	commands: Inbox;
	channels: Map<string, { name: string; params: Json }>;
};

async function fixture() {
	const store = new CompatStore(':memory:');
	const { client } = store.createClient({ name: 'Streaming test', redirectUris: ['https://client.example/callback'], scopes: ['read', 'write'] });
	const grant = (scopes = ['read'], userId = alice.id, nativeToken = 'native-alice') => store.createGrant({ clientId: client.id, kind: 'user', userId, nativeToken, scopes });
	const { token } = grant();
	const notes = new Map<string, Json>();
	const states = new Map<string, { isFavorited: boolean; isMutedThread: boolean }>();
	const users = new Map<string, Json>([[alice.id, { ...alice, pinnedNoteIds: [] }], [bob.id, { ...bob, pinnedNoteIds: [] }]]);
	const calls: Array<{ endpoint: string; body: Json; authorization?: string }> = [];
	const nativeSessions: NativeSession[] = [];
	let validNativeToken = true;
	let beforeCall: ((endpoint: string, body: Json) => Promise<void>) | undefined;
	const nativeServer = createServer((request, response) => {
		void (async () => {
			let raw = '';
			for await (const chunk of request) raw += chunk.toString();
			const body: Json = raw ? JSON.parse(raw) : {};
			const endpoint = new URL(request.url!, 'http://native.test').pathname.slice('/api/'.length);
			calls.push({ endpoint, body, authorization: request.headers.authorization });
			if (beforeCall) await beforeCall(endpoint, body);
			response.setHeader('content-type', 'application/json');
			if (!validNativeToken || request.headers.authorization !== 'Bearer native-alice') {
				response.statusCode = 401;
				response.end(JSON.stringify({ error: { code: 'AUTHENTICATION_FAILED', message: 'Invalid credential' } }));
				return;
			}
			let result: unknown;
			if (endpoint === 'i') result = alice;
			else if (endpoint === 'notes/show') result = notes.get(body.noteId);
			else if (endpoint === 'notes/state') result = notes.has(body.noteId) ? states.get(body.noteId) ?? { isFavorited: false, isMutedThread: false } : undefined;
			else if (endpoint === 'users/lists/show') result = body.listId === 'foreign' ? undefined : { id: body.listId, userId: alice.id };
			else if (endpoint === 'users/show') result = Array.isArray(body.userIds) ? [...users.values()].filter(user => body.userIds.includes(user.id)) : users.get(body.userId);
			else if (endpoint === 'notes/conversation') {
				const ancestors: Json[] = [];
				let current = notes.get(body.noteId);
				while (current?.replyId && ancestors.length < 100) {
					current = notes.get(current.replyId);
					if (current) ancestors.push(current);
				}
				result = ancestors;
			} else if (endpoint === 'notes/mentions' || endpoint === 'users/notes') result = [...notes.values()].filter(value => value.visibility === 'specified' && (!body.untilId || value.id < body.untilId)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, body.limit ?? 100);
			if (result == null) {
				response.statusCode = 404;
				response.end(JSON.stringify({ error: { code: endpoint === 'notes/show' ? 'NO_SUCH_NOTE' : 'NO_SUCH_LIST', message: 'Not found' } }));
			} else response.end(JSON.stringify(result));
		})().catch(() => { response.statusCode = 500; response.end('{}'); });
	});
	const nativeWss = new WebSocketServer({ server: nativeServer, path: '/streaming' });
	nativeWss.on('connection', (socket, request) => {
		assert.equal(new URL(request.url!, 'http://native.test').searchParams.get('i'), 'native-alice');
		const session: NativeSession = { socket, commands: new Inbox(socket), channels: new Map() };
		nativeSessions.push(session);
		socket.on('message', data => {
			const frame: Json = JSON.parse(data.toString());
			if (frame.type === 'connect') {
				session.channels.set(frame.body.id, { name: frame.body.channel, params: frame.body.params });
				socket.send(JSON.stringify({ type: 'connected', body: { id: frame.body.id } }));
			} else if (frame.type === 'disconnect') session.channels.delete(frame.body.id);
		});
	});
	nativeServer.listen(0, '127.0.0.1');
	await once(nativeServer, 'listening');
	const nativeUrl = `http://127.0.0.1:${(nativeServer.address() as AddressInfo).port}`;
	const gateway = createServer((_request, response) => { response.statusCode = 404; response.end(); });
	const bridge = attachStreaming(gateway, { native: new NativeClient({ baseUrl: nativeUrl, publicUrl: 'https://social.example' }), entities: new EntityConverter('https://social.example'), store, publicUrl: 'https://social.example' });
	gateway.listen(0, '127.0.0.1');
	await once(gateway, 'listening');
	const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}/api/v1/streaming`;
	const clients: WebSocket[] = [];
	const connect = async (query: Json = {}, credential = token, header = false) => {
		const url = new URL(gatewayUrl);
		if (!header) url.searchParams.set('access_token', credential);
		for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
		const socket = new WebSocket(url, header ? { headers: { authorization: `Bearer ${credential}` } } : {});
		clients.push(socket);
		const messages = new Inbox(socket);
		await once(socket, 'open');
		return { socket, messages, native: nativeSessions.at(-1)! };
	};
	const failedUpgrade = async (query: Json = {}, credential?: string, authorization?: string) => {
		const url = new URL(gatewayUrl);
		if (credential != null) url.searchParams.set('access_token', credential);
		for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
		const socket = new WebSocket(url, { headers: authorization ? { authorization } : {} });
		clients.push(socket);
		socket.on('error', () => undefined);
		return await new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Expected a rejected upgrade')), 2000);
			socket.once('unexpected-response', (_request, response) => {
				clearTimeout(timeout);
				response.resume();
				socket.terminate();
				resolve(response.statusCode!);
			});
			socket.once('open', () => { clearTimeout(timeout); reject(new Error('Unexpected successful upgrade')); });
		});
	};
	return {
		store, client, token, grant, notes, states, users, calls, connect, failedUpgrade, gateway, gatewayUrl, bridge,
		setBeforeCall(callback: typeof beforeCall) { beforeCall = callback; },
		revokeNative() { validNativeToken = false; },
		async close() {
			for (const socket of clients) socket.terminate();
			await bridge.close();
			await new Promise<void>(resolve => gateway.close(() => resolve()));
			for (const socket of nativeWss.clients) socket.terminate();
			await new Promise<void>(resolve => nativeWss.close(() => resolve()));
			nativeServer.closeAllConnections();
			await new Promise<void>(resolve => nativeServer.close(() => resolve()));
			store.close();
		},
	};
}

async function channel(session: NativeSession, name: string, matches: (params: Json) => boolean = () => true): Promise<string> {
	const frame = await session.commands.take(message => message.type === 'connect' && message.body.channel === name && matches(message.body.params));
	return frame.body.id;
}

function emit(session: NativeSession, channelId: string, type: string, body: Json): void {
	session.socket.send(JSON.stringify({ type: 'channel', body: { id: channelId, type, body } }));
}

function change(session: NativeSession, id: string, type: 'updated' | 'deleted'): void {
	session.socket.send(JSON.stringify({ type: 'noteUpdated', body: { id, type, body: { text: 'An untrusted stale event body' } } }));
}

test('rejects missing, app, mismatched, revoked, and insufficiently scoped grants before upgrading', async t => {
	const f = await fixture();
	t.after(() => f.close());
	assert.equal(await f.failedUpgrade(), 401);
	assert.equal(await f.failedUpgrade({}, 'unknown-token'), 401);
	const app = f.store.createGrant({ clientId: f.client.id, kind: 'app', scopes: ['read'] });
	assert.equal(await f.failedUpgrade({}, app.token), 401);
	assert.equal(await f.failedUpgrade({}, f.grant(['write']).token), 403);
	assert.equal(await f.failedUpgrade({}, f.grant(['read'], bob.id).token), 401);
	assert.equal(await f.failedUpgrade({}, f.token, 'Basic unsupported'), 401);
	assert.equal(await f.failedUpgrade({}, f.token, 'Bearer other-token'), 401);
	assert.equal(await f.failedUpgrade({ stream: 'unknown' }, f.token), 400);
	assert.equal(await f.failedUpgrade({ stream: 'hashtag' }, f.token), 400);
	assert.equal(await f.failedUpgrade({ stream: 'list', list: 'foreign' }, f.token), 404);
	f.revokeNative();
	assert.equal(await f.failedUpgrade({}, f.token), 401);
});

test('uses the native user token over real HTTP and WebSocket and emits fresh status entities', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'user' }, f.token, true);
	const home = await channel(c.native, 'homeTimeline');
	f.notes.set('first', note('first', { text: 'Fresh native content' }));
	emit(c.native, home, 'note', note('first', { text: 'Stale streaming content' }));
	const received = await c.messages.take(message => message.event === 'update');
	assert.deepEqual(received.stream, ['user']);
	assert.equal(typeof received.payload, 'string');
	assert.equal(JSON.parse(received.payload).content, '<p>Fresh native content</p>');
	assert.ok(f.calls.every(call => call.authorization === 'Bearer native-alice'));
	assert.ok(f.calls.every(call => !Object.hasOwn(call.body, 'i')));
	await c.native.commands.take(message => message.type === 'subNote' && message.body.id === 'first');
});

test('shares compatibility metadata and context filters with REST and signals filter revisions', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'user' });
	const home = await channel(c.native, 'homeTimeline');
	const main = await channel(c.native, 'main');
	f.store.put('status', bob.id, 'filtered', { language: 'ja', sensitive: true });
	f.store.put('bookmark', alice.id, 'filtered', true);
	f.store.put('thread-mute', alice.id, 'filtered', false);
	f.store.put('pin', alice.id, 'filtered', false);
	f.store.put('reblog', alice.id, 'filtered', 'deleted-boost');
	f.states.set('filtered', { isFavorited: false, isMutedThread: true });
	f.users.get(bob.id)!.pinnedNoteIds = ['filtered'];
	f.store.put('filter', alice.id, 'home-filter', { id: 'home-filter', title: 'Home rule', context: ['home'], expires_at: null, filter_action: 'warn', keywords: [{ id: 'keyword', keyword: 'Native', whole_word: true }], statuses: [] });
	f.store.put('filter-revision', alice.id, 'current', 'updated');
	f.notes.set('filtered', note('filtered'));
	emit(c.native, home, 'note', { id: 'filtered' });
	const revision = await c.messages.take(message => message.event === 'filters_changed');
	assert.deepEqual(revision, { stream: ['user'], event: 'filters_changed' });
	const status = JSON.parse((await c.messages.take(message => message.event === 'update')).payload);
	assert.equal(status.language, 'ja');
	assert.equal(status.sensitive, true);
	assert.equal(status.bookmarked, false);
	assert.equal(status.muted, true);
	assert.equal(status.pinned, true);
	assert.equal(status.reblogged, undefined);
	assert.equal(f.store.get('reblog', alice.id, 'filtered'), undefined);
	assert.deepEqual(status.filtered.map((match: Json) => match.filter.id), ['home-filter']);
	f.states.set('filtered', { isFavorited: true, isMutedThread: false });
	f.users.get(bob.id)!.pinnedNoteIds = [];
	emit(c.native, main, 'notification', { id: 'mention-filtered', type: 'mention', user: bob, note: { id: 'filtered' }, createdAt: '2026-09-11T00:00:00.000Z' });
	const notification = JSON.parse((await c.messages.take(message => message.event === 'notification')).payload);
	assert.equal(notification.status.language, 'ja');
	assert.equal(notification.status.bookmarked, true);
	assert.equal(notification.status.muted, false);
	assert.equal(notification.status.pinned, false);
	assert.deepEqual(notification.status.filtered, []);
	assert.equal(c.messages.received.filter(message => message.event === 'filters_changed').length, 1);
});

test('keeps notification-only grants scoped when subscribing and receiving native events', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const token = f.grant(['read:notifications']).token;
	const c = await f.connect({ stream: 'user' }, token);
	const main = await channel(c.native, 'main');
	c.socket.send(JSON.stringify({ type: 'subscribe', stream: 'public' }));
	assert.equal((await c.messages.take(message => message.status === 403)).status, 403);
	f.notes.set('private', note('private'));
	emit(c.native, main, 'mention', note('private'));
	emit(c.native, main, 'notification', { id: 'follow-notification', type: 'follow', user: bob, createdAt: '2026-09-11T00:00:00.000Z' });
	const received = await c.messages.take(message => message.event === 'notification');
	assert.deepEqual(received.stream, ['user']);
	assert.equal(JSON.parse(received.payload).type, 'follow');
	assert.equal(c.messages.received.filter(message => message.event === 'update').length, 0);
	assert.equal([...c.native.channels.values()].some(value => value.name === 'homeTimeline'), false);
});

test('preserves full hashtag and list identities while sharing native public channels safely', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect();
	for (const target of [{ stream: 'hashtag', tag: 'foo' }, { stream: 'hashtag', tag: 'bar' }, { stream: 'list', list: 'list-one' }, { stream: 'public' }, { stream: 'public:remote' }]) {
		c.socket.send(JSON.stringify({ type: 'subscribe', ...target }));
	}
	const foo = await channel(c.native, 'hashtag', params => params.q[0][0] === 'foo');
	const bar = await channel(c.native, 'hashtag', params => params.q[0][0] === 'bar');
	const list = await channel(c.native, 'userList');
	const global = await channel(c.native, 'globalTimeline');
	f.notes.set('tag-foo', note('tag-foo', { tags: ['foo'] }));
	f.notes.set('tag-bar', note('tag-bar', { tags: ['bar'] }));
	f.notes.set('list-note', note('list-note'));
	emit(c.native, foo, 'note', { id: 'tag-foo' });
	emit(c.native, bar, 'note', { id: 'tag-bar' });
	emit(c.native, list, 'note', { id: 'list-note' });
	assert.deepEqual((await c.messages.take(message => JSON.parse(message.payload ?? '{}').id === 'tag-foo')).stream, ['hashtag', 'foo']);
	assert.deepEqual((await c.messages.take(message => JSON.parse(message.payload ?? '{}').id === 'tag-bar')).stream, ['hashtag', 'bar']);
	assert.deepEqual((await c.messages.take(message => JSON.parse(message.payload ?? '{}').id === 'list-note')).stream, ['list', 'list-one']);
	c.socket.send(JSON.stringify({ type: 'unsubscribe', stream: 'public' }));
	c.socket.send(JSON.stringify({ type: 'subscribe', stream: 'hashtag', tag: 'barrier' }));
	await channel(c.native, 'hashtag', params => params.q[0][0] === 'barrier');
	f.notes.set('remote', note('remote', { user: { ...bob, host: 'remote.example' } }));
	emit(c.native, global, 'note', { id: 'remote' });
	assert.deepEqual((await c.messages.take(message => JSON.parse(message.payload ?? '{}').id === 'remote')).stream, ['public:remote']);
	assert.equal(c.messages.received.some(message => message.stream?.[0] === 'public'), false);
	c.socket.send(JSON.stringify({ type: 'unsubscribe', stream: 'public:remote' }));
	await c.native.commands.take(message => message.type === 'disconnect' && message.body.id === global);
});

test('reloads edited notes, sends deletes only for delivered IDs, and suppresses hidden notifications', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'user' });
	const home = await channel(c.native, 'homeTimeline');
	const main = await channel(c.native, 'main');
	f.notes.set('editable', note('editable'));
	emit(c.native, home, 'note', { id: 'editable' });
	await c.messages.take(message => message.event === 'update');
	f.notes.set('editable', note('editable', { text: 'Edited content', updatedAt: '2026-09-11T00:01:00.000Z' }));
	change(c.native, 'editable', 'updated');
	const edited = await c.messages.take(message => message.event === 'status.update');
	assert.equal(JSON.parse(edited.payload).content, '<p>Edited content</p>');
	f.notes.set('editable', note('editable', { isHidden: true, text: 'Secret' }));
	change(c.native, 'editable', 'updated');
	assert.equal((await c.messages.take(message => message.event === 'delete')).payload, 'editable');
	change(c.native, 'never-delivered', 'deleted');
	emit(c.native, main, 'notification', { id: 'hidden-notification', type: 'mention', user: bob, note: { id: 'editable', text: 'Secret from stale frame' } });
	emit(c.native, main, 'notification', { id: 'safe-follow', type: 'follow', user: bob, createdAt: '2026-09-11T00:00:00.000Z' });
	await c.messages.take(message => message.event === 'notification');
	assert.equal(c.messages.received.some(message => String(message.payload).includes('Secret')), false);
	assert.equal(c.messages.received.some(message => message.payload === 'never-delivered'), false);
	f.notes.set('deletable', note('deletable'));
	emit(c.native, home, 'note', { id: 'deletable' });
	await c.messages.take(message => message.event === 'update');
	f.notes.delete('deletable');
	change(c.native, 'deletable', 'deleted');
	assert.equal((await c.messages.take(message => message.event === 'delete')).payload, 'deletable');
});

test('refreshes delivered boosts when their nested native note changes or disappears', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'public' });
	const global = await channel(c.native, 'globalTimeline');
	let nested = note('original');
	f.notes.set('original', nested);
	f.notes.set('boost', note('boost', { text: null, renote: nested, renoteId: nested.id }));
	emit(c.native, global, 'note', { id: 'boost' });
	await c.messages.take(message => message.event === 'update');
	await c.native.commands.take(message => message.type === 'subNote' && message.body.id === 'original');
	nested = note('original', { text: 'Updated nested content' });
	f.notes.set('original', nested);
	f.notes.set('boost', note('boost', { text: null, renote: nested, renoteId: nested.id }));
	change(c.native, 'original', 'updated');
	assert.equal(JSON.parse((await c.messages.take(message => message.event === 'status.update')).payload).reblog.content, '<p>Updated nested content</p>');
	f.notes.set('boost', note('boost', { text: null, renote: { ...nested, isHidden: true }, renoteId: nested.id }));
	change(c.native, 'original', 'deleted');
	assert.equal((await c.messages.take(message => message.event === 'delete')).payload, 'boost');
});

test('cancels an in-flight list subscription before native channel registration', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect();
	const started = deferred<void>();
	const resume = deferred<void>();
	f.setBeforeCall(async endpoint => {
		if (endpoint === 'users/lists/show') { started.resolve(); await resume.promise; }
	});
	c.socket.send(JSON.stringify({ type: 'subscribe', stream: 'list', list: 'pending-list' }));
	await started.promise;
	c.socket.send(JSON.stringify({ type: 'unsubscribe', stream: 'list', list: 'pending-list' }));
	c.socket.send(JSON.stringify({ type: 'subscribe', stream: 'public' }));
	// The unsubscribe is processed synchronously, even while native HTTP is pending.
	await new Promise(resolve => setTimeout(resolve, 10));
	resume.resolve();
	await channel(c.native, 'globalTimeline');
	assert.equal([...c.native.channels.values()].some(value => value.name === 'userList'), false);
});

test('closes an active connection before emitting after compatibility grant revocation', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'public' });
	const global = await channel(c.native, 'globalTimeline');
	assert.equal(f.store.revokeGrant(f.token, f.client.id), true);
	const closed = once(c.socket, 'close');
	f.notes.set('after-revocation', note('after-revocation'));
	emit(c.native, global, 'note', { id: 'after-revocation' });
	assert.equal((await closed)[0], 1008);
	assert.equal(c.messages.received.length, 0);
});

test('emits direct conversations with the visible root identity and deduplicates native channels', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'direct' });
	const home = await channel(c.native, 'homeTimeline');
	const main = await channel(c.native, 'main');
	f.notes.set('100', note('100', { visibility: 'specified', visibleUserIds: [alice.id] }));
	f.notes.set('200', note('200', { visibility: 'specified', visibleUserIds: [alice.id], replyId: '100' }));
	emit(c.native, home, 'note', { id: '200' });
	emit(c.native, main, 'mention', { id: '200' });
	const received = await c.messages.take(message => message.event === 'conversation');
	assert.deepEqual(received.stream, ['direct']);
	const conversation = JSON.parse(received.payload);
	assert.equal(conversation.id, '100');
	assert.equal(conversation.last_status.id, '200');
	assert.deepEqual(conversation.accounts.map((account: Json) => account.id), [bob.id]);
	f.notes.set('300', note('300', { visibility: 'specified', visibleUserIds: [alice.id], replyId: '100' }));
	emit(c.native, main, 'mention', { id: '300' });
	await c.messages.take(message => message.event === 'conversation');
	assert.equal(c.messages.received.filter(message => message.event === 'conversation' && JSON.parse(message.payload).last_status.id === '200').length, 1);
});

test('keeps the newest direct status after older edits and refreshes its visible predecessor on deletion', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'direct' });
	const home = await channel(c.native, 'homeTimeline');
	for (const id of ['100', '200', '300']) f.notes.set(id, note(id, { visibility: 'specified', visibleUserIds: [alice.id], ...(id === '100' ? {} : { replyId: '100' }) }));
	f.states.set('300', { isFavorited: true, isMutedThread: true });
	f.users.get(bob.id)!.pinnedNoteIds = ['300'];
	emit(c.native, home, 'note', { id: '100' });
	await c.messages.take(message => message.event === 'conversation');
	emit(c.native, home, 'note', { id: '300' });
	await c.messages.take(message => message.event === 'conversation');
	f.notes.set('100', note('100', { visibility: 'specified', visibleUserIds: [alice.id], text: 'Older status edited' }));
	change(c.native, '100', 'updated');
	const afterOldEdit = JSON.parse((await c.messages.take(message => message.event === 'conversation')).payload).last_status;
	assert.equal(afterOldEdit.id, '300');
	assert.equal(afterOldEdit.bookmarked, true);
	assert.equal(afterOldEdit.muted, true);
	assert.equal(afterOldEdit.pinned, true);
	f.notes.delete('300');
	change(c.native, '300', 'deleted');
	const refreshed = JSON.parse((await c.messages.take(message => message.event === 'conversation')).payload);
	assert.equal(refreshed.id, '100');
	assert.equal(refreshed.last_status.id, '200');
	assert.equal(refreshed.last_status.bookmarked, false);
	assert.equal(refreshed.last_status.muted, false);
	assert.equal(refreshed.last_status.pinned, false);
	assert.equal(f.store.get<Json>('conversation', alice.id, '100')?.latestId, '200');
	await c.native.commands.take(message => message.type === 'subNote' && message.body.id === '200');
	f.notes.delete('200');
	change(c.native, '200', 'deleted');
	assert.equal(JSON.parse((await c.messages.take(message => message.event === 'conversation')).payload).last_status.id, '100');
	f.notes.delete('100');
	change(c.native, '100', 'deleted');
	assert.equal(JSON.parse((await c.messages.take(message => message.event === 'conversation')).payload).last_status, null);
});

test('propagates native disconnects and releases gateway listeners and sockets on close', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const c = await f.connect({ stream: 'public' });
	await channel(c.native, 'globalTimeline');
	const closed = once(c.socket, 'close');
	c.native.socket.close();
	assert.equal((await closed)[0], 1012);
	await f.bridge.close();
	assert.equal(f.gateway.listenerCount('upgrade'), 0);
});
