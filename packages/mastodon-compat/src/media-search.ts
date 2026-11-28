/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { NativeError } from './native-client.js';
import { appendFormField, array, boolean, HttpError, integer, parameters, string } from './parameters.js';
import type { RequestContext, Routes } from './routes.js';
import type { Json } from './types.js';

interface Upload { blob: Blob; name: string; }
interface MultipartInput { fields: Json; files: Map<string, Upload>; }

async function input(c: RequestContext, acceptedFiles: readonly string[], allowUnindexedFields = false): Promise<MultipartInput> {
	if (!c.request.isMultipart()) return { fields: c.body, files: new Map() };
	const fields: Record<string, unknown> = Object.create(null);
	const files = new Map<string, Upload>();
	const groups = new Map<string, Array<Set<string>>>();
	for await (const part of c.request.parts()) {
		if (part.type === 'file') {
			if (!acceptedFiles.includes(part.fieldname) || files.has(part.fieldname)) {
				part.file.resume();
				throw new HttpError(422, `Unexpected or duplicate file: ${part.fieldname}`);
			}
			const bytes = await part.toBuffer();
			if (part.file.truncated) throw new HttpError(413, 'File is too large');
			if (!bytes.length) throw new HttpError(422, 'File is empty');
			files.set(part.fieldname, { blob: new Blob([new Uint8Array(bytes)], { type: part.mimetype }), name: part.filename || 'upload' });
		} else {
			if (part.valueTruncated || part.fieldnameTruncated) throw new HttpError(422, 'Parameter is too large');
			if (allowUnindexedFields && /^fields_attributes\[\]\[[^\]]+\]$/u.test(part.fieldname)) {
				appendFormField(fields, groups, part.fieldname, part.value, false);
			} else {
				if (Object.hasOwn(fields, part.fieldname)) throw new HttpError(422, 'Duplicate parameter');
				fields[part.fieldname] = part.value;
			}
		}
	}
	return { fields: parameters(fields), files };
}

export function focalPoint(value: unknown): { x: number; y: number } | undefined {
	if (value === undefined) return undefined;
	const parts = string(value).split(',');
	if (parts.length !== 2 || parts.some(item => !item.trim())) throw new HttpError(422, 'Focus must contain two coordinates');
	const [x, y] = parts.map(Number);
	if (![x, y].every(item => Number.isFinite(item) && item >= -1 && item <= 1)) throw new HttpError(422, 'Focus coordinates must be between -1 and 1');
	return { x, y };
}

export function description(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const result = string(value);
	if (result.length > 512) throw new HttpError(422, 'Media descriptions cannot exceed 512 characters');
	return result;
}

function upload(routes: Routes, c: RequestContext, file: Upload, fields: Json = {}): Promise<Json> {
	return routes.deps.native.upload(file.blob, file.name, { force: true, ...fields }, c.grant!.nativeToken!, { ip: c.request.ip, userAgent: c.request.headers['user-agent'] });
}

async function ownedFile(c: RequestContext): Promise<Json> {
	const file = await c.call('drive/files/show', { fileId: string(c.params.id) }).catch(error => {
		if (error instanceof NativeError && ['ACCESS_DENIED', 'NO_SUCH_FILE'].includes(error.code)) throw new HttpError(404, 'Record not found');
		throw error;
	});
	if ((file.userId ?? file.user?.id) !== c.userId) throw new HttpError(404, 'Record not found');
	return file;
}

async function attachment(routes: Routes, c: RequestContext, file: Json): Promise<Json> {
	const result = routes.deps.entities.attachment(file);
	const metadata = await routes.deps.store.get<Json>('media', c.userId, file.id);
	if (metadata?.focus) result.meta.focus = metadata.focus;
	return result;
}

