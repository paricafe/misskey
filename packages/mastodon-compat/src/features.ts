/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { decorateStatus } from './metadata.js';
import { NativeError } from './native-client.js';
import type { EntityConverter } from './entities.js';
import { array, boolean, HttpError, integer, string, strings } from './parameters.js';
import type { Routes, RequestContext } from './routes.js';
import type { CompatStore } from './store.js';
import type { Json } from './types.js';

export type FilterContext = 'home' | 'notifications' | 'public' | 'thread' | 'account';
interface FilterKeyword { id: string; keyword: string; whole_word: boolean; }
interface FilterStatus { id: string; status_id: string; }
interface Filter {
	id: string;
	title: string;
	context: FilterContext[];
	expires_at: string | null;
	filter_action: 'warn' | 'hide' | 'blur';
	keywords: FilterKeyword[];
	statuses: FilterStatus[];
}
interface ConversationState { readThrough?: string; hiddenThrough?: string; latestId?: string; }
type NativeCall = <T = Json>(endpoint: string, body?: Json) => Promise<T>;

const CONTEXTS = new Set<FilterContext>(['home', 'notifications', 'public', 'thread', 'account']);
const newId = (): string => randomBytes(8).readBigUInt64BE().toString();
const compareIds = (a: string, b: string): number => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

function requiredText(value: unknown, label: string, max = 256): string {
	const result = string(value).trim();
	if (!result || result.length > max) throw new HttpError(422, `${label} must contain between 1 and ${max} characters`);
	return result;
}

function filterContexts(value: unknown): FilterContext[] {
	const contexts = [...new Set(strings(value))] as FilterContext[];
	if (!contexts.length || contexts.some(context => !CONTEXTS.has(context))) throw new HttpError(422, 'Invalid filter context');
	return contexts;
}

function expiration(value: unknown, previous: string | null, now = Date.now()): string | null {
	if (value === undefined) return previous;
	if (value === null || value === '') return null;
	return new Date(now + integer(value, 0, 0, 315360000) * 1000).toISOString();
}

function attributes(value: unknown): Json[] {
	if (value == null) return [];
	if (Array.isArray(value)) {
		if (value.some(item => !object(item))) throw new HttpError(422, 'Invalid keyword attributes');
		return value;
	}
	if (!object(value)) throw new HttpError(422, 'Invalid keyword attributes');
	if (Object.keys(value).every(key => /^\d+$/u.test(key))) return Object.entries(value).sort(([a], [b]) => Number(a) - Number(b)).map(([, item]) => {
		if (!object(item)) throw new HttpError(422, 'Invalid keyword attributes');
		return item;
	});
	const size = Math.max(1, ...Object.values(value).map(item => Array.isArray(item) ? item.length : 1));
	return Array.from({ length: size }, (_, index) => Object.fromEntries(Object.entries(value)
		.map(([key, item]) => [key, Array.isArray(item) ? item[index] : index === 0 ? item : undefined])
		.filter(([, item]) => item !== undefined)));
}

function updateKeywords(filter: Filter, value: unknown): FilterKeyword[] {
	let keywords = filter.keywords.map(item => ({ ...item }));
	const seen = new Set<string>();
	for (const entry of attributes(value)) {
		const id = string(entry.id);
		if (id) {
			const existing = keywords.find(keyword => keyword.id === id);
			if (!existing) throw new HttpError(404, 'Record not found');
			if (seen.has(id)) throw new HttpError(422, 'Duplicate keyword identifier');
			seen.add(id);
			if (boolean(entry._destroy)) keywords = keywords.filter(keyword => keyword.id !== id);
			else {
				if (entry.keyword !== undefined) existing.keyword = requiredText(entry.keyword, 'Keyword', 400);
				if (entry.whole_word !== undefined) existing.whole_word = boolean(entry.whole_word);
			}
		} else if (!boolean(entry._destroy)) {
			keywords.push({ id: newId(), keyword: requiredText(entry.keyword, 'Keyword', 400), whole_word: boolean(entry.whole_word) });
		}
	}
	if (keywords.length > 100) throw new HttpError(422, 'A filter may contain at most 100 keywords');
	return keywords;
}

