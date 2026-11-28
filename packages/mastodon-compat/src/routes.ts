/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import * as mfm from 'mfm-js';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { EntityConverter } from './entities.js';
import { NativeClient, NativeError } from './native-client.js';
import { getAuthorization } from './oauth.js';
import { allowsScope, assertScope, toNativePermissions } from './scopes.js';
import { CompatStore, type Grant } from './store.js';
import { array, boolean, compareIds, HttpError, integer, pageRows, pagination, string, strings } from './parameters.js';
import type { Json } from './types.js';
import { applyFilters, type FilterContext } from './features.js';
import { description as mediaDescription, focalPoint as mediaFocalPoint } from './media-search.js';
import { collectNoteUserIds, decorateStatus, hydrateStatus, liveReblog, preloadedStatusStore, statusStoreKeys, type StatusStore } from './metadata.js';

export interface RouteDependencies { native: NativeClient; entities: EntityConverter; store: CompatStore; publicUrl: string; }
export interface RequestContext {
	request: FastifyRequest; reply: FastifyReply; grant?: Grant; userId: string; query: Json; body: Json; params: Json;
	call: <T = Json>(endpoint: string, body?: Json) => Promise<T>;
}
export type RouteHandler = (context: RequestContext) => unknown | Promise<unknown>;