export function registerMediaSearch(routes: Routes): void {
	for (const version of [1, 2]) routes.add('POST', `/api/v${version}/media`, 'write:media', async c => {
		const { fields, files } = await input(c, ['file']);
		const file = files.get('file');
		if (!file) throw new HttpError(422, 'A multipart file is required');
		if (fields.thumbnail !== undefined) throw new HttpError(422, 'Custom thumbnails are unavailable');
		const focus = focalPoint(fields.focus);
		const comment = description(fields.description);
		const uploaded = await upload(routes, c, file, { ...(comment === undefined ? {} : { comment }) });
		if (focus) await routes.deps.store.put('media', c.userId, uploaded.id, { focus });
		return attachment(routes, c, uploaded);
	});
	routes.add('GET', '/api/v1/media/:id', 'write:media', async c => attachment(routes, c, await ownedFile(c)));
	routes.add('PUT', '/api/v1/media/:id', 'write:media', async c => {
		const { fields } = await input(c, []);
		if (fields.thumbnail !== undefined) throw new HttpError(422, 'Custom thumbnails are unavailable');
		const focus = focalPoint(fields.focus);
		const comment = description(fields.description);
		const existing = await ownedFile(c);
		const file = comment === undefined ? existing : await c.call('drive/files/update', { fileId: existing.id, comment });
		if (focus) await routes.deps.store.put('media', c.userId, file.id, { focus });
		return attachment(routes, c, file);
	});
	routes.add('PATCH', '/api/v1/accounts/update_credentials', 'write:accounts', c => updateProfile(routes, c));
	for (const version of [1, 2]) routes.add('GET', `/api/v${version}/search`, 'read:search', c => search(routes, c, version), version === 2);
	routes.add('GET', '/api/v1/statuses/:id/history', 'read:statuses', c => history(routes, c), true);
	routes.add('POST', '/api/v1/statuses/:id/translate', 'read:statuses', c => translate(routes, c));
}

function canonicalizeLanguageTag(value: string): string {
	return value.split('-').map((segment, index) => {
		if (index === 0) return segment.toLowerCase();
		if (segment.length === 2) return segment.toUpperCase();
		if (segment.length === 4) return segment[0].toUpperCase() + segment.slice(1).toLowerCase();
		return segment;
	}).join('-');
}

async function updateProfile(routes: Routes, c: RequestContext): Promise<Json> {
	const { fields, files } = await input(c, ['avatar', 'header'], true);
	const body: Json = {};
	for (const [source, target] of [['display_name', 'name'], ['note', 'description']]) if (fields[source] !== undefined) body[target] = string(fields[source]) || null;
	for (const [source, target] of [['locked', 'isLocked'], ['bot', 'isBot'], ['discoverable', 'isExplorable']]) if (fields[source] !== undefined) body[target] = boolean(fields[source]);
	if (fields.hide_collections !== undefined) body.followersVisibility = body.followingVisibility = boolean(fields.hide_collections) ? 'private' : 'public';
	if (boolean(fields.indexable)) throw new HttpError(422, 'Public search indexing is unavailable');
	if (fields.fields_attributes !== undefined) {
		const attributes = fields.fields_attributes;
		if (attributes == null || typeof attributes !== 'object') throw new HttpError(422, 'Invalid profile fields');
		const entries = Array.isArray(attributes)
			? attributes
			: !Array.isArray(attributes) && ('name' in attributes || 'value' in attributes) && (Array.isArray(attributes.name) || Array.isArray(attributes.value) || typeof attributes.name === 'string' || typeof attributes.value === 'string')
				? Array.from({ length: Math.max(array(attributes.name).length, array(attributes.value).length) }, (_, i) => ({ name: array(attributes.name)[i] ?? '', value: array(attributes.value)[i] ?? '' }))
				: Object.entries(attributes).sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => value);
		if (entries.length > 16) throw new HttpError(422, 'Too many profile fields');
		body.fields = entries.map(item => {
			if (item == null || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(422, 'Invalid profile field');
			return { name: string(item.name), value: string(item.value) };
		}).filter(item => item.name || item.value);
	}
	const sourcePatch: Json = {};
	if (fields.source !== undefined) {
		if (fields.source == null || typeof fields.source !== 'object' || Array.isArray(fields.source)) throw new HttpError(422, 'Invalid source preferences');
		if (fields.source.privacy !== undefined) {
			const value = string(fields.source.privacy);
			if (!['public', 'unlisted', 'private', 'direct'].includes(value)) throw new HttpError(422, 'Invalid default visibility');
			sourcePatch.privacy = value;
		}
		if (fields.source.sensitive !== undefined) sourcePatch.sensitive = body.alwaysMarkNsfw = boolean(fields.source.sensitive);
		if (fields.source.language !== undefined) {
			const rawLanguage = string(fields.source.language).trim();
			if (rawLanguage && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(rawLanguage)) throw new HttpError(422, 'Invalid language');
			sourcePatch.language = rawLanguage || null;
			body.lang = rawLanguage ? canonicalizeLanguageTag(rawLanguage) : null;
		}
	}
	for (const [field, target] of [['avatar', 'avatarId'], ['header', 'bannerId']]) {
		if (fields[field] !== undefined) {
			if (![null, '', false, 'false'].includes(fields[field])) throw new HttpError(422, `${field} must be a multipart file`);
			body[target] = null;
		}
	}
	for (const field of ['avatar', 'header']) {
		const file = files.get(field);
		if (file) {
			if (!file.blob.type.startsWith('image/')) throw new HttpError(422, `${field} must be an image`);
		}
	}
	for (const [field, target] of [['avatar', 'avatarId'], ['header', 'bannerId']]) {
		const file = files.get(field);
		if (file) body[target] = (await upload(routes, c, file)).id;
	}
	let user: Json;
	if (Object.keys(body).length) {
		try {
			user = await c.call('i/update', body);
		} catch (error) {
			if (body.lang != null && error instanceof NativeError && error.status === 400 && error.code === 'INVALID_PARAM') {
				const fallbackBody = { ...body };
				delete fallbackBody.lang;
				user = Object.keys(fallbackBody).length ? await c.call('i/update', fallbackBody) : await c.call('i');
			} else throw error;
		}
	} else {
		user = await c.call('i');
	}
	const source = fields.source !== undefined
		? await routes.deps.store.transaction(async () => {
			const merged = { ...await routes.deps.store.get<Json>('account-source', c.userId, 'defaults'), ...sourcePatch };
			await routes.deps.store.put('account-source', c.userId, 'defaults', merged);
			return merged;
		})
		: await routes.deps.store.get<Json>('account-source', c.userId, 'defaults') ?? {};
	const result = routes.deps.entities.account(user, true);
	Object.assign(result.source, source);
	return result;
}