function updatedFilter(body: Json, existing?: Filter): Filter {
	const filter: Filter = existing ? structuredClone(existing) : { id: newId(), title: '', context: [], expires_at: null, filter_action: 'warn', keywords: [], statuses: [] };
	if (!existing || body.title !== undefined) filter.title = requiredText(body.title, 'Title');
	if (!existing || body.context !== undefined) filter.context = filterContexts(body.context);
	filter.expires_at = expiration(body.expires_in, filter.expires_at);
	if (body.filter_action !== undefined) {
		if (!['warn', 'hide', 'blur'].includes(body.filter_action)) throw new HttpError(422, 'Invalid filter action');
		filter.filter_action = body.filter_action;
	}
	filter.keywords = updateKeywords(filter, body.keywords_attributes);
	return filter;
}

async function getFilter(store: CompatStore, userId: string, id: string): Promise<Filter> {
	const filter = await store.get<Filter>('filter', userId, id);
	if (!filter) throw new HttpError(404, 'Record not found');
	return filter;
}

async function saveFilter(store: CompatStore, userId: string, filter: Filter): Promise<Filter> {
	await store.transaction(async () => {
		await store.put('filter', userId, filter.id, filter);
		await store.put('filter-revision', userId, 'current', newId());
	});
	return filter;
}

async function findKeyword(store: CompatStore, userId: string, id: string): Promise<{ filter: Filter; keyword: FilterKeyword }> {
	for (const { value: filter } of await store.list<Filter>('filter', userId)) {
		const keyword = filter.keywords.find(item => item.id === id);
		if (keyword) return { filter, keyword };
	}
	throw new HttpError(404, 'Record not found');
}

async function findStatusFilter(store: CompatStore, userId: string, id: string): Promise<{ filter: Filter; status: FilterStatus }> {
	for (const { value: filter } of await store.list<Filter>('filter', userId)) {
		const status = filter.statuses.find(item => item.id === id);
		if (status) return { filter, status };
	}
	throw new HttpError(404, 'Record not found');
}

function legacyFilter(filter: Filter, keyword: FilterKeyword): Json {
	return { id: keyword.id, phrase: keyword.keyword, context: filter.context, whole_word: keyword.whole_word, expires_at: filter.expires_at, irreversible: filter.filter_action === 'hide' };
}

function plainText(value: unknown): string {
	return string(value).replace(/<br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, '')
		.replace(/&#(x[\da-f]+|\d+);/giu, (_, number: string) => {
			const code = number[0].toLowerCase() === 'x' ? Number.parseInt(number.slice(1), 16) : Number(number);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
		}).replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[name]!);
}

function keywordMatches(keyword: FilterKeyword, text: string): boolean {
	const escaped = keyword.keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	const expression = keyword.whole_word ? `(?<![\\p{L}\\p{N}\\p{M}_])${escaped}(?![\\p{L}\\p{N}\\p{M}_])` : escaped;
	return new RegExp(expression, 'iu').test(text);
}

/** Mastodon v2 delegates hide/warn/blur presentation to clients through FilterResult metadata. */
export async function applyFilters(store: CompatStore, userId: string, status: Json, context?: FilterContext, now = Date.now()): Promise<Json> {
	const filters = userId ? (await store.list<Filter>('filter', userId)).map(item => item.value)
		.filter(filter => (!filter.expires_at || Date.parse(filter.expires_at) > now) && (!context || filter.context.includes(context))) : [];
	const visit = (source: Json, depth: number): Json => {
		if (depth > 4) return source;
		const result = { ...source };
		if (object(source.reblog)) result.reblog = visit(source.reblog, depth + 1);
		if (object(source.quote?.quoted_status)) result.quote = { ...source.quote, quoted_status: visit(source.quote.quoted_status, depth + 1) };
		const proper = object(source.reblog) ? source.reblog : source;
		const searchable = [plainText(proper.content), string(proper.spoiler_text), ...array(proper.poll?.options).map(option => string(option.title))].join('\n');
		result.filtered = filters.flatMap(filter => {
			const matches = filter.keywords.filter(keyword => keywordMatches(keyword, searchable)).map(keyword => keyword.keyword);
			const statusMatches = filter.statuses.filter(item => [source.id, proper.id].includes(item.status_id)).map(item => item.status_id);
			return matches.length || statusMatches.length ? [{ filter, keyword_matches: matches.length ? matches : null, status_matches: statusMatches.length ? statusMatches : null }] : [];
		});
		return result;
	};
	return visit(status, 0);
}

