/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { EntityConverter } from './entities.js';
import { NativeClient, NativeError } from './native-client.js';
import { getAuthorization } from './oauth.js';
import { allowsScope, assertScope, toNativePermissions } from './scopes.js';
import { CompatStore, type Grant, type StoreKey } from './store.js';
import { array, boolean, compareIds, HttpError, integer, pageRows, pagination, string, strings } from './parameters.js';
import type { Json } from './types.js';
import { applyFilters, type FilterContext } from './features.js';
import { decorateStatus, hydrateStatus, liveReblog } from './metadata.js';

export interface RouteDependencies { native: NativeClient; entities: EntityConverter; store: CompatStore; publicUrl: string; }
export interface RequestContext {
	request: FastifyRequest; reply: FastifyReply; grant?: Grant; userId: string; query: Json; body: Json; params: Json;
	call: <T = Json>(endpoint: string, body?: Json) => Promise<T>;
}
export type RouteHandler = (context: RequestContext) => unknown | Promise<unknown>;
type StatusStore = Pick<CompatStore, 'get' | 'list' | 'delete'>;
const storeKey = (key: StoreKey): string => JSON.stringify([key.namespace, key.owner, key.key]);

export class Routes {
	private readonly readCache = new WeakMap<RequestContext, Map<string, Promise<Json>>>();
	constructor(readonly app: FastifyInstance, readonly deps: RouteDependencies) {}
	add(method: HTTPMethods, url: string, scope: string | undefined, handler: RouteHandler, optional = false): void {
		this.app.route({ method, url, handler: async (request, reply) => {
			const grant = await getAuthorization(request, this.deps.store);
			if (!optional && (!grant || grant.kind !== 'user')) throw new HttpError(401, 'A user access token is required');
			if (grant && scope && !(scope === 'read:accounts' && allowsScope(grant.scopes, 'profile'))) assertScope(grant.scopes, scope);
			if (grant?.nativeToken) await this.deps.native.call('ping', {}, grant.nativeToken, { ip: request.ip });
			return handler({ request, reply, grant, userId: grant?.userId ?? '', query: request.query as Json, body: (request.body ?? {}) as Json, params: request.params as Json,
				call: <T>(endpoint: string, body: Json = {}) => this.deps.native.call<T>(endpoint, body, grant?.nativeToken, { ip: request.ip, userAgent: request.headers['user-agent'] }),
			});
		} });
	}
	async status(note: Json, context: RequestContext): Promise<Json> {
		const status = this.deps.entities.status(note, { viewerId: context.userId || null, allowLocalOnly: true });
		if (!status) throw new HttpError(404, 'Record not found');
		return this.completeStatus(status, context, this.deps.store);
	}
	private async completeStatus(status: Json, context: RequestContext, store: StatusStore): Promise<Json> {
		const path = context.request.url;
		const filterContext: FilterContext = path.includes('/timelines/home') || path.includes('/timelines/list/') ? 'home' : path.includes('/accounts/') ? 'account' : path.includes('/notifications') ? 'notifications' : path.includes('/statuses/') ? 'thread' : 'public';
		const readAccount = !!context.grant && toNativePermissions(context.grant.scopes).includes('read:account');
		const decorated = await decorateStatus(store, status, context.userId);
		const hydrated = await hydrateStatus(store, decorated, context.userId || undefined, readAccount, (endpoint, body) => this.cachedRead(context, endpoint, body));
		return applyFilters(store, context.userId, hydrated, filterContext);
	}
	async statuses(notes: Json[], context: RequestContext): Promise<Json[]> {
		const statuses = notes.flatMap(note => {
			const status = this.deps.entities.status(note, { viewerId: context.userId || null, allowLocalOnly: true });
			return status ? [status] : [];
		});
		if (statuses.length === 0) return [];
		const keys = new Map<string, StoreKey>();
		const authors = new Set<string>();
		const add = (namespace: string, owner: string, key: string) => {
			const lookup = { namespace, owner, key }; keys.set(storeKey(lookup), lookup);
		};
		const collect = (status: Json) => {
			const owner = String(status.account.id);
			authors.add(owner);
			add('status', owner, status.id);
			if (context.userId) add('reblog', context.userId, status.id);
			for (const file of status.media_attachments) add('media', owner, file.id);
			if (status.reblog) collect(status.reblog);
			if (status.quote?.quoted_status) collect(status.quote.quoted_status);
		};
		statuses.forEach(collect);
		const [entries, filters] = await Promise.all([
			this.deps.store.getMany([...keys.values()]),
			context.userId ? this.deps.store.list('filter', context.userId) : [],
			this.prefetchAuthors(context, [...authors]),
		]);
		const values = new Map(entries.map(entry => [storeKey(entry), entry.value]));
		const store: StatusStore = {
			get: async <T>(namespace: string, owner: string, key: string) => values.get(storeKey({ namespace, owner, key })) as T | undefined,
			list: async <T>() => filters as Array<{ key: string; value: T }>,
			delete: async (namespace, owner, key) => {
				values.delete(storeKey({ namespace, owner, key }));
				return this.deps.store.delete(namespace, owner, key);
			},
		};
		// Bound native state lookups while preserving the source timeline order.
		const result: Array<Json | null> = Array(statuses.length).fill(null);
		let next = 0;
		let failed = false;
		await Promise.all(Array.from({ length: Math.min(4, statuses.length) }, async () => {
			for (let index = next++; !failed && index < statuses.length; index = next++) {
				try { result[index] = await this.completeStatus(statuses[index], context, store); } catch (error) {
					if (!(error instanceof HttpError && error.statusCode === 404)) { failed = true; throw error; }
				}
			}
		}));
		return result.filter((status): status is Json => status !== null);
	}
	private async prefetchAuthors(context: RequestContext, ids: string[]): Promise<void> {
		// Preserve the native single-user visibility checks for anonymous requests.
		if (!context.grant?.nativeToken) return;
		const users = await context.call<Json[]>('users/show', { userIds: ids });
		let cache = this.readCache.get(context);
		if (!cache) { cache = new Map(); this.readCache.set(context, cache); }
		for (const user of users) cache.set(`users/show:${JSON.stringify({ userId: user.id })}`, Promise.resolve(user));
	}
	page(context: RequestContext, source: Json[], results: Json[], cursor = (item: Json) => item.id): Json[] {
		if (source.length) {
			const sorted = [...source].sort((a, b) => compareIds(string(cursor(b)), string(cursor(a))));
			const next = new URL(context.request.url, this.deps.publicUrl);
			next.searchParams.delete('min_id'); next.searchParams.delete('since_id'); next.searchParams.delete('access_token');
			const previous = new URL(next); previous.searchParams.delete('max_id');
			next.searchParams.set('max_id', string(cursor(sorted.at(-1)!)));
			previous.searchParams.set('min_id', string(cursor(sorted[0])));
			context.reply.header('Link', `<${next}>; rel="next", <${previous}>; rel="prev"`);
		}
		return results;
	}
	async readPage(context: RequestContext, endpoint: string, body: Json = {}, limit = 20, maximum = 80): Promise<Json[]> {
		const rows = await context.call<Json[]>(endpoint, { ...pagination(context.query, limit, maximum), ...body });
		return pageRows(rows, context.query, item => string(item.id), limit, maximum);
	}
	private cachedRead(context: RequestContext, endpoint: string, body: Json): Promise<Json> {
		let cache = this.readCache.get(context);
		if (!cache) { cache = new Map(); this.readCache.set(context, cache); }
		const key = `${endpoint}:${JSON.stringify(body)}`;
		let response = cache.get(key);
		if (!response) { response = context.call(endpoint, body); cache.set(key, response); }
		return response;
	}
	async note(context: RequestContext, id = string(context.params.id)): Promise<Json> { return context.call('notes/show', { noteId: id }); }
	async relationship(context: RequestContext, id = string(context.params.id)): Promise<Json> {
		const user = await context.call('users/show', { userId: id });
		return { ...this.deps.entities.relationship(user), note: await this.deps.store.get('account-note', context.userId, id) ?? '' };
	}
}