export class Routes {
	private readonly readCache = new WeakMap<RequestContext, Map<string, Promise<Json>>>();
	constructor(readonly app: FastifyInstance, readonly deps: RouteDependencies) {}
	add(method: HTTPMethods, url: string, scope: string | undefined, handler: RouteHandler, optional = false): void {
		this.app.route({ method, url, handler: async (request, reply) => {
			const grant = await getAuthorization(request, this.deps.store);
			if (!optional && (!grant || grant.kind !== 'user')) throw new HttpError(401, 'A user access token is required');
			if (grant && scope && !(scope === 'read:accounts' && allowsScope(grant.scopes, 'profile'))) assertScope(grant.scopes, scope);
			const verified = grant?.nativeToken ? this.deps.native.call('ping', {}, grant.nativeToken, { ip: request.ip }) : undefined;
			const run = () => handler({ request, reply, grant, userId: grant?.userId ?? '', query: request.query as Json, body: (request.body ?? {}) as Json, params: request.params as Json,
				call: <T>(endpoint: string, body: Json = {}) => this.deps.native.call<T>(endpoint, body, grant?.nativeToken, { ip: request.ip, userAgent: request.headers['user-agent'] }),
			});
			if (verified == null) return run();
			if (method !== 'GET') {
				await verified;
				return run();
			}
			const result = Promise.resolve().then(run);
			result.catch(() => {});
			await verified;
			return result;
		} });
	}
	async status(note: Json, context: RequestContext): Promise<Json> {
		const { mentions } = collectNoteUserIds([note]);
		const mentionUsers = mentions.length ? await this.prefetchUsers(context, mentions) : undefined;
		const status = this.deps.entities.status(note, { viewerId: context.userId || null, allowLocalOnly: true, mentionUsers });
		if (!status) throw new HttpError(404, 'Record not found');
		return this.completeStatus(status, context, this.deps.store);
	}
	private async completeStatus(status: Json, context: RequestContext, store: StatusStore): Promise<Json> {
		const path = context.request.routeOptions?.url ?? new URL(context.request.url, 'http://localhost').pathname;
		const filterContext: FilterContext = path.includes('/timelines/home') || path.includes('/timelines/list/') ? 'home' : path.includes('/accounts/') ? 'account' : path.includes('/notifications') ? 'notifications' : path.includes('/statuses/') ? 'thread' : 'public';
		const readAccount = !!context.grant && toNativePermissions(context.grant.scopes).includes('read:account');
		const decorated = await decorateStatus(store, status, context.userId);
		const hydrated = await hydrateStatus(store, decorated, context.userId || undefined, readAccount, (endpoint, body) => this.cachedRead(context, endpoint, body));
		return applyFilters(store, context.userId, hydrated, filterContext);
	}
	async statuses(notes: Json[], context: RequestContext): Promise<Json[]> {
		const { authors: rawAuthors, mentions } = collectNoteUserIds(notes);
		const mentionUsers = mentions.length ? await this.prefetchUsers(context, [...new Set([...rawAuthors, ...mentions])]) : undefined;
		const statuses = notes.flatMap(note => {
			const status = this.deps.entities.status(note, { viewerId: context.userId || null, allowLocalOnly: true, mentionUsers });
			return status ? [status] : [];
		});
		if (statuses.length === 0) return [];
		const { keys, authors } = statusStoreKeys(statuses, context.userId || undefined);
		const [entries, filters] = await Promise.all([
			this.deps.store.getMany(keys),
			context.userId ? this.deps.store.list('filter', context.userId) : [],
			mentionUsers ? Promise.resolve() : this.prefetchUsers(context, authors),
		]);
		const store = preloadedStatusStore(this.deps.store, entries, filters);
		const result: Array<Json | null> = Array(statuses.length).fill(null);
		let next = 0;
		let failed = false;
		await Promise.all(Array.from({ length: Math.min(4, statuses.length) }, async () => {
			for (let index = next++; !failed && index < statuses.length; index = next++) {
				try { result[index] = await this.completeStatus(statuses[index], context, store); } catch (error) {
					if (!(error instanceof HttpError && error.statusCode === 404) && !(error instanceof NativeError && (error.status === 404 || error.code === 'NO_SUCH_NOTE' || error.code === 'NO_SUCH_USER'))) {
						failed = true;
						throw error;
					}
				}
			}
		}));
		return result.filter((status): status is Json => status !== null);
	}
	private async prefetchUsers(context: RequestContext, ids: string[]): Promise<Map<string, Json>> {
		const resolved = new Map<string, Json>();
		if (!ids.length) return resolved;
		let cache = this.readCache.get(context);
		if (!cache) { cache = new Map(); this.readCache.set(context, cache); }
		const missing: string[] = [];
		const cachedPromises: Array<[string, Promise<Json>]> = [];
		for (const id of new Set(ids)) {
			const existing = cache.get(`users/show:${JSON.stringify({ userId: id })}`);
			if (existing) cachedPromises.push([id, existing]);
			else missing.push(id);
		}
		if (cachedPromises.length) {
			await Promise.all(cachedPromises.map(async ([id, promise]) => {
				try { resolved.set(id, await promise); } catch {}
			}));
		}
		for (let offset = 0; offset < missing.length; offset += 100) {
			const chunk = missing.slice(offset, offset + 100);
			const users = await context.call<Json[]>('users/show', { userIds: chunk });
			for (const user of users) {
				const uid = String(user.id);
				resolved.set(uid, user);
				cache.set(`users/show:${JSON.stringify({ userId: uid })}`, Promise.resolve(user));
			}
		}
		return resolved;
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
	for (const version of [1, 2] as const) add('GET', `/api/v${version}/instance`, undefined, async c => {
		const vary = c.reply.getHeader('Vary');
		if (vary !== '*') c.reply.header('Vary', vary ? `${vary}, User-Agent` : 'User-Agent');
		const versionStyle = /^neodb\//i.test(c.request.headers['user-agent'] ?? '') ? 'neodb' : 'compatible';
		return entities.instance(await meta(), await native.call('stats', {}), version, versionStyle);
	}, true);
	add('GET', '/api/v1/instance/rules', undefined, async () => array((await meta()).serverRules).map((text, index) => ({ id: String(index + 1), text, hint: '' })), true);
	add('GET', '/api/v1/custom_emojis', undefined, async () => array((await native.call<Json>('emojis', {})).emojis).map(item => ({ shortcode: item.name, url: item.url, static_url: item.url, visible_in_picker: true, category: item.category ?? '' })), true);
	if (!app.hasRoute({ method: 'GET', url: '/api/v1/instance/peers' })) add('GET', '/api/v1/instance/peers', undefined, async c => (await c.call<Json[]>('federation/instances', { limit: 100 })).map(item => item.host), true);
	add('GET', '/api/v1/streaming/health', undefined, () => 'OK', true);
	add('GET', '/api/v1/directory', undefined, async c => (await c.call<Json[]>('users', { limit: integer(c.query.limit, 40, 1, 80), offset: integer(c.query.offset, 0), sort: c.query.order === 'new' ? '+createdAt' : '+updatedAt', state: 'alive', origin: boolean(c.query.local) ? 'local' : 'combined' })).map(account), true);
	for (const path of ['/api/v1/trends', '/api/v1/trends/tags']) add('GET', path, undefined, async c => (await c.call<Json[]>('hashtags/trend')).map(item => tag(item.tag)), true);
	add('GET', '/api/v1/trends/statuses', 'read:statuses', async c => routes.statuses(await c.call('notes/featured', { limit: integer(c.query.limit, 20, 1, 40) }), c), true);
	for (const version of [1, 2] as const) add('GET', `/api/v${version}/suggestions`, 'read:accounts', async c => (await c.call<Json[]>('users/recommendation', { limit: integer(c.query.limit, 40, 1, 80), offset: 0 })).map(user => version === 1 ? account(user) : { source: 'global', sources: ['most_followed'], account: account(user) }));
	add('GET', '/api/v1/accounts/verify_credentials', 'read:accounts', async c => {
		const result = entities.account(await c.call('i'), true);
		result.source = { ...result.source, ...await store.get<Json>('account-source', c.userId, 'defaults') };
		return result;
	});
	add('GET', '/api/v1/accounts/relationships', 'read:follows', async c => {
		const ids = [...new Set(strings(c.query.id))];
		if (ids.length > 100) throw new HttpError(422, 'Too many account IDs');
		if (!ids.length) return [];
		const [users, notes] = await Promise.all([
			c.call<Json[]>('users/show', { userIds: ids }),
			store.getMany(ids.map(id => ({ namespace: 'account-note', owner: c.userId, key: id }))),
		]);
		const noteMap = new Map(notes.map(entry => [entry.key, entry.value]));
		const userMap = new Map(users.map(user => [string(user.id), user]));
		return ids.flatMap(id => {
			const user = userMap.get(id);
			return user ? [{ ...entities.relationship(user), note: noteMap.get(id) ?? '' }] : [];
		});
	});
	add('GET', '/api/v1/accounts/search', 'read:accounts', async c => {
		const q = string(c.query.q).trim();
		if (!q) return [];
		const limit = integer(c.query.limit, 40, 1, 80);
		const offset = integer(c.query.offset, 0, 0, 1000);
		const resolve = boolean(c.query.resolve);
		const following = boolean(c.query.following);
		const localHost = new URL(publicUrl).host.toLowerCase();
		const resolveSafe = async (call: () => Promise<Json>): Promise<Json | undefined> => {
			try { return await call(); } catch (error) {
				if (error instanceof NativeError && ['NO_SUCH_USER', 'NO_SUCH_OBJECT', 'URI_INVALID', 'REQUEST_FAILED', 'FAILED_TO_RESOLVE_REMOTE_USER'].includes(error.code)) return undefined;
				throw error;
			}
		};
		if (resolve && /^https?:\/\//iu.test(q)) {
			if (offset > 0) return [];
			const resolved = await resolveSafe(() => c.call('ap/show', { uri: q }));
			return resolved?.type === 'User' && (!following || resolved.object.isFollowing === true) ? [account(resolved.object)] : [];
		}
		let users = await c.call<Json[]>('users/search', { query: q, offset, limit, origin: 'combined', detail: true });
		if (resolve && offset === 0 && /^@?[^@\s]+@[^@\s]+$/u.test(q)) {
			const [username, rawHost] = q.replace(/^@/u, '').split('@');
			const host = rawHost && rawHost.toLowerCase() !== localHost ? rawHost : null;
			const resolved = await resolveSafe(() => c.call('users/show', { username, host }));
			if (resolved && !users.some(item => item.id === resolved.id)) users = [resolved, ...users].slice(0, limit);
		}
		if (following) users = users.filter(item => item.isFollowing === true);
		return users.map(account);
	});
	add('GET', '/api/v1/accounts/lookup', 'read:accounts', async c => {
		const [username, host] = string(c.query.acct).replace(/^@/u, '').split('@');
		const localHost = new URL(publicUrl).host.toLowerCase();
		return account(await c.call('users/show', { username, host: host && host.toLowerCase() !== localHost ? host : null }));
	}, true);
	add('GET', '/api/v1/accounts/:id', 'read:accounts', async c => account(await c.call('users/show', { userId: c.params.id })), true);
	add('GET', '/api/v1/accounts/:id/statuses', 'read:statuses', async c => {
		const onlyMedia = boolean(c.query.only_media), excludeReplies = boolean(c.query.exclude_replies), excludeReblogs = boolean(c.query.exclude_reblogs);
		const tagged = c.query.tagged ? string(c.query.tagged).replace(/^#/u, '').normalize('NFKC').toLowerCase() : '';
		const matches = (item: Json) => (!excludeReplies || !item.replyId)
			&& (!excludeReblogs || !item.renoteId || item.text || item.cw || array(item.files).length || item.poll)
			&& (!onlyMedia || array(item.files).length)
			&& (!tagged || array(item.tags).some((value: unknown) => typeof value === 'string' && value.normalize('NFKC').toLowerCase() === tagged));
		if (boolean(c.query.pinned)) {
			const notes = pageRows(array((await c.call('users/show', { userId: c.params.id })).pinnedNotes), c.query);
			return routes.page(c, notes, await routes.statuses(notes.filter(matches), c));
		}
		const needsScan = (onlyMedia && !excludeReplies) || Boolean(tagged);
		if (!needsScan) {
			const notes = await routes.readPage(c, 'users/notes', { userId: c.params.id, withReplies: !excludeReplies, withRenotes: !excludeReblogs, withFiles: onlyMedia && excludeReplies });
			return routes.page(c, notes, await routes.statuses(notes.filter(matches), c));
		}
		const targetLimit = integer(c.query.limit, 20, 1, 80);
		const forwardOnly = Boolean(c.query.min_id);
		let cursorQuery: Json = { ...c.query };
		const scanned: Json[] = [];
		const matched: Json[] = [];
		const seenIds = new Set<string>();
		for (let page = 0; page < 10 && matched.length < targetLimit; page++) {
			const batchSize = Math.min(80, Math.max(targetLimit - matched.length, 40));
			const rows = await c.call<Json[]>('users/notes', {
				...pagination({ ...cursorQuery, limit: batchSize }, batchSize, 80),
				userId: c.params.id,
				withReplies: !excludeReplies,
				withRenotes: !excludeReblogs,
				withFiles: onlyMedia && excludeReplies,
			});
			if (!rows.length) break;
			const ordered = pageRows(rows, { ...cursorQuery, limit: batchSize }, item => string(item.id), batchSize, 80);
			if (!ordered.length) break;
			const stream = forwardOnly ? [...ordered].reverse() : ordered;
			for (const item of stream) {
				const itemId = string(item.id);
				if (seenIds.has(itemId)) continue;
				seenIds.add(itemId);
				scanned.push(item);
				if (matches(item)) {
					matched.push(item);
					if (matched.length >= targetLimit) break;
				}
			}
			if (matched.length >= targetLimit || rows.length < batchSize) break;
			const boundary = string(stream.at(-1)!.id);
			cursorQuery = forwardOnly ? { ...cursorQuery, min_id: boundary } : { ...cursorQuery, max_id: boundary };
		}
		matched.sort((a, b) => compareIds(string(b.id), string(a.id)));
		return routes.page(c, scanned, await routes.statuses(matched, c));
	}, true);
	for (const direction of ['followers', 'following']) add('GET', `/api/v1/accounts/:id/${direction}`, 'read:follows', async c => {
		const rows = await routes.readPage(c, `users/${direction}`, { userId: c.params.id });
		return routes.page(c, rows, rows.map(row => account(row[direction === 'followers' ? 'follower' : 'followee'])));
	}, true);
	for (const [action, endpoint, scope] of [
		['follow', 'following/create', 'follows'], ['unfollow', 'following/delete', 'follows'], ['block', 'blocking/create', 'blocks'], ['unblock', 'blocking/delete', 'blocks'], ['mute', 'mute/create', 'mutes'], ['unmute', 'mute/delete', 'mutes'], ['remove_from_followers', 'following/invalidate', 'follows'],
	]) add('POST', `/api/v1/accounts/:id/${action}`, `write:${scope}`, async c => {
		const muteDuration = action === 'mute' ? integer(c.body.duration, 0) : 0;
		await c.call(endpoint, { userId: c.params.id, ...(muteDuration > 0 ? { expiresAt: Date.now() + muteDuration * 1000 } : {}) }).catch(error => {
			if (!(error instanceof NativeError && ['ALREADY_FOLLOWING', 'ALREADY_BLOCKING', 'ALREADY_MUTING', 'NOT_FOLLOWING', 'NOT_BLOCKING', 'NOT_MUTING'].includes(error.code))) throw error;
		});
		if (action === 'follow' && (c.body.notify !== undefined || c.body.reblogs !== undefined)) {
			const relation = await c.call('users/show', { userId: c.params.id });
			if (c.body.notify !== undefined && relation.isFollowing === true) {
				await c.call('following/update', { userId: c.params.id, notify: boolean(c.body.notify) ? 'normal' : 'none' }).catch(error => {
					if (!(error instanceof NativeError && error.code === 'NOT_FOLLOWING')) throw error;
				});
			}
			if (c.body.reblogs !== undefined) {
				const showReblogs = boolean(c.body.reblogs);
				const currentlyShowing = relation.isRenoteMuted !== true;
				if (showReblogs !== currentlyShowing) {
					await c.call(showReblogs ? 'renote-mute/delete' : 'renote-mute/create', { userId: c.params.id }).catch(error => {
						if (!(error instanceof NativeError && ['ALREADY_MUTING', 'NOT_MUTING'].includes(error.code))) throw error;
					});
				}
			}
		}
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
			const parameters = { ...(path.startsWith('tag') ? { tag: c.params.tag, localHostOnly: boolean(c.query.local), publicOnly: true } : {}), ...(path.startsWith('list') ? { listId: c.params.id } : {}), withFiles: boolean(c.query.only_media) };
			const selected = path === 'public' && boolean(c.query.local) ? 'notes/local-timeline' : endpoint;
			const notes = await routes.readPage(c, selected, parameters);
			const filtered = notes.filter(note => (!path.startsWith('tag') || note.visibility === 'public') && (!boolean(c.query.remote) || note.user?.host) && (!boolean(c.query.only_media) || array(note.files).length));
			return routes.page(c, notes, await routes.statuses(filtered, c));
		}, path === 'public' || path.startsWith('tag'));
	}
	add('GET', '/api/v1/statuses', 'read:statuses', async c => {
		const ids = [...new Set(strings(c.query.id))];
		if (ids.length > 100) throw new HttpError(422, 'Too many status IDs');
		const notes = (await Promise.all(ids.map(async id => {
			try { return await routes.note(c, id); } catch (error) {
				if (error instanceof NativeError && (error.status === 403 || error.status === 404 || error.code === 'NO_SUCH_NOTE')) return null;
				throw error;
			}
		}))).filter((item): item is Json => item !== null);
		return routes.statuses(notes, c);
	}, true);
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
		if (c.body.visibility !== undefined && visibility(c.body.visibility) !== note.visibility) throw new HttpError(422, 'This status property cannot be edited');
		if (c.body.in_reply_to_id !== undefined && (c.body.in_reply_to_id === null || c.body.in_reply_to_id === '' ? null : string(c.body.in_reply_to_id)) !== (note.replyId ?? null)) throw new HttpError(422, 'This status property cannot be edited');
		if (c.body.local_only !== undefined && boolean(c.body.local_only) !== (note.localOnly === true)) throw new HttpError(422, 'This status property cannot be edited');
		validateQuoteApprovalPolicy(c.body.quote_approval_policy, note.visibility);
		const targetFileIds = c.body.media_ids !== undefined ? (prepared.native.fileIds ?? []) : array(note.files).map((file: Json) => string(file.id));
		const fileComments: Array<{ fileId: string; comment: string | null }> = [];
		for (const attr of prepared.mediaAttributes) {
			if (!targetFileIds.includes(attr.id)) throw new HttpError(422, 'media_attributes must reference attached media');
			if (attr.description !== undefined) {
				fileComments.push({ fileId: attr.id, comment: attr.description.length > 0 ? attr.description : null });
			}
		}
		const body = {
			noteId: note.id,
			text: c.body.status === undefined ? note.text : prepared.native.text,
			cw: c.body.spoiler_text === undefined ? note.cw : prepared.native.cw,
			...(c.body.media_ids !== undefined ? { fileIds: prepared.native.fileIds ?? [] } : {}),
			...(fileComments.length ? { fileComments } : {}),
		};
		if (note.renoteId && !body.text?.trim() && !(body.fileIds ?? note.files)?.length && !note.poll) body.text = (await quoteTarget(routes, c, note.renoteId)).url;
		await c.call('notes/update', body).catch(error => {
			if (error instanceof NativeError && error.code === 'NO_SUCH_FILE') throw new HttpError(404, 'Record not found');
			throw error;
		});
		await store.transaction(async () => {
			await store.put('status', c.userId, note.id, { ...await store.get<Json>('status', c.userId, note.id), ...prepared.metadata });
			for (const attr of prepared.mediaAttributes) {
				if (attr.focus === null) await store.delete('media', c.userId, attr.id);
				else if (attr.focus !== undefined) await store.put('media', c.userId, attr.id, { focus: attr.focus });
			}
		});
		return routes.status(await routes.note(c), c);
	});
	for (const [action, endpoint] of [['reblog', 'notes/create'], ['unreblog', 'notes/unrenote']]) add('POST', `/api/v1/statuses/:id/${action}`, 'write:statuses', async c => {
		const selectedVisibility = action === 'reblog' ? visibility(c.body.visibility) : undefined;
		const note = await routes.note(c);
		if (action === 'reblog') {
			let existing = await liveReblog(store, c.userId, note.id, c.call);
			if (!existing && c.grant && toNativePermissions(c.grant.scopes).includes('read:account')) {
				const state = await c.call('notes/state', { noteId: note.id });
				if (typeof state.myRenoteId === 'string' && state.myRenoteId) {
					existing = state.myRenoteId;
					await store.put('reblog', c.userId, note.id, existing);
				}
			}
			let reblogNote: Json;
			if (existing) {
				reblogNote = await routes.note(c, existing);
			} else {
				const result = await c.call(endpoint, { renoteId: note.id, visibility: selectedVisibility });
				reblogNote = result.createdNote;
				await store.put('reblog', c.userId, note.id, reblogNote.id);
			}
			const status = await routes.status(reblogNote.renote ? reblogNote : { ...reblogNote, renote: note }, c);
			return status.reblog ? { ...status, reblog: { ...status.reblog, reblogged: true } } : { ...status, reblogged: true };
		}
		await c.call(endpoint, { noteId: note.id });
		await store.delete('reblog', c.userId, note.id);
		return { ...await routes.status(await routes.note(c), c), reblogged: false };
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
		await c.call(endpoint, { noteId: c.params.id }).catch(error => { if (!(error instanceof NativeError && ['ALREADY_FAVORITED', 'NOT_FAVORITED', 'ALREADY_PINNED', 'NOT_PINNED', 'ALREADY_MUTED', 'ALREADY_MUTING', 'NOT_MUTED'].includes(error.code))) throw error; });
		return { ...await routes.status(await routes.note(c), c), [field]: !action.startsWith('un') };
	});
	for (const [suffix, endpoint] of [['reblogged_by', 'notes/renotes'], ['favourited_by', 'notes/reactions']]) add('GET', `/api/v1/statuses/:id/${suffix}`, 'read:statuses', async c => {
		await routes.note(c);
		const rows = await routes.readPage(c, endpoint, { noteId: c.params.id, ...(suffix === 'favourited_by' ? { type: '❤' } : {}) });
		const filtered = suffix === 'favourited_by' ? rows.filter(item => ['❤', '❤️'].includes(item.type)) : rows;
		return routes.page(c, rows, filtered.map(item => account(item.user)));
	}, true);
	add('GET', '/api/v1/bookmarks', 'read:bookmarks', async c => { const rows = await routes.readPage(c, 'i/favorites'); return routes.page(c, rows, (await routes.statuses(rows.map(item => item.note), c)).map(status => ({ ...status, bookmarked: true }))); });
	add('GET', '/api/v1/favourites', 'read:favourites', async c => { const rows = await routes.readPage(c, 'users/reactions', { userId: c.userId, type: '❤' }); return routes.page(c, rows, await routes.statuses(rows.filter(row => ['❤', '❤️'].includes(row.type)).map(row => row.note), c)); });
	add('POST', '/api/v1/reports', 'write:reports', async c => {
		const accountId = string(c.body.account_id).trim();
		if (!accountId) throw new HttpError(422, 'account_id is required');
		const category = string(c.body.category, 'other');
		if (!['spam', 'legal', 'violation', 'other'].includes(category)) throw new HttpError(422, 'Invalid report category');
		const rawComment = string(c.body.comment).trim();
		const statusIds = strings(c.body.status_ids).filter(Boolean);
		const ruleIds = strings(c.body.rule_ids).filter(Boolean);
		const target = await c.call('users/show', { userId: accountId });
		const parts = [
			`[${category}]`,
			rawComment,
			statusIds.length ? `Statuses: ${statusIds.join(', ')}` : '',
			ruleIds.length ? `Rules: ${ruleIds.join(', ')}` : '',
		].filter(Boolean);
		const reportComment = parts.join('\n') || 'Reported via Mastodon API';
		if (reportComment.length > 2048) throw new HttpError(422, 'Report comment exceeds maximum length');
		const created = await c.call<Json>('users/report-abuse', { userId: target.id, comment: reportComment });
		if (!created || typeof created.id !== 'string' || !created.id) throw new NativeError(502, 'INVALID_NATIVE_RESPONSE', 'The native API did not return the created report');
		return {
			id: created.id,
			action_taken: false,
			action_taken_at: null,
			category,
			comment: rawComment,
			forwarded: false,
			created_at: new Date().toISOString(),
			status_ids: statusIds.length ? statusIds : null,
			rule_ids: ruleIds.length ? ruleIds : null,
			target_account: account(target),
		};
	});
	add('GET', '/api/v1/polls/:id', 'read:statuses', async c => { const note = await routes.note(c); if (!note.poll) throw new HttpError(404, 'Record not found'); return entities.poll(note); }, true);
	add('POST', '/api/v1/polls/:id/votes', 'write:statuses', async c => {
		const note = await routes.note(c); if (!note.poll) throw new HttpError(404, 'Record not found');
		const choices = strings(c.body.choices).map(value => integer(value, -1, 0, note.poll.choices.length - 1));
		if (!choices.length || new Set(choices).size !== choices.length || (!note.poll.multiple && choices.length !== 1)) throw new HttpError(422, 'Invalid poll choices');
		const pending = choices.filter(choice => !note.poll.choices[choice].isVoted);
		if (pending.length) await c.call('notes/polls/vote', { noteId: note.id, choices: pending });
		return entities.poll(await routes.note(c));
	});
	const validateListPolicy = (body: Json): void => {
		if ((body.exclusive !== undefined && body.exclusive !== '' && boolean(body.exclusive)) || (body.replies_policy !== undefined && body.replies_policy !== '' && string(body.replies_policy) !== 'list')) {
			throw new HttpError(422, 'This list policy is unavailable');
		}
	};
	add('GET', '/api/v1/lists', 'read:lists', async c => (await c.call<Json[]>('users/lists/list')).map(list));
	add('POST', '/api/v1/lists', 'write:lists', async c => { validateListPolicy(c.body); return list(await c.call('users/lists/create', { name: string(c.body.title) })); });
	add('GET', '/api/v1/lists/:id', 'read:lists', async c => list(await c.call('users/lists/show', { listId: c.params.id })));
	add('PUT', '/api/v1/lists/:id', 'write:lists', async c => { validateListPolicy(c.body); return list(await c.call('users/lists/update', { listId: c.params.id, name: string(c.body.title) })); });
	add('DELETE', '/api/v1/lists/:id', 'write:lists', async c => { await c.call('users/lists/delete', { listId: c.params.id }); return {}; });
	add('GET', '/api/v1/lists/:id/accounts', 'read:lists', async c => {
		const item = await c.call('users/lists/show', { listId: c.params.id });
		const pagedRows = pageRows(strings(item.userIds).map(id => ({ id })), c.query, row => string(row.id), 40, 80);
		const pagedIds = pagedRows.map(row => string(row.id));
		if (!pagedIds.length) return [];
		const users = await c.call<Json[]>('users/show', { userIds: pagedIds });
		const userMap = new Map(users.map(user => [string(user.id), user]));
		const accounts = pagedIds.flatMap(id => {
			const user = userMap.get(id);
			return user ? [account(user)] : [];
		});
		return routes.page(c, pagedRows, accounts);
	});
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
	if (policy !== 'public' && !['followers', 'specified'].includes(nativeVisibility)) throw new HttpError(422, 'Only public quote approval is supported for public or unlisted statuses');
}