/** The thread root is stable for both the HTTP conversation view and streamed direct notes. */
export async function conversationRootId(note: Json, call: NativeCall): Promise<string> {
	let current = note;
	const seen = new Set<string>();
	for (let depth = 0; depth < 64; depth++) {
		const id = requiredText(current.id, 'Note identifier');
		seen.add(id);
		if (!current.replyId || seen.has(current.replyId)) return id;
		let parent: Json;
		try {
			parent = object(current.reply) && current.reply.id === current.replyId && current.reply.visibility ? current.reply : await call('notes/show', { noteId: current.replyId });
		} catch (error) {
			if (error instanceof NativeError && [403, 404].includes(error.status)) return id;
			throw error;
		}
		if (!parent || parent.visibility !== 'specified' || parent.isHidden === true) return id;
		current = parent;
	}
	throw new HttpError(422, 'The conversation reply chain exceeds the supported depth');
}

export async function conversationState(store: CompatStore, userId: string, rootId: string, note: Json): Promise<{ hidden: boolean; unread: boolean }> {
	const state = await store.get<ConversationState>('conversation', userId, rootId);
	const incoming = (note.userId ?? note.user?.id) !== userId;
	return {
		hidden: !!state?.hiddenThrough && compareIds(string(note.id), state.hiddenThrough) <= 0,
		unread: incoming && (!state?.readThrough || compareIds(string(note.id), state.readThrough) > 0),
	};
}

export async function conversationFromNote(store: CompatStore, userId: string, note: Json, call: NativeCall, entities: EntityConverter, options: { rootId?: string; status?: Json } = {}): Promise<Json | null> {
	if (note.visibility !== 'specified' || note.isHidden === true) return null;
	const id = options.rootId ?? await conversationRootId(note, call);
	const previous = await store.get<ConversationState>('conversation', userId, id);
	let latest = note;
	if (previous?.latestId && compareIds(previous.latestId, note.id) > 0) {
		try {
			const stored = await call('notes/show', { noteId: previous.latestId });
			if (stored.visibility === 'specified' && stored.isHidden !== true && await conversationRootId(stored, call) === id) latest = stored;
		} catch (error) {
			if (!(error instanceof NativeError && [403, 404].includes(error.status))) throw error;
		}
	}
	const lastStatus = latest === note ? options.status ?? entities.status(latest, { viewerId: userId, allowLocalOnly: true }) : entities.status(latest, { viewerId: userId, allowLocalOnly: true });
	if (!lastStatus) return null;
	const state = await store.transaction(async () => {
		const current = await store.get<ConversationState>('conversation', userId, id);
		const state = await conversationState(store, userId, id, latest);
		const replaceLatest = current?.latestId !== latest.id && (current?.latestId === previous?.latestId || !current?.latestId || compareIds(latest.id, current.latestId) > 0);
		if (!state.hidden && replaceLatest) await store.put('conversation', userId, id, { ...current, latestId: latest.id });
		return state;
	});
	if (state.hidden) return null;
	const participantIds = new Set<string>([latest.userId ?? latest.user?.id, ...strings(latest.visibleUserIds)].filter(value => typeof value === 'string' && value && value !== userId));
	const accounts = await Promise.all([...participantIds].map(async participantId => entities.account(participantId === latest.user?.id ? latest.user : await call('users/show', { userId: participantId }))));
	return { id, accounts, unread: state.unread, last_status: await applyFilters(store, userId, await decorateStatus(store, lastStatus, userId)) };
}