export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): Routes {
	const routes = new Routes(app, deps);
	const { native, entities, store, publicUrl } = deps;
	const add = routes.add.bind(routes);
	const account = (user: Json) => entities.account(user);
	const tag = (name: string) => ({ name, url: `${publicUrl}/tags/${encodeURIComponent(name)}`, history: [] });
	const list = (item: Json) => ({ id: item.id, title: item.name, replies_policy: 'list', exclusive: false });
	const meta = () => native.call<Json>('meta', { detail: true });
	for (const version of [1, 2] as const) add('GET', `/api/v${version}/instance`, undefined, async () => entities.instance(await meta(), await native.call('stats', {}), version), true);
	add('GET', '/api/v1/instance/rules', undefined, async () => array((await meta()).serverRules).map((text, index) => ({ id: String(index + 1), text, hint: '' })), true);
	add('GET', '/api/v1/custom_emojis', undefined, async () => array((await native.call<Json>('emojis', {})).emojis).map(item => ({ shortcode: item.name, url: item.url, static_url: item.url, visible_in_picker: true, category: item.category ?? '' })), true);
	if (!app.hasRoute({ method: 'GET', url: '/api/v1/instance/peers' })) add('GET', '/api/v1/instance/peers', undefined, async c => (await c.call<Json[]>('federation/instances', { limit: 100 })).map(item => item.host), true);
	add('GET', '/api/v1/streaming/health', undefined, () => 'OK', true);
	add('GET', '/api/v1/directory', undefined, async c => (await c.call<Json[]>('users', { limit: integer(c.query.limit, 40, 1, 80), offset: integer(c.query.offset, 0), sort: c.query.order === 'new' ? '-createdAt' : '-updatedAt', state: 'alive', origin: boolean(c.query.local) ? 'local' : 'combined' })).map(account), true);
	for (const path of ['/api/v1/trends', '/api/v1/trends/tags']) add('GET', path, undefined, async c => (await c.call<Json[]>('hashtags/trend')).map(item => tag(item.tag)), true);
	add('GET', '/api/v1/trends/statuses', 'read:statuses', async c => routes.statuses(await c.call('notes/featured', { limit: integer(c.query.limit, 20, 1, 40) }), c), true);
	for (const version of [1, 2] as const) add('GET', `/api/v${version}/suggestions`, 'read:accounts', async c => (await c.call<Json[]>('users/recommendation', { limit: integer(c.query.limit, 40, 1, 80), offset: 0 })).map(user => version === 1 ? account(user) : { source: 'global', sources: ['most_followed'], account: account(user) }));
	add('GET', '/api/v1/accounts/verify_credentials', 'read:accounts', async c => {
		const result = entities.account(await c.call('i'), true);
		result.source = { ...result.source, ...await store.get<Json>('account-source', c.userId, 'defaults') };
		return result;
	});
	add('GET', '/api/v1/accounts/relationships', 'read:follows', c => Promise.all(strings(c.query.id).map(id => routes.relationship(c, id))));
	add('GET', '/api/v1/accounts/search', 'read:accounts', async c => (await c.call<Json[]>('users/search', { query: string(c.query.q), limit: integer(c.query.limit, 40, 1, 80), origin: boolean(c.query.resolve) ? 'combined' : 'local', detail: true })).map(account));
	add('GET', '/api/v1/accounts/lookup', 'read:accounts', async c => {
		const [username, host] = string(c.query.acct).replace(/^@/u, '').split('@');
		return account(await c.call('users/show', { username, host: host && host !== new URL(publicUrl).host ? host : null }));
	}, true);
	add('GET', '/api/v1/accounts/:id', 'read:accounts', async c => account(await c.call('users/show', { userId: c.params.id })), true);
	add('GET', '/api/v1/accounts/:id/statuses', 'read:statuses', async c => {
		const onlyMedia = boolean(c.query.only_media), excludeReplies = boolean(c.query.exclude_replies), excludeReblogs = boolean(c.query.exclude_reblogs);
		const notes = boolean(c.query.pinned)
			? pageRows(array((await c.call('users/show', { userId: c.params.id })).pinnedNotes), c.query)
			: await routes.readPage(c, 'users/notes', { userId: c.params.id, withReplies: !excludeReplies, withRenotes: !excludeReblogs, withFiles: onlyMedia && excludeReplies });
		const filtered = notes.filter(item => (!excludeReplies || !item.replyId) && (!excludeReblogs || !item.renoteId || item.text || item.cw || array(item.files).length || item.poll) && (!onlyMedia || array(item.files).length) && (!c.query.tagged || array(item.tags).includes(c.query.tagged)));
		return routes.page(c, notes, await routes.statuses(filtered, c));
	}, true);
	for (const direction of ['followers', 'following']) add('GET', `/api/v1/accounts/:id/${direction}`, 'read:follows', async c => {
		const rows = await routes.readPage(c, `users/${direction}`, { userId: c.params.id });
		return routes.page(c, rows, rows.map(row => account(row[direction === 'followers' ? 'follower' : 'followee'])));
	}, true);
	for (const [action, endpoint, scope] of [
		['follow', 'following/create', 'follows'], ['unfollow', 'following/delete', 'follows'], ['block', 'blocking/create', 'blocks'], ['unblock', 'blocking/delete', 'blocks'], ['mute', 'mute/create', 'mutes'], ['unmute', 'mute/delete', 'mutes'], ['remove_from_followers', 'following/invalidate', 'follows'],
	]) add('POST', `/api/v1/accounts/:id/${action}`, `write:${scope}`, async c => {
		await c.call(endpoint, { userId: c.params.id, ...(action === 'mute' && c.body.duration ? { expiresAt: Date.now() + integer(c.body.duration, 0) * 1000 } : {}) }).catch(error => {
			if (!(error instanceof NativeError && ['ALREADY_FOLLOWING', 'ALREADY_BLOCKING', 'ALREADY_MUTING', 'NOT_FOLLOWING', 'NOT_BLOCKING', 'NOT_MUTING'].includes(error.code))) throw error;
		});
		if (action === 'follow' && c.body.notify !== undefined) await c.call('following/update', { userId: c.params.id, notify: boolean(c.body.notify) ? 'normal' : 'none' });
		return routes.relationship(c);
	});
	add('POST', '/api/v1/accounts/:id/note', 'write:accounts', async c => { await c.call('users/show', { userId: c.params.id }); await store.put('account-note', c.userId, c.params.id, string(c.body.comment)); return routes.relationship(c); });
	add('GET', '/api/v1/follow_requests', 'read:follows', async c => {
		const rows = await routes.readPage(c, 'following/requests/list'); return routes.page(c, rows, rows.map(item => account(item.follower)));
	});
	for (const [action, endpoint] of [['authorize', 'accept'], ['reject', 'reject']]) add('POST', `/api/v1/follow_requests/:id/${action}`, 'write:follows', async c => { await c.call(`following/requests/${endpoint}`, { userId: c.params.id }); return routes.relationship(c); });
	for (const [path, endpoint, scope, field] of [['blocks', 'blocking/list', 'blocks', 'blockee'], ['mutes', 'mute/list', 'mutes', 'mutee']]) add('GET', `/api/v1/${path}`, `read:${scope}`, async c => { const rows = await routes.readPage(c, endpoint); return routes.page(c, rows, rows.map(row => account(row[field]))); });

	for (const [path, endpoint, scope] of [['home', 'notes/timeline', 'statuses'], ['public', 'notes/global-timeline', 'statuses'], ['tag/:tag', 'notes/search-by-tag', 'statuses'], ['list/:id', 'notes/user-list-timeline', 'lists']]) {
		add('GET', `/api/v1/timelines/${path}`, `read:${scope}`, async c => {
			const parameters = { ...(path.startsWith('tag') ? { tag: c.params.tag, local: boolean(c.query.local) } : {}), ...(path.startsWith('list') ? { listId: c.params.id } : {}), withFiles: boolean(c.query.only_media) };
			const selected = path === 'public' && boolean(c.query.local) ? 'notes/local-timeline' : endpoint;
			const notes = await routes.readPage(c, selected, parameters);
			const filtered = notes.filter(note => (!boolean(c.query.remote) || note.user?.host) && (!boolean(c.query.only_media) || array(note.files).length));
			return routes.page(c, notes, await routes.statuses(filtered, c));
		}, path === 'public' || path.startsWith('tag'));
	}
	add('GET', '/api/v1/statuses', 'read:statuses', async c => routes.statuses(await Promise.all(strings(c.query.id).map(id => routes.note(c, id))), c), true);
	add('GET', '/api/v1/statuses/:id', 'read:statuses', async c => routes.status(await routes.note(c), c), true);
	add('GET', '/api/v1/statuses/:id/context', 'read:statuses', async c => {
		await routes.status(await routes.note(c), c);
		const ancestors = await c.call<Json[]>('notes/conversation', { noteId: c.params.id, limit: 100 });
		const descendants = await replyDescendants(routes, c, string(c.params.id));
		return { ancestors: (await routes.statuses(ancestors, c)).reverse(), descendants: descendants.sort((a, b) => compareIds(a.id, b.id)) };
	}, true);
	add('GET', '/api/v1/statuses/:id/source', 'read:statuses', async c => { const note = await routes.note(c); if (note.userId !== c.userId) throw new HttpError(403, 'You do not own this status'); return { id: note.id, text: note.text ?? '', spoiler_text: note.cw ?? '' }; });
	add('DELETE', '/api/v1/statuses/:id', 'write:statuses', async c => { const note = await routes.note(c); const result = await routes.status(note, c); await c.call('notes/delete', { noteId: note.id }); await store.delete('status', c.userId, note.id); return { ...result, text: note.text ?? '' }; });
	add('POST', '/api/v1/statuses', 'write:statuses', async c => createStatus(routes, c));
	add('PUT', '/api/v1/statuses/:id', 'write:statuses', async c => {
		const prepared = prepareStatusInput(c.body, undefined, true);
		const note = await routes.note(c);
		if (note.userId !== c.userId) throw new HttpError(403, 'You do not own this status');
		validateQuoteApprovalPolicy(c.body.quote_approval_policy, note.visibility);
		const body = { noteId: note.id, text: c.body.status === undefined ? note.text : prepared.native.text, cw: c.body.spoiler_text === undefined ? note.cw : prepared.native.cw, ...(c.body.media_ids !== undefined ? { fileIds: prepared.native.fileIds ?? [] } : {}) };
		if (note.renoteId && !body.text?.trim() && !(body.fileIds ?? note.files)?.length && !note.poll) body.text = (await quoteTarget(routes, c, note.renoteId)).url;
		await c.call('notes/update', body);
		await store.transaction(async () => {
			await store.put('status', c.userId, note.id, { ...await store.get<Json>('status', c.userId, note.id), ...prepared.metadata });
		});
		return routes.status(await routes.note(c), c);
	});
	for (const [action, endpoint] of [['reblog', 'notes/create'], ['unreblog', 'notes/unrenote']]) add('POST', `/api/v1/statuses/:id/${action}`, 'write:statuses', async c => {
		const selectedVisibility = action === 'reblog' ? visibility(c.body.visibility) : undefined;
		const note = await routes.note(c);
		if (action === 'reblog') {
			const existing = await liveReblog(store, c.userId, note.id, c.call);
			if (!existing) { const result = await c.call(endpoint, { renoteId: note.id, visibility: selectedVisibility }); await store.put('reblog', c.userId, note.id, result.createdNote.id); }
		} else { await c.call(endpoint, { noteId: note.id }); await store.delete('reblog', c.userId, note.id); }
		return { ...await routes.status(await routes.note(c), c), reblogged: action === 'reblog' };
	});
	for (const action of ['favourite', 'unfavourite']) add('POST', `/api/v1/statuses/:id/${action}`, 'write:favourites', async c => {
		const note = await routes.note(c);
		if (action === 'favourite') {
			if (note.myReaction && !['❤', '❤️'].includes(note.myReaction)) throw new HttpError(409, 'A different reaction is already present');
			if (!note.myReaction) await c.call('notes/reactions/create', { noteId: note.id, reaction: '❤', replaceExisting: false }).catch(error => { if (!(error instanceof NativeError && error.code === 'ALREADY_REACTED')) throw error; });
		} else if (['❤', '❤️'].includes(note.myReaction)) await c.call('notes/reactions/delete', { noteId: note.id, expectedReaction: note.myReaction }).catch(error => { if (!(error instanceof NativeError && error.code === 'NOT_REACTED')) throw error; });
		return routes.status(await routes.note(c), c);
	});
	for (const [action, endpoint, field, scope] of [['bookmark', 'notes/favorites/create', 'bookmarked', 'bookmarks'], ['unbookmark', 'notes/favorites/delete', 'bookmarked', 'bookmarks'], ['pin', 'i/pin', 'pinned', 'accounts'], ['unpin', 'i/unpin', 'pinned', 'accounts'], ['mute', 'notes/thread-muting/create', 'muted', 'mutes'], ['unmute', 'notes/thread-muting/delete', 'muted', 'mutes']]) add('POST', `/api/v1/statuses/:id/${action}`, `write:${scope}`, async c => {
		await routes.note(c);
		await c.call(endpoint, { noteId: c.params.id }).catch(error => { if (!(error instanceof NativeError && ['ALREADY_FAVORITED', 'NOT_FAVORITED', 'ALREADY_PINNED', 'NOT_PINNED', 'ALREADY_MUTED', 'NOT_MUTED'].includes(error.code))) throw error; });
		return { ...await routes.status(await routes.note(c), c), [field]: !action.startsWith('un') };
	});
	for (const [suffix, endpoint] of [['reblogged_by', 'notes/renotes'], ['favourited_by', 'notes/reactions']]) add('GET', `/api/v1/statuses/:id/${suffix}`, 'read:statuses', async c => {
		await routes.note(c);
		const rows = await routes.readPage(c, endpoint, { noteId: c.params.id, ...(suffix === 'favourited_by' ? { type: '❤' } : {}) }); return routes.page(c, rows, rows.map(item => account(item.user)));
	}, true);
	add('GET', '/api/v1/bookmarks', 'read:bookmarks', async c => { const rows = await routes.readPage(c, 'i/favorites'); return routes.page(c, rows, (await routes.statuses(rows.map(item => item.note), c)).map(status => ({ ...status, bookmarked: true }))); });
	add('GET', '/api/v1/favourites', 'read:favourites', async c => { const rows = await routes.readPage(c, 'users/reactions', { userId: c.userId }); return routes.page(c, rows, await routes.statuses(rows.filter(row => ['❤', '❤️'].includes(row.type)).map(row => row.note), c)); });
	add('GET', '/api/v1/polls/:id', 'read:statuses', async c => { const note = await routes.note(c); if (!note.poll) throw new HttpError(404, 'Record not found'); return entities.poll(note); }, true);
	add('POST', '/api/v1/polls/:id/votes', 'write:statuses', async c => {
		const note = await routes.note(c); if (!note.poll) throw new HttpError(404, 'Record not found');
		const choices = strings(c.body.choices).map(value => integer(value, -1, 0, note.poll.choices.length - 1));
		if (!choices.length || new Set(choices).size !== choices.length || (!note.poll.multiple && choices.length !== 1)) throw new HttpError(422, 'Invalid poll choices');
		const pending = choices.filter(choice => !note.poll.choices[choice].isVoted);
		if (pending.length) await c.call('notes/polls/vote', { noteId: note.id, choices: pending });
		return entities.poll(await routes.note(c));
	});
	add('GET', '/api/v1/lists', 'read:lists', async c => (await c.call<Json[]>('users/lists/list')).map(list));
	add('POST', '/api/v1/lists', 'write:lists', async c => list(await c.call('users/lists/create', { name: string(c.body.title) })));
	add('GET', '/api/v1/lists/:id', 'read:lists', async c => list(await c.call('users/lists/show', { listId: c.params.id })));
	add('PUT', '/api/v1/lists/:id', 'write:lists', async c => { if (c.body.exclusive === true || (c.body.replies_policy && c.body.replies_policy !== 'list')) throw new HttpError(422, 'This list policy is unavailable'); return list(await c.call('users/lists/update', { listId: c.params.id, name: string(c.body.title) })); });
	add('DELETE', '/api/v1/lists/:id', 'write:lists', async c => { await c.call('users/lists/delete', { listId: c.params.id }); return {}; });
	add('GET', '/api/v1/lists/:id/accounts', 'read:lists', async c => { const item = await c.call('users/lists/show', { listId: c.params.id }); return Promise.all(strings(item.userIds).map(async userId => account(await c.call('users/show', { userId })))); });
	for (const method of ['POST', 'DELETE'] as const) add(method, '/api/v1/lists/:id/accounts', 'write:lists', async c => { for (const userId of strings(c.body.account_ids)) await c.call(`users/lists/${method === 'POST' ? 'push' : 'pull'}`, { listId: c.params.id, userId }); return {}; });
	add('GET', '/api/v1/accounts/:id/lists', 'read:lists', async c => (await c.call<Json[]>('users/lists/list')).filter(item => array(item.userIds).includes(c.params.id)).map(list));
	registerMarkers(routes);
	return routes;
}