async function search(routes: Routes, c: RequestContext, version: number): Promise<Json> {
	const query = string(c.query.q).trim();
	if (c.query.q === undefined) throw new HttpError(422, 'A search query is required');
	const type = string(c.query.type);
	if (type && !['accounts', 'hashtags', 'statuses'].includes(type)) throw new HttpError(422, 'Invalid search type');
	const limit = integer(c.query.limit, 20, 1, 40);
	const rawOffset = integer(c.query.offset, 0, 0, 1000);
	const offset = type || version === 1 ? rawOffset : 0;
	const resolve = boolean(c.query.resolve);
	const following = boolean(c.query.following);
	if ((resolve || rawOffset || following) && c.grant?.kind !== 'user') throw new HttpError(401, 'A user access token is required');
	const result: Json = { accounts: [], statuses: [], hashtags: [] };
	if (!query) return result;
	if (resolve && /^https?:\/\//iu.test(query)) {
		if (offset > 0) return result;
		const resolved = await resolveOrEmpty(() => c.call('ap/show', { uri: query }));
		if (resolved?.type === 'User' && (!type || type === 'accounts') && (!following || resolved.object.isFollowing)) result.accounts = [routes.deps.entities.account(resolved.object)];
		if (resolved?.type === 'Note' && (!type || type === 'statuses') && (!c.query.account_id || resolved.object.userId === c.query.account_id)) result.statuses = await routes.statuses([resolved.object], c);
		return result;
	}
	const tasks: Promise<void>[] = [];
	if (!type || type === 'accounts') tasks.push((async () => {
		let users = await c.call<Json[]>('users/search', { query, offset, limit, origin: 'combined', detail: true });
		if (resolve && /^@?[^@\s]+@[^@\s]+$/u.test(query) && offset === 0) {
			const [username, host] = query.replace(/^@/u, '').split('@');
			const user = await resolveOrEmpty(() => c.call('users/show', { username, host }));
			if (user && !users.some(item => item.id === user.id)) users = [user, ...users].slice(0, limit);
		}
		if (following) users = users.filter(user => user.isFollowing === true);
		result.accounts = users.map(user => routes.deps.entities.account(user));
	})());
	if ((!type || type === 'statuses') && c.grant?.kind === 'user') tasks.push((async () => {
		const notes: Json[] = [];
		let untilId = c.query.max_id ? string(c.query.max_id) : undefined;
		let sinceId = c.query.min_id ? string(c.query.min_id) : undefined;
		const forwardOnly = Boolean(sinceId && !untilId);
		const maxPages = Math.max(10, Math.min(12, Math.ceil((offset + limit) / 100) + 1));
		const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
		let skipped = 0;
		let pages = 0;
		while (notes.length < limit && pages++ < maxPages) {
			const pageSize = Math.min(100, offset - skipped + limit - notes.length);
			const page = await c.call<Json[]>('notes/search', { query, limit: pageSize, ...(untilId ? { untilId } : {}), ...(sinceId ? { sinceId } : {}), ...(c.query.account_id ? { userId: string(c.query.account_id) } : {}) }).catch(error => {
				if (error instanceof NativeError && error.code === 'UNAVAILABLE') return [];
				throw error;
			});
			if (!page.length) break;
			const visible = await routes.statuses(page, c);
			for (const note of visible) { if (skipped < offset) skipped++; else if (!notes.some(item => item.id === note.id)) notes.push(note); }
			const sortedIds = page.map(item => string(item.id)).sort(compareIds);
			const pageAscending = page.length >= 2 && compareIds(string(page[0].id), string(page.at(-1)!.id)) < 0;
			if (forwardOnly && pageAscending) {
				const cursor = sortedIds.at(-1)!;
				if (sinceId && compareIds(cursor, sinceId) <= 0) break;
				sinceId = cursor;
			} else {
				const cursor = sortedIds[0]!;
				if (untilId && compareIds(cursor, untilId) >= 0) break;
				if (sinceId && compareIds(cursor, sinceId) <= 0) break;
				untilId = cursor;
			}
		}
		result.statuses = notes.slice(0, limit);
	})());
	if (!type || type === 'hashtags') tasks.push((async () => {
		const tags = await c.call<string[]>('hashtags/search', { query: query.replace(/^#/u, ''), offset, limit });
		result.hashtags = version === 1 ? tags : tags.map(name => ({ name, url: `${routes.deps.publicUrl}/tags/${encodeURIComponent(name)}`, history: [] }));
	})());
	await Promise.all(tasks);
	return result;
}

async function resolveOrEmpty(call: () => Promise<Json>): Promise<Json | undefined> {
	try { return await call(); } catch (error) {
		if (error instanceof NativeError && ['NO_SUCH_USER', 'NO_SUCH_OBJECT', 'URI_INVALID', 'REQUEST_FAILED', 'FAILED_TO_RESOLVE_REMOTE_USER'].includes(error.code)) return undefined;
		throw error;
	}
}

async function history(routes: Routes, c: RequestContext): Promise<Json[]> {
	const note = await c.call<Json>('notes/show', { noteId: String(c.params.id), withHistory: true });
	await routes.status(note, c);
	const revisions = [...array(note.history), { ...note, createdAt: note.updatedAt ?? note.createdAt }];
	return revisions.map(revision => {
		const version = { ...note, ...revision, text: revision.text ?? null, cw: revision.cw ?? null, history: undefined, renote: undefined, renoteId: null, files: array(revision.files), poll: revision.poll ?? null, emojis: revision.emojiUrls ?? revision.emojis };
		const status = routes.deps.entities.status(version, { viewerId: c.userId || null });
		if (!status) throw new HttpError(404, 'Record not found');
		return { content: status.content, spoiler_text: string(revision.cw), sensitive: revision.sensitive ?? status.sensitive, created_at: status.created_at, account: status.account, poll: status.poll ? { options: status.poll.options.map((option: Json) => ({ title: option.title })) } : null, media_attachments: status.media_attachments, emojis: status.emojis };
	}).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function translate(routes: Routes, c: RequestContext): Promise<Json> {
	const note = await routes.note(c);
	await routes.status(note, c);
	const langPattern = /^[a-z]{2,3}(?:-(?:[a-zA-Z]{2,4}|\d{3})){0,2}$/u;
	let language: string;
	if (c.body.lang !== undefined) {
		language = string(c.body.lang);
		if (!langPattern.test(language)) throw new HttpError(422, 'Invalid target language');
	} else {
		const headerLang = c.request.headers['accept-language']?.split(',')[0]?.split(';')[0]?.trim() ?? '';
		language = langPattern.test(headerLang) ? headerLang : 'en';
	}
	const translated = await c.call<Json | undefined>('notes/translate', { noteId: note.id, targetLang: language }).catch(error => {
		if (error instanceof NativeError && error.code === 'UNAVAILABLE') throw new HttpError(503, 'Translation is unavailable');
		throw error;
	});
	let content = string(translated?.text);
	let spoiler = string(note.cw);
	if (note.cw && content.includes('\n-----\n')) {
		const separator = content.indexOf('\n-----\n');
		spoiler = content.slice(0, separator);
		content = content.slice(separator + 7);
	}
	return { content: routes.deps.entities.render(content), spoiler_text: spoiler, language, detected_source_language: string(translated?.sourceLang).toLowerCase(), provider: 'DeepL.com', poll: null, media_attachments: [] };
}