/** Recover a conversation after its last visible note was removed, using only native APIs. */
export async function latestConversationNote(store: CompatStore, userId: string, rootId: string, call: NativeCall, removedId: string): Promise<Json | null> {
	const previous = await store.get<ConversationState>('conversation', userId, rootId);
	if (previous?.latestId && previous.latestId !== removedId) {
		try {
			const latest = await call('notes/show', { noteId: previous.latestId });
			if (latest.visibility === 'specified' && latest.isHidden !== true && await conversationRootId(latest, call) === rootId) return latest;
		} catch (error) {
			if (!(error instanceof NativeError && [403, 404].includes(error.status))) throw error;
		}
	}
	let incomingCursor: string | undefined;
	let outgoingCursor: string | undefined;
	let incomingDone = false;
	let outgoingDone = false;
	let latest: Json | null = null;
	const seen = new Set<string>();
	for (let page = 0; page < 10 && !(incomingDone && outgoingDone); page++) {
		const [incoming, outgoing]: [Json[], Json[]] = await Promise.all([
			incomingDone ? [] : call<Json[]>('notes/mentions', { limit: 100, visibility: 'specified', ...(incomingCursor ? { untilId: incomingCursor } : {}) }),
			outgoingDone ? [] : call<Json[]>('users/notes', { userId, limit: 100, withReplies: true, withRenotes: false, ...(outgoingCursor ? { untilId: outgoingCursor } : {}) }),
		]);
		incomingDone ||= incoming.length < 100 || incoming.at(-1)?.id === incomingCursor;
		outgoingDone ||= outgoing.length < 100 || outgoing.at(-1)?.id === outgoingCursor;
		incomingCursor = incoming.at(-1)?.id;
		outgoingCursor = outgoing.at(-1)?.id;
		for (const candidate of [...incoming, ...outgoing].sort((a, b) => compareIds(b.id, a.id))) {
			if (seen.has(candidate.id) || candidate.id === removedId || candidate.visibility !== 'specified' || candidate.isHidden === true || (latest && compareIds(candidate.id, latest.id) <= 0)) continue;
			seen.add(candidate.id);
			if (await conversationRootId(candidate, call) === rootId) latest = candidate;
		}
		if (latest && (incomingDone || compareIds(latest.id, incomingCursor!) >= 0) && (outgoingDone || compareIds(latest.id, outgoingCursor!) >= 0)) break;
	}
	const latestId = latest?.id;
	await store.transaction(async () => {
		const current = await store.get<ConversationState>('conversation', userId, rootId);
		if (current?.latestId === previous?.latestId || current?.latestId === removedId) await store.put('conversation', userId, rootId, { ...current, latestId });
	});
	return latest;
}

async function asConversation(routes: Routes, context: RequestContext, note: Json, rootId?: string): Promise<Json> {
	const result = await conversationFromNote(routes.deps.store, context.userId, note, context.call, routes.deps.entities, { rootId, status: await routes.status(note, context) });
	if (!result) throw new HttpError(404, 'Record not found');
	return result;
}

async function conversations(routes: Routes, context: RequestContext): Promise<Json[]> {
	const limit = integer(context.query.limit, 20, 1, 40);
	const groups = new Map<string, Json>();
	const seenNotes = new Set<string>();
	const cache = new Map<string, Json>();
	const call: NativeCall = async <T>(endpoint: string, body: Json = {}): Promise<T> => {
		if (endpoint === 'notes/show' && cache.has(body.noteId)) return cache.get(body.noteId) as T;
		const value = await context.call<T>(endpoint, body);
		if (endpoint === 'notes/show' && object(value)) cache.set(value.id, value);
		return value;
	};
	let incomingCursor: string | undefined;
	let outgoingCursor: string | undefined;
	let incomingDone = false;
	let outgoingDone = false;
	// The native user timeline has no visibility selector. Advance past public notes as needed.
	for (let page = 0; page < 10 && !(incomingDone && outgoingDone); page++) {
		const [incoming, outgoing]: [Json[], Json[]] = await Promise.all([
			incomingDone ? [] : context.call<Json[]>('notes/mentions', { limit: 100, visibility: 'specified', ...(incomingCursor ? { untilId: incomingCursor } : {}) }),
			outgoingDone ? [] : context.call<Json[]>('users/notes', { userId: context.userId, limit: 100, withReplies: true, withRenotes: false, ...(outgoingCursor ? { untilId: outgoingCursor } : {}) }),
		]);
		incomingDone ||= incoming.length < 100 || incoming.at(-1)?.id === incomingCursor;
		outgoingDone ||= outgoing.length < 100 || outgoing.at(-1)?.id === outgoingCursor;
		incomingCursor = incoming.at(-1)?.id;
		outgoingCursor = outgoing.at(-1)?.id;
		const notes = [...incoming, ...outgoing].filter(note => note.visibility === 'specified' && note.isHidden !== true).sort((a, b) => compareIds(b.id, a.id));
		for (const note of notes) cache.set(note.id, note);
		for (const note of notes) {
			if (seenNotes.has(note.id)) continue;
			seenNotes.add(note.id);
			const id = await conversationRootId(note, call);
			if (context.query.max_id && compareIds(id, string(context.query.max_id)) >= 0) continue;
			if ((context.query.since_id || context.query.min_id) && compareIds(id, string(context.query.since_id || context.query.min_id)) <= 0) continue;
			if ((await conversationState(routes.deps.store, context.userId, id, note)).hidden) continue;
			if (!groups.has(id) || compareIds(note.id, groups.get(id)!.id) > 0) groups.set(id, note);
		}
		if (groups.size >= limit) break;
	}
	const selected = [...groups.entries()].sort(([a], [b]) => compareIds(b, a)).slice(0, limit);
	const result = await Promise.all(selected.map(async ([id, note]) => asConversation(routes, context, note, id)));
	return routes.page(context, result, result);
}