function visibility(value: unknown): string {
	const values: Json = { public: 'public', unlisted: 'home', private: 'followers', direct: 'specified' };
	const result = values[string(value, 'public')];
	if (!result) throw new HttpError(422, 'Invalid visibility');
	return result;
}

function validateQuoteApprovalPolicy(value: unknown, nativeVisibility: string): void {
	if (value == null) return;
	if (typeof value !== 'string') throw new HttpError(422, 'Invalid quote_approval_policy');
	const policy = value.trim();
	if (!policy) return;
	if (!['public', 'followers', 'nobody'].includes(policy)) throw new HttpError(422, 'Invalid quote_approval_policy');
	// Mastodon forces private/direct posts to nobody regardless of this input.
	// Native visibility already prevents other users quoting those posts. Public
	// notes have no native mechanism for enforcing a more restrictive policy.
	if (policy !== 'public' && !['followers', 'specified'].includes(nativeVisibility)) throw new HttpError(422, 'Only public quote approval is supported for public or unlisted statuses');
}

function prepareStatusInput(input: Json, defaults: Json = {}, editing = false): { native: Json; metadata: Json } {
	const text = (value: unknown, name: string): string | null => {
		if (value == null || value === '') return null;
		if (typeof value !== 'string') throw new HttpError(422, `${name} must be a string`);
		return value;
	};
	for (const name of ['scheduled_at', 'media_attributes']) {
		if (input[name] != null && input[name] !== '' && (!Array.isArray(input[name]) || input[name].length)) throw new HttpError(422, `${name} is unavailable through this gateway`);
	}
	if (editing && ['visibility', 'in_reply_to_id', 'poll', 'local_only'].some(name => input[name] !== undefined)) throw new HttpError(422, 'This status property cannot be edited');
	const native: Json = { text: text(input.status, 'status'), cw: text(input.spoiler_text, 'spoiler_text') };
	const quotedStatusId = text(input.quoted_status_id, 'quoted_status_id');
	const quoteId = text(input.quote_id, 'quote_id');
	if (quotedStatusId && quoteId && quotedStatusId !== quoteId) throw new HttpError(422, 'quote_id and quoted_status_id must refer to the same status');
	const quotedId = quotedStatusId ?? quoteId;
	if (quotedId) {
		if (editing) throw new HttpError(422, 'The quoted status cannot be changed');
		native.renoteId = quotedId;
	}
	if (native.cw && native.cw.length > 100) throw new HttpError(422, 'spoiler_text is too long');
	const metadata: Json = {};
	if (!editing || input.sensitive !== undefined) metadata.sensitive = boolean(input.sensitive, boolean(defaults.sensitive));
	if (!editing || input.language !== undefined) {
		const language = text(input.language === undefined ? defaults.language : input.language, 'language');
		if (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language)) throw new HttpError(422, 'Invalid language');
		metadata.language = language;
	}
	if (input.media_ids !== undefined) {
		const ids = strings(input.media_ids);
		if (ids.length > 16 || ids.some(id => !id) || new Set(ids).size !== ids.length) throw new HttpError(422, 'Invalid media_ids');
		native.fileIds = ids;
	}
	if (!editing) {
		native.visibility = visibility(input.visibility === undefined ? defaults.privacy : input.visibility);
		if (input.local_only !== undefined) native.localOnly = boolean(input.local_only);
		if (input.in_reply_to_id != null && input.in_reply_to_id !== '') native.replyId = string(input.in_reply_to_id);
	}
	if (input.poll != null) {
		const poll = input.poll;
		if (typeof poll !== 'object' || Array.isArray(poll)) throw new HttpError(422, 'Invalid poll');
		const choices = array(poll.options);
		if (choices.length < 2 || choices.length > 10 || choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 50) || new Set(choices).size !== choices.length) throw new HttpError(422, 'Invalid poll options');
		if (boolean(poll.hide_totals)) throw new HttpError(422, 'Hidden poll totals are unavailable through this gateway');
		if (poll.expires_in == null) throw new HttpError(422, 'poll.expires_in is required');
		native.poll = { choices, multiple: boolean(poll.multiple), expiredAfter: integer(poll.expires_in, 86400, 300, 2629746) * 1000 };
		if (native.fileIds?.length) throw new HttpError(422, 'A poll cannot be combined with media');
	}
	if (!editing && !native.text && !native.fileIds?.length && !native.poll && !native.renoteId) throw new HttpError(422, 'A status needs text, media, a poll, or a quote');
	return { native, metadata };
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value != null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
	return JSON.stringify(value) ?? 'null';
}

