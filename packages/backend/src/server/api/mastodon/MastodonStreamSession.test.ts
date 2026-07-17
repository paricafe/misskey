/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { MastodonStreamSession, type MastodonStreamOutput } from './MastodonStreamSession.js';

function createSession(options: {
	filter?: (statuses: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
	notifications?: (sources: unknown[]) => Promise<unknown[]>;
	followedTags?: string[];
	conversation?: (noteId: string) => Promise<Record<string, unknown>>;
	refreshConversation?: (conversationId: string) => Promise<Record<string, unknown> | null>;
	scopes?: string[];
	allows?: (scope: string) => boolean;
} = {}) {
	const subscriber = new EventEmitter();
	let nativeSocket: { send: (data: string | Buffer) => void; emit: (event: string, data: Buffer) => boolean } | undefined;
	const nativeStream = {
		listen: vi.fn(async (_subscriber, socket) => { nativeSocket = socket; }),
		connectChannel: vi.fn(async (_id: string, _params: unknown, _channel: string) => undefined),
		disconnectChannel: vi.fn((_id: string) => undefined),
		dispose: vi.fn(),
	};
	const outputs: MastodonStreamOutput[] = [];
	const close = vi.fn();
	const status = vi.fn((value: { id: string; text?: string | null; cw?: string | null }) => ({
		id: value.id,
		...(value.text == null ? {} : { text: value.text }),
		...(value.cw == null ? {} : { cw: value.cw }),
	}));
	const notification = vi.fn((value: { id: string; note?: { id: string } }) => ({
		id: value.id,
		type: 'mention',
		created_at: '2026-07-17T00:00:00.000Z',
		account: { id: 'actor' },
		...(value.note == null ? {} : { status: { id: value.note.id } }),
	}));
	const announcement = vi.fn((value: { id: string; text: string }) => ({ id: value.id, content: value.text }));
	const filterApply = vi.fn(async (_userId, _context, statuses: Record<string, unknown>[], _options?: unknown) => options.filter?.(statuses) ?? statuses);
	const upsertLive = vi.fn(async (_user, noteId: string) => options.conversation?.(noteId) ?? ({
		id: `conversation-${noteId}`,
		unread: true,
		accounts: [{ id: 'actor' }],
		lastStatus: note(noteId, { visibility: 'specified' }),
	}));
	const refreshLive = vi.fn(async (_user, conversationId: string) => options.refreshConversation?.(conversationId) ?? null);
	const session = new MastodonStreamSession({
		auth: {
			kind: 'user',
			user: { id: 'user-id' },
			token: { id: 'token-id', scopes: options.scopes ?? ['read'] },
		} as never,
		subscriber,
		nativeStream: nativeStream as never,
		mastodonScopeService: {
			assert: vi.fn(),
			assertAny: vi.fn(),
			allows: vi.fn((_scopes, scope) => options.allows?.(scope) ?? true),
		} as never,
		mastodonEntityService: { status, notification, announcement } as never,
		mastodonFilterService: { apply: filterApply } as never,
		mastodonNotificationService: {
			list: vi.fn(async (_userId, sources) => options.notifications?.(sources) ?? sources),
		} as never,
		mastodonUserFeatureService: {
			listFollowedTags: vi.fn(async () => (options.followedTags ?? []).map((name, index) => ({ id: `${index}`, name }))),
		} as never,
		mastodonConversationService: { upsertLive, refreshLive } as never,
		send: output => { outputs.push(output); },
		close,
	});
	return {
		session,
		subscriber,
		nativeStream,
		outputs,
		close,
		status,
		announcement,
		filterApply,
		upsertLive,
		refreshLive,
		frame(value: unknown) {
			if (nativeSocket == null) throw new Error('session has not started');
			nativeSocket.send(JSON.stringify(value));
		},
	};
}

function note(id: string, options: { remote?: boolean; media?: boolean; visibility?: string; text?: string } = {}) {
	return {
		id,
		text: options.text ?? null,
		cw: null,
		user: { id: `user-${id}`, host: options.remote ? 'remote.example' : null },
		userId: `user-${id}`,
		files: options.media ? [{ id: `file-${id}`, comment: null }] : [],
		poll: null,
		renote: null,
		visibility: options.visibility ?? 'public',
		visibleUserIds: [],
	};
}

describe(MastodonStreamSession, () => {
	test('subscribes and unsubscribes native channels while selecting remote media faithfully', async () => {
		const { session, nativeStream, outputs, frame } = createSession();
		await session.start();
		await session.subscribe({ stream: 'public:remote:media' });
		expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-0', {}, 'globalTimeline');

		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('local-media', { media: true }) } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('remote-text', { remote: true }) } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('remote-media', { remote: true, media: true }) } });
		await vi.waitFor(() => expect(outputs).toEqual([{
			event: 'update',
			payload: { id: 'remote-media' },
			stream: 'public:remote:media',
		}]));

		await session.unsubscribe({ stream: 'public:remote:media' });
		expect(nativeStream.disconnectChannel).toHaveBeenCalledWith('mastodon-0');
	});

	test('applies hide and warn filters before emitting statuses', async () => {
		const { session, outputs, frame } = createSession({
			filter: async statuses => statuses.flatMap(value => value.id === 'hidden' ? [] : [{ ...value, filtered: [{ filter: { filter_action: 'warn' } }] }]),
		});
		await session.start();
		await session.subscribe({ stream: 'public' });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('hidden', { text: 'blocked' }) } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('warned', { text: 'spoiler' }) } });
		await vi.waitFor(() => expect(outputs).toEqual([{
			event: 'update',
			payload: { id: 'warned', text: 'spoiler', filtered: [{ filter: { filter_action: 'warn' } }] },
			stream: 'public',
		}]));
	});

	test.each([
		{
			name: 'token revocation',
			event: { channel: 'mastodonTokenRevoked:token-id', message: null },
		},
		{
			name: 'user suspension',
			event: { channel: 'internal', message: { type: 'userChangeSuspendedState', body: { id: 'user-id', isSuspended: true } } },
		},
		{
			name: 'user deletion',
			event: { channel: 'internal', message: { type: 'userChangeDeletedState', body: { id: 'user-id', isDeleted: true } } },
		},
	])('closes immediately on $name while an ordered status event is blocked', async ({ event }) => {
		let releaseFilter!: () => void;
		const filterPending = new Promise<void>(resolve => { releaseFilter = resolve; });
		const { session, close, filterApply } = createSession({
			filter: async statuses => {
				await filterPending;
				return statuses;
			},
		});
		await session.start();
		await session.subscribe({ stream: 'public' });
		const notePending = session.handleNativeFrame(JSON.stringify({
			type: 'channel',
			body: { id: 'mastodon-0', type: 'note', body: note('blocked') },
		}));
		await vi.waitFor(() => expect(filterApply).toHaveBeenCalledOnce());

		const invalidationPending = session.handleRedisEvent(event);
		try {
			expect(close).toHaveBeenCalledOnce();
		} finally {
			releaseFilter();
			await Promise.all([notePending, invalidationPending]);
		}
	});

	test('refreshes full direct conversations for edits and deletes without status events', async () => {
		const { session, outputs, upsertLive, refreshLive, frame } = createSession();
		await session.start();
		await session.subscribe({ stream: 'direct' });
		await session.subscribe({ stream: 'user' });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'mention', body: note('direct-note', { visibility: 'specified' }) } });
		await vi.waitFor(() => expect(outputs[0]).toEqual({
			event: 'conversation',
			payload: {
				id: 'conversation-direct-note',
				unread: true,
				accounts: [{ id: 'actor' }],
				last_status: { id: 'direct-note' },
			},
			stream: 'direct',
		}));
		upsertLive.mockResolvedValueOnce({
			id: 'conversation-direct-note',
			unread: false,
			accounts: [{ id: 'actor' }],
			lastStatus: note('direct-note', { visibility: 'specified', text: 'edited' }),
		});

		await session.handleRedisEvent({
			channel: 'noteStream:direct-note',
			message: { type: 'updated', body: { id: 'direct-note', body: { text: 'edited', cw: 'edited cw' } } },
		});
		expect(outputs.filter(output => output.stream === 'direct').at(-1)).toEqual({
			event: 'conversation',
			payload: {
				id: 'conversation-direct-note',
				unread: false,
				accounts: [{ id: 'actor' }],
				last_status: { id: 'direct-note', text: 'edited' },
			},
			stream: 'direct',
		});
		refreshLive.mockResolvedValueOnce({
			id: 'conversation-direct-note',
			unread: true,
			accounts: [{ id: 'actor' }],
			lastStatus: note('older-direct-note', { visibility: 'specified', text: 'previous' }),
		});
		await session.handleRedisEvent({ channel: 'noteStream:direct-note', message: { type: 'deleted', body: { id: 'direct-note' } } });
		expect(refreshLive).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), 'conversation-direct-note');
		expect(outputs.filter(output => output.stream === 'direct').at(-1)).toEqual({
			event: 'conversation',
			payload: {
				id: 'conversation-direct-note',
				unread: true,
				accounts: [{ id: 'actor' }],
				last_status: { id: 'older-direct-note', text: 'previous' },
			},
			stream: 'direct',
		});
		expect(outputs.some(output => output.stream === 'direct' && (output.event === 'status.update' || output.event === 'delete'))).toBe(false);

		await session.handleRedisEvent({ channel: 'mastodonCompat:user-id', message: { type: 'filters_changed', body: null } });
		await session.handleRedisEvent({ channel: 'mastodonCompat:user-id', message: { type: 'notifications_merged', body: null } });
		expect(outputs).toContainEqual({ event: 'filters_changed', stream: 'user' });
		expect(outputs).toContainEqual({ event: 'notifications_merged', stream: 'user' });
	});

	test('converts native announcements to Mastodon entities and keeps deletion IDs raw', async () => {
		const { session, outputs, announcement, frame } = createSession();
		await session.start();
		await session.subscribe({ stream: 'user' });
		const native = { id: 'announcement-id', text: 'Maintenance' };

		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'announcementCreated', body: { announcement: native } } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'announcementDeleted', body: native.id } });

		await vi.waitFor(() => expect(outputs).toEqual([
			{ event: 'announcement', payload: { id: 'announcement-id', content: 'Maintenance' }, stream: 'user' },
			{ event: 'announcement.delete', payload: 'announcement-id', stream: 'user', rawPayload: true },
		]));
		expect(announcement).toHaveBeenCalledWith(native);
	});

	test('passes text, CW, poll, media descriptions, and renote text as the streaming filter corpus', async () => {
		const { session, filterApply, frame } = createSession();
		await session.start();
		await session.subscribe({ stream: 'public' });
		const packed = {
			...note('corpus', { text: 'body text' }),
			cw: 'content warning',
			files: [{ id: 'file', comment: 'media description' }],
			poll: { choices: [{ text: 'poll choice', votes: 0, isVoted: false }] },
			renote: note('renote', { text: 'renoted text' }),
		};
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: packed } });
		await vi.waitFor(() => expect(filterApply).toHaveBeenCalled());
		expect(filterApply.mock.calls.at(-1)?.[3]).toEqual({
			corpora: new Map([['corpus', ['body text', 'content warning', 'media description', 'poll choice', 'renoted text']]]),
		});
	});

	test('keeps hashtag and list multiplex identities independent and duplicate subscribe idempotent', async () => {
		const { session, nativeStream } = createSession();
		await session.start();
		await session.subscribe({ stream: 'hashtag', tags: ['alpha'] });
		await session.subscribe({ stream: 'hashtag', tags: ['beta'] });
		await session.subscribe({ stream: 'hashtag', tags: ['alpha'] });
		await session.subscribe({ stream: 'list', listId: 'list-a' });
		await session.subscribe({ stream: 'list', listId: 'list-b' });
		expect(nativeStream.connectChannel).toHaveBeenCalledTimes(4);

		const alphaId = nativeStream.connectChannel.mock.calls.find(([, params]) => JSON.stringify(params) === JSON.stringify({ q: [['alpha']] }))?.[0];
		const betaId = nativeStream.connectChannel.mock.calls.find(([, params]) => JSON.stringify(params) === JSON.stringify({ q: [['beta']] }))?.[0];
		await session.unsubscribe({ stream: 'hashtag', tags: ['alpha'] });
		expect(nativeStream.disconnectChannel).toHaveBeenCalledWith(alphaId);
		expect(nativeStream.disconnectChannel).not.toHaveBeenCalledWith(betaId);
	});

	test('rejects subscriptions before the native 32-channel cap, including followed-tag channels', async () => {
		const followedTags = Array.from({ length: 20 }, (_, index) => `followed${index}`);
		const { session, nativeStream } = createSession({ followedTags });
		await session.start();
		await session.subscribe({ stream: 'user' });
		for (let index = 0; index < 10; index++) {
			await session.subscribe({ stream: 'list', listId: `list-${index}` });
		}
		expect(nativeStream.connectChannel).toHaveBeenCalledTimes(32);

		await expect(session.subscribe({ stream: 'list', listId: 'overflow' })).rejects.toThrow('Too many streaming channels');
		expect(nativeStream.connectChannel).toHaveBeenCalledTimes(32);

		await session.unsubscribe({ stream: 'list', listId: 'list-0' });
		await expect(session.subscribe({ stream: 'list', listId: 'overflow' })).resolves.toBeUndefined();
		expect(nativeStream.connectChannel).toHaveBeenCalledTimes(33);
	});

	test('rejects a pending native channel connection that finishes after disposal', async () => {
		let finishConnect!: () => void;
		const connecting = new Promise<undefined>(resolve => { finishConnect = () => resolve(undefined); });
		const { session, nativeStream } = createSession();
		nativeStream.connectChannel.mockImplementationOnce(() => connecting);
		await session.start();
		const subscribing = session.subscribe({ stream: 'public' });
		await vi.waitFor(() => expect(nativeStream.connectChannel).toHaveBeenCalledOnce());

		session.dispose();
		finishConnect();

		await expect(subscribing).rejects.toThrow('Streaming session is not active');
		expect(nativeStream.disconnectChannel).toHaveBeenLastCalledWith('mastodon-0');
		expect(nativeStream.disconnectChannel).toHaveBeenCalledTimes(2);
	});

	test('rejects native listener startup that finishes after disposal', async () => {
		let finishListening!: () => void;
		const listening = new Promise<void>(resolve => { finishListening = resolve; });
		const { session, subscriber, nativeStream } = createSession();
		nativeStream.listen.mockImplementationOnce(async () => {
			await listening;
			subscriber.on('broadcast', () => undefined);
		});
		const starting = session.start();
		await vi.waitFor(() => expect(nativeStream.listen).toHaveBeenCalledOnce());

		session.dispose();
		finishListening();

		await expect(starting).rejects.toThrow('Streaming session is not active');
		expect(subscriber.listenerCount('broadcast')).toBe(0);
		expect(nativeStream.dispose).toHaveBeenCalledTimes(2);
	});

	test('applies notification policy and notification-context filters before live emission', async () => {
		const { session, outputs, frame } = createSession({
			notifications: async sources => sources.filter(source => (source as { entity: { id: string } }).entity.id !== 'dropped'),
			filter: async statuses => statuses.flatMap(status => status.id === 'hidden-status' ? [] : [status]),
		});
		await session.start();
		await session.subscribe({ stream: 'user:notification' });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'notification', body: { id: 'dropped' } } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'notification', body: { id: 'filtered', note: note('hidden-status') } } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'notification', body: { id: 'visible', note: note('visible-status') } } });
		await vi.waitFor(() => expect(outputs).toEqual([expect.objectContaining({
			event: 'notification',
			payload: expect.objectContaining({ id: 'visible' }),
			stream: 'user:notification',
		})]));
	});

	test('delivers notifications but suppresses statuses on a notifications-only user stream', async () => {
		const { session, outputs, frame } = createSession({
			scopes: ['read:notifications'],
			allows: scope => scope === 'read:notifications',
		});
		await session.start();
		await session.subscribe({ stream: 'user' });

		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('status-without-scope') } });
		frame({ type: 'channel', body: { id: 'mastodon-0', type: 'notification', body: { id: 'visible-notification' } } });

		await vi.waitFor(() => expect(outputs).toEqual([expect.objectContaining({
			event: 'notification',
			payload: expect.objectContaining({ id: 'visible-notification' }),
			stream: 'user',
		})]));
	});

	test('loads followed tags for user streams and refreshes hashtag channels from compatibility events', async () => {
		const followedTags = ['misskey'];
		const { session, nativeStream } = createSession({ followedTags });
		await session.start();
		await session.subscribe({ stream: 'user' });
		expect(nativeStream.connectChannel).toHaveBeenCalledWith(expect.any(String), { q: [['misskey']] }, 'hashtag');

		followedTags.push('fediverse');
		await session.handleRedisEvent({
			channel: 'mastodonCompat:user-id',
			message: { type: 'followed_tag_changed', body: { action: 'follow', tag: 'fediverse' } },
		});
		expect(nativeStream.connectChannel).toHaveBeenCalledWith(expect.any(String), { q: [['fediverse']] }, 'hashtag');
		const followedChannel = nativeStream.connectChannel.mock.calls.find(([, params]) => JSON.stringify(params) === JSON.stringify({ q: [['misskey']] }))?.[0];
		followedTags.shift();
		await session.handleRedisEvent({
			channel: 'mastodonCompat:user-id',
			message: { type: 'followed_tag_changed', body: { action: 'unfollow', tag: 'misskey' } },
		});
		expect(nativeStream.disconnectChannel).toHaveBeenCalledWith(followedChannel);
	});

	test('bounds de-duplication to 1000 notes for the whole connection while retaining stream membership', async () => {
		const { session, nativeStream, outputs } = createSession();
		await session.start();
		await session.subscribe({ stream: 'public' });
		await session.subscribe({ stream: 'public:local' });
		await session.handleNativeFrame(JSON.stringify({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('shared') } }));
		await session.handleNativeFrame(JSON.stringify({ type: 'channel', body: { id: 'mastodon-1', type: 'note', body: note('shared') } }));
		await session.handleRedisEvent({ channel: 'noteStream:shared', message: { type: 'deleted' } });
		expect(outputs.filter(output => output.event === 'delete')).toEqual([
			{ event: 'delete', payload: 'shared', stream: 'public', rawPayload: true },
			{ event: 'delete', payload: 'shared', stream: 'public:local', rawPayload: true },
		]);

		for (let index = 0; index < 600; index++) {
			await session.handleNativeFrame(JSON.stringify({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note(`public-${index}`) } }));
			await session.handleNativeFrame(JSON.stringify({ type: 'channel', body: { id: 'mastodon-1', type: 'note', body: note(`local-${index}`) } }));
		}
		expect(outputs).toHaveLength(1204);
		await session.handleNativeFrame(JSON.stringify({ type: 'channel', body: { id: 'mastodon-0', type: 'note', body: note('public-0') } }));
		expect(outputs).toHaveLength(1205);

		session.dispose();
		expect(nativeStream.disconnectChannel).toHaveBeenCalledWith('mastodon-0');
		expect(nativeStream.disconnectChannel).toHaveBeenCalledWith('mastodon-1');
		expect(nativeStream.dispose).toHaveBeenCalledOnce();
	});
});