type MediaAttributePatch = { id: string; description?: string; focus?: { x: number; y: number } | null };

function parseMediaAttributes(value: unknown): MediaAttributePatch[] {
	if (value == null || value === '') return [];
	if (typeof value !== 'object') throw new HttpError(422, 'Invalid media_attributes');
	const raw = Array.isArray(value)
		? value
		: Object.entries(value as Json).sort(([a], [b]) => Number(a) - Number(b)).map(([, item]) => item);
	if (raw.length > 16) throw new HttpError(422, 'Too many media_attributes');
	const seen = new Set<string>();
	return raw.map(item => {
		if (item == null || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(422, 'Invalid media_attributes entry');
		const id = string((item as Json).id);
		if (!id || seen.has(id)) throw new HttpError(422, 'Invalid media_attributes id');
		seen.add(id);
		if ((item as Json).thumbnail !== undefined) throw new HttpError(422, 'Custom thumbnails are unavailable');
		const patch: MediaAttributePatch = { id };
		if ((item as Json).description !== undefined) {
			patch.description = (item as Json).description === null ? '' : mediaDescription((item as Json).description);
		}
		if ((item as Json).focus !== undefined) {
			patch.focus = (item as Json).focus === null || (item as Json).focus === '' ? null : mediaFocalPoint((item as Json).focus);
		}
		return patch;
	});
}

function prepareStatusInput(input: Json, defaults: Json = {}, editing = false): { native: Json; metadata: Json; mediaAttributes: MediaAttributePatch[] } {
	const text = (value: unknown, name: string): string | null => {
		if (value == null || value === '') return null;
		if (typeof value !== 'string') throw new HttpError(422, `${name} must be a string`);
		return value;
	};
	if (input.scheduled_at != null && input.scheduled_at !== '') throw new HttpError(422, 'scheduled_at is unavailable through this gateway');
	if (!editing && input.media_attributes != null && input.media_attributes !== '' && (!Array.isArray(input.media_attributes) || input.media_attributes.length)) {
		throw new HttpError(422, 'media_attributes is unavailable through this gateway');
	}
	const mediaAttributes = editing ? parseMediaAttributes(input.media_attributes) : [];
	if (editing && input.poll !== undefined) throw new HttpError(422, 'This status property cannot be edited');
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
		if (ids.length || editing) native.fileIds = ids;
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
	return { native, metadata, mediaAttributes };
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
		if (!body.text?.trim() && !body.cw && !body.fileIds?.length && !body.poll && !body.replyId) body.text = quoted.url;
	}
	if (body.visibility === 'specified') {
		const localHost = new URL(routes.deps.publicUrl).host.toLowerCase();
		const mentions = extractMentions(mfm.parse(string(body.text)));
		const seen = new Set<string>();
		const uniqueMentions = mentions
			.map(m => ({ username: m.username, host: m.host && m.host.toLowerCase() !== localHost ? m.host : null }))
			.filter(m => {
				const key = `${m.username.toLowerCase()}@${m.host?.toLowerCase() ?? ''}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		const resolvedMentions = await Promise.all(uniqueMentions.map(async m => {
			try {
				return string((await c.call('users/show', { username: m.username, host: m.host })).id);
			} catch (error) {
				if (error instanceof NativeError && ['NO_SUCH_USER', 'FAILED_TO_RESOLVE_REMOTE_USER'].includes(error.code)) return null;
				throw error;
			}
		}));
		const ids = resolvedMentions.filter((id): id is string => id !== null);
		if (quoted && quoted.account.id !== c.userId && !ids.includes(quoted.account.id)) throw new HttpError(422, 'A direct quote must explicitly mention the quoted author');
		if (body.replyId) { const reply = await routes.note(c, body.replyId); ids.push(reply.userId); }
		body.visibleUserIds = [...new Set(ids)].filter(id => id !== c.userId);
		if (!body.visibleUserIds.length) throw new HttpError(422, 'A direct status needs a recipient mention');
	}
	const claimedReplay = key ? await (async () => {
		const claim = await store.claimIdempotency(c.userId, key, { digest, expiresAt: Date.now() + 86400000 });
		if (claim.status === 'claimed') return undefined;
		if (claim.status === 'retry') throw new HttpError(409, 'This request is already being processed; check the timeline before retrying');
		if (claim.entry.digest !== digest) throw new HttpError(422, 'Idempotency key was used for a different request');
		if (!claim.entry.id) throw new HttpError(409, 'This request is already being processed; check the timeline before retrying');
		return string(claim.entry.id);
	})() : undefined;
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
	const pending = [rootId], seen = new Set(pending), notes: Json[] = [];
	let requests = 0;
	while (pending.length && notes.length < 100 && requests < 200) {
		const parentId = pending.shift()!;
		let untilId: string | undefined;
		while (notes.length < 100 && requests++ < 200) {
			const rows = await context.call<Json[]>('notes/children', { noteId: parentId, limit: 100, ...(untilId ? { untilId } : {}) });
			for (const note of rows) {
				if (note.replyId !== parentId || seen.has(note.id)) continue;
				seen.add(note.id);
				if (!routes.deps.entities.status(note, { viewerId: context.userId || null, allowLocalOnly: true })) continue;
				notes.push(note);
				pending.push(note.id);
				if (notes.length >= 100) break;
			}
			if (rows.length < 100) break;
			const oldest = rows.map(row => string(row.id)).sort(compareIds)[0];
			if (!oldest || (untilId && compareIds(oldest, untilId) >= 0)) break;
			untilId = oldest;
		}
	}
	return routes.statuses(notes, context);
}

function extractMentions(nodes: mfm.MfmNode[]): { username: string; host: string | null }[] {
	const result: { username: string; host: string | null }[] = [];
	for (const node of nodes) {
		if (node.type === 'mention') {
			result.push({ username: node.props.username, host: node.props.host });
		} else if ('children' in node && Array.isArray(node.children)) {
			result.push(...extractMentions(node.children));
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