async function quoteTarget(routes: Routes, context: RequestContext, id: string): Promise<Json> {
	const read = async (noteId: string) => routes.deps.entities.status(await routes.note(context, noteId), { viewerId: context.userId, allowLocalOnly: true });
	let status = await read(id);
	if (status?.reblog) status = await read(status.reblog.id);
	if (!status) throw new HttpError(404, 'Record not found');
	return status;
}

async function createStatus(routes: Routes, c: RequestContext): Promise<Json> {
	const { store } = routes.deps;
	const prepared = prepareStatusInput(c.body, await store.get<Json>('account-source', c.userId, 'defaults'));
	validateQuoteApprovalPolicy(c.body.quote_approval_policy, prepared.native.visibility);
	const key = c.request.headers['idempotency-key'];
	if (Array.isArray(key) || (key !== undefined && (!key || key.length > 256))) throw new HttpError(422, 'Invalid idempotency key');
	const digest = createHash('sha256').update(canonicalJson(c.body)).digest('hex');
	const existing = async (): Promise<string | undefined> => {
		const stored = key ? await store.getIdempotency(c.userId, key) : undefined;
		if (!stored) return undefined;
		if (stored.digest !== digest) throw new HttpError(422, 'Idempotency key was used for a different request');
		if (!stored.id) throw new HttpError(409, 'This request is already being processed; check the timeline before retrying');
		return string(stored.id);
	};
	const replay = await existing();
	if (replay) return routes.status(await routes.note(c, replay), c);
	const body = prepared.native;
	const quoted = body.renoteId ? await quoteTarget(routes, c, body.renoteId) : undefined;
	if (quoted) {
		body.renoteId = quoted.id;
		// Misskey needs content to distinguish a quote from a pure renote.
		if (!body.text?.trim() && !body.cw && !body.fileIds?.length && !body.poll && !body.replyId) body.text = quoted.url;
	}
	if (body.visibility === 'specified') {
		const mentions = [...string(body.text).matchAll(/(?:^|\s)@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?/gu)];
		const ids = await Promise.all(mentions.map(async match => (await c.call('users/show', { username: match[1], host: match[2] ?? null })).id));
		if (quoted && quoted.account.id !== c.userId && !ids.includes(quoted.account.id)) throw new HttpError(422, 'A direct quote must explicitly mention the quoted author');
		if (body.replyId) { const reply = await routes.note(c, body.replyId); ids.push(reply.userId); }
		body.visibleUserIds = [...new Set(ids)].filter(id => id !== c.userId);
		if (!body.visibleUserIds.length) throw new HttpError(422, 'A direct status needs a recipient mention');
	}
	// Recipient lookups above yield. Recheck and claim in a short database
	// transaction so concurrent requests cannot both submit the native write.
	const claimedReplay = key ? await store.transaction(async () => {
		const id = await existing();
		if (id) return id;
		await store.putIdempotency(c.userId, key, { digest, expiresAt: Date.now() + 86400000 });
		return undefined;
	}) : undefined;
	if (claimedReplay) return routes.status(await routes.note(c, claimedReplay), c);
	let result: Json;
	try { result = await c.call('notes/create', body); } catch (error) {
		if (key && error instanceof NativeError && error.status >= 400 && error.status < 500 && ![408, 499].includes(error.status)) await store.delete('idempotency', c.userId, key);
		throw error;
	}
	const note = result.createdNote;
	if (!note || typeof note.id !== 'string' || !note.id) throw new NativeError(502, 'INVALID_NATIVE_RESPONSE', 'The native API did not return the created status');
	await store.transaction(async () => {
		await store.put('status', c.userId, note.id, prepared.metadata);
		if (key) await store.putIdempotency(c.userId, key, { id: note.id, digest, expiresAt: Date.now() + 86400000 });
	});
	return routes.status(note, c);
}