export function registerFeatures(routes: Routes): void {
	const add = routes.add.bind(routes);
	const { store, entities, publicUrl } = routes.deps;
	const save = (userId: string, filter: Filter) => saveFilter(store, userId, filter);

	add('GET', '/api/v2/filters', 'read:filters', async c => (await store.list<Filter>('filter', c.userId)).map(item => item.value));
	add('GET', '/api/v2/filters/:id', 'read:filters', async c => getFilter(store, c.userId, string(c.params.id)));
	add('POST', '/api/v2/filters', 'write:filters', async c => store.transaction(async () => {
		if ((await store.list('filter', c.userId)).length >= 200) throw new HttpError(422, 'The filter limit has been reached');
		return save(c.userId, updatedFilter(c.body));
	}));
	add('PUT', '/api/v2/filters/:id', 'write:filters', async c => store.transaction(async () => save(c.userId, updatedFilter(c.body, await getFilter(store, c.userId, string(c.params.id))))));
	add('DELETE', '/api/v2/filters/:id', 'write:filters', async c => store.transaction(async () => {
		const filter = await getFilter(store, c.userId, string(c.params.id));
		await store.delete('filter', c.userId, filter.id);
		await store.put('filter-revision', c.userId, 'current', newId());
		return {};
	}));
	add('GET', '/api/v2/filters/:id/keywords', 'read:filters', async c => (await getFilter(store, c.userId, string(c.params.id))).keywords);
	add('POST', '/api/v2/filters/:id/keywords', 'write:filters', async c => store.transaction(async () => {
		const filter = await getFilter(store, c.userId, string(c.params.id));
		filter.keywords = updateKeywords(filter, [{ keyword: c.body.keyword, whole_word: c.body.whole_word }]);
		await save(c.userId, filter);
		return filter.keywords.at(-1);
	}));
	add('GET', '/api/v2/filters/keywords/:id', 'read:filters', async c => (await findKeyword(store, c.userId, string(c.params.id))).keyword);
	add('PUT', '/api/v2/filters/keywords/:id', 'write:filters', async c => store.transaction(async () => {
		const { filter, keyword } = await findKeyword(store, c.userId, string(c.params.id));
		filter.keywords = updateKeywords(filter, [{ id: keyword.id, keyword: requiredText(c.body.keyword, 'Keyword', 400), ...(c.body.whole_word !== undefined ? { whole_word: c.body.whole_word } : {}) }]);
		await save(c.userId, filter);
		return filter.keywords.find(item => item.id === keyword.id);
	}));
	add('DELETE', '/api/v2/filters/keywords/:id', 'write:filters', async c => store.transaction(async () => {
		const { filter, keyword } = await findKeyword(store, c.userId, string(c.params.id));
		filter.keywords = filter.keywords.filter(item => item.id !== keyword.id);
		await save(c.userId, filter);
		return {};
	}));
	add('GET', '/api/v2/filters/:id/statuses', 'read:filters', async c => (await getFilter(store, c.userId, string(c.params.id))).statuses);
	add('POST', '/api/v2/filters/:id/statuses', 'write:filters', async c => {
		await getFilter(store, c.userId, string(c.params.id));
		const statusId = requiredText(c.body.status_id, 'Status identifier');
		await routes.status(await routes.note(c, statusId), c);
		return store.transaction(async () => {
			const filter = await getFilter(store, c.userId, string(c.params.id));
			const existing = filter.statuses.find(item => item.status_id === statusId);
			if (existing) return existing;
			if (filter.statuses.length >= 1000) throw new HttpError(422, 'The status filter limit has been reached');
			const status = { id: newId(), status_id: statusId };
			filter.statuses.push(status);
			await save(c.userId, filter);
			return status;
		});
	});
	add('GET', '/api/v2/filters/statuses/:id', 'read:filters', async c => (await findStatusFilter(store, c.userId, string(c.params.id))).status);
	add('DELETE', '/api/v2/filters/statuses/:id', 'write:filters', async c => store.transaction(async () => {
		const { filter, status } = await findStatusFilter(store, c.userId, string(c.params.id));
		filter.statuses = filter.statuses.filter(item => item.id !== status.id);
		await save(c.userId, filter);
		return {};
	}));

	add('GET', '/api/v1/filters', 'read:filters', async c => (await store.list<Filter>('filter', c.userId)).flatMap(({ value: filter }) => filter.keywords.map(keyword => legacyFilter(filter, keyword))));
	add('GET', '/api/v1/filters/:id', 'read:filters', async c => { const { filter, keyword } = await findKeyword(store, c.userId, string(c.params.id)); return legacyFilter(filter, keyword); });
	add('POST', '/api/v1/filters', 'write:filters', async c => store.transaction(async () => {
		if ((await store.list('filter', c.userId)).length >= 200) throw new HttpError(422, 'The filter limit has been reached');
		const filter = updatedFilter({ title: c.body.phrase, context: c.body.context, expires_in: c.body.expires_in, filter_action: boolean(c.body.irreversible) ? 'hide' : 'warn', keywords_attributes: [{ keyword: c.body.phrase, whole_word: c.body.whole_word }] });
		await save(c.userId, filter);
		return legacyFilter(filter, filter.keywords[0]);
	}));
	add('PUT', '/api/v1/filters/:id', 'write:filters', async c => store.transaction(async () => {
		const { filter, keyword } = await findKeyword(store, c.userId, string(c.params.id));
		const updated = updatedFilter({ ...(c.body.phrase !== undefined ? { title: c.body.phrase } : {}), ...(c.body.context !== undefined ? { context: c.body.context } : {}), expires_in: c.body.expires_in, ...(c.body.irreversible !== undefined ? { filter_action: boolean(c.body.irreversible) ? 'hide' : 'warn' } : {}), keywords_attributes: [{ id: keyword.id, ...(c.body.phrase !== undefined ? { keyword: c.body.phrase } : {}), ...(c.body.whole_word !== undefined ? { whole_word: c.body.whole_word } : {}) }] }, filter);
		if (filter.keywords.length > 1 && ['title', 'context', 'expires_at', 'filter_action'].some(key => JSON.stringify((filter as unknown as Json)[key]) !== JSON.stringify((updated as unknown as Json)[key]))) throw new HttpError(422, 'Use the v2 API to edit a filter with multiple keywords');
		await save(c.userId, updated);
		return legacyFilter(updated, updated.keywords.find(item => item.id === keyword.id)!);
	}));
	add('DELETE', '/api/v1/filters/:id', 'write:filters', async c => store.transaction(async () => {
		const { filter, keyword } = await findKeyword(store, c.userId, string(c.params.id));
		filter.keywords = filter.keywords.filter(item => item.id !== keyword.id);
		await save(c.userId, filter);
		return {};
	}));

	add('GET', '/api/v1/preferences', 'read:accounts', async c => {
		const user = await c.call('i');
		return { 'posting:default:visibility': ({ public: 'public', home: 'unlisted', followers: 'private', specified: 'direct' } as Json)[user.defaultNoteVisibility] ?? 'public', 'posting:default:sensitive': user.alwaysMarkNsfw === true, 'posting:default:language': user.lang ?? null, 'reading:expand:media': 'default', 'reading:expand:spoilers': false };
	});
	add('GET', '/api/v1/announcements', 'read:accounts', async c => {
		const announcements = await c.call<Json[]>('announcements', { limit: 100, isActive: true });
		return announcements.filter(item => boolean(c.query.with_dismissed) || item.isRead !== true).map(item => ({ id: item.id, content: entities.render([item.title, item.text].filter(Boolean).join('\n\n')), starts_at: null, ends_at: null, all_day: false, published_at: item.createdAt, updated_at: item.updatedAt ?? item.createdAt, read: item.isRead === true, mentions: [], statuses: [], tags: [], emojis: [], reactions: [] }));
	});
	add('POST', '/api/v1/announcements/:id/dismiss', 'write:notifications', async c => { await c.call('i/read-announcement', { announcementId: c.params.id }); return {}; });
	for (const method of ['PUT', 'DELETE'] as const) add(method, '/api/v1/announcements/:id/reactions/:name', 'write:notifications', () => { throw new HttpError(422, 'Announcement reactions are not supported by the native server'); });

	add('GET', '/api/v1/conversations', 'read:statuses', c => conversations(routes, c));
	add('POST', '/api/v1/conversations/:id/read', 'write:conversations', async c => {
		const id = string(c.params.id);
		const previous = await store.get<ConversationState>('conversation', c.userId, id);
		const note = await routes.note(c, previous?.latestId ?? id);
		if (note.visibility !== 'specified' || await conversationRootId(note, c.call) !== id) throw new HttpError(404, 'Record not found');
		await routes.status(note, c);
		await store.transaction(async () => {
			const current = await store.get<ConversationState>('conversation', c.userId, id);
			const latestId = current?.latestId && compareIds(current.latestId, note.id) > 0 ? current.latestId : note.id;
			const through = current?.readThrough && compareIds(current.readThrough, note.id) > 0 ? current.readThrough : note.id;
			await store.put('conversation', c.userId, id, { ...current, latestId, readThrough: through });
		});
		return asConversation(routes, c, note, id);
	});
	add('DELETE', '/api/v1/conversations/:id', 'write:conversations', async c => {
		const id = string(c.params.id);
		const previous = await store.get<ConversationState>('conversation', c.userId, id);
		const note = await routes.note(c, previous?.latestId ?? id);
		if (note.visibility !== 'specified' || await conversationRootId(note, c.call) !== id) throw new HttpError(404, 'Record not found');
		await routes.status(note, c);
		await store.transaction(async () => {
			const current = await store.get<ConversationState>('conversation', c.userId, id);
			const latestId = current?.latestId && compareIds(current.latestId, note.id) > 0 ? current.latestId : note.id;
			const through = current?.hiddenThrough && compareIds(current.hiddenThrough, note.id) > 0 ? current.hiddenThrough : note.id;
			await store.put('conversation', c.userId, id, { ...current, latestId, hiddenThrough: through });
		});
		return {};
	});

	add('GET', '/api/v1/tags/:name', undefined, c => ({ name: c.params.name, url: `${publicUrl}/tags/${encodeURIComponent(c.params.name)}`, history: [] }), true);
	add('GET', '/api/v1/followed_tags', 'read:follows', () => { throw new HttpError(501, 'Following tags is not supported by the native server'); });
	for (const action of ['follow', 'unfollow']) add('POST', `/api/v1/tags/:name/${action}`, 'write:follows', () => { throw new HttpError(501, 'Following tags is not supported by the native server'); });
	add('GET', '/api/v1/scheduled_statuses', 'read:statuses', () => []);
	add('GET', '/api/v1/scheduled_statuses/:id', 'read:statuses', () => { throw new HttpError(404, 'Record not found'); });
	for (const method of ['PUT', 'DELETE'] as const) add(method, '/api/v1/scheduled_statuses/:id', 'write:statuses', () => { throw new HttpError(422, 'Scheduled posts are not supported by this gateway'); });
	add('GET', '/api/v1/push/subscription', 'push', () => { throw new HttpError(404, 'No push subscription is registered'); });
	for (const method of ['POST', 'PUT'] as const) add(method, '/api/v1/push/subscription', 'push', () => { throw new HttpError(501, 'Web Push delivery is not configured'); });
	add('DELETE', '/api/v1/push/subscription', 'push', () => ({}));
}