async function replyDescendants(routes: Routes, context: RequestContext, rootId: string): Promise<Json[]> {
	const pending = [rootId], seen = new Set(pending), result: Json[] = [];
	let requests = 0;
	while (pending.length && result.length < 100 && requests < 200) {
		const parentId = pending.shift()!;
		let untilId: string | undefined;
		while (result.length < 100 && requests++ < 200) {
			const rows = await context.call<Json[]>('notes/children', { noteId: parentId, limit: 100, ...(untilId ? { untilId } : {}) });
			for (const note of rows) {
				if (note.replyId !== parentId || seen.has(note.id)) continue;
				seen.add(note.id);
				try {
					result.push(await routes.status(note, context));
					pending.push(note.id);
				} catch (error) { if (!(error instanceof HttpError && error.statusCode === 404)) throw error; }
				if (result.length >= 100) break;
			}
			if (rows.length < 100) break;
			const oldest = rows.map(row => string(row.id)).sort(compareIds)[0];
			if (!oldest || (untilId && compareIds(oldest, untilId) >= 0)) break;
			untilId = oldest;
		}
	}
	return result;
}

function registerMarkers(routes: Routes): void {
	const { store } = routes.deps;
	const add = routes.add.bind(routes);
	add('GET', '/api/v1/markers', 'read:statuses', async c => {
		const result: Json = {};
		for (const name of strings(c.query.timeline).filter(name => ['home', 'notifications'].includes(name))) {
			const value = await store.get('marker', c.userId, name);
			if (value) result[name] = value;
		}
		return result;
	});
	add('POST', '/api/v1/markers', 'write:statuses', c => store.transaction(async () => {
		const result: Json = {};
		for (const name of ['home', 'notifications']) if (c.body[name]) {
			const old = await store.get<Json>('marker', c.userId, name);
			result[name] = { last_read_id: string(c.body[name].last_read_id), version: (old?.version ?? 0) + 1, updated_at: new Date().toISOString() }; await store.put('marker', c.userId, name, result[name]);
		}
		return result;
	}));
}
