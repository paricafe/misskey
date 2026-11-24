/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { boolean, compareIds, HttpError, integer, string, strings } from './parameters.js';
import type { RequestContext, Routes } from './routes.js';
import type { Json } from './types.js';

interface NotificationPage { notifications: Json[]; cursors: Json[]; }

const MAX_SCAN_PAGES = 10;

function groupNotificationId(value: unknown): string {
	const key = string(value);
	if (!key.startsWith('ungrouped-') || key.length === 'ungrouped-'.length) throw new HttpError(404, 'Record not found');
	return key.slice('ungrouped-'.length);
}

async function isDismissed(routes: Routes, c: RequestContext, id: string): Promise<boolean> {
	const cleared = await routes.deps.store.get<string>('notifications', c.userId, 'cleared');
	return !!((cleared && compareIds(id, cleared) <= 0) || await routes.deps.store.get('dismissed-notification', c.userId, id));
}

async function convert(routes: Routes, c: RequestContext, row: Json, hydrate = true): Promise<Json | null> {
	const result = routes.deps.entities.notification(row, { viewerId: c.userId || null, allowLocalOnly: true });
	if (!result) return null;
	if (result.status && hydrate) {
		try { result.status = await routes.status(row.note, c); } catch (error) {
			if (error instanceof HttpError && error.statusCode === 404) return null;
			throw error;
		}
	}
	return result;
}

function grouped(notifications: Json[], c: RequestContext, paginated: boolean): Json {
	const accounts = new Map<string, Json>();
	const statuses = new Map<string, Json>();
	const notificationGroups = notifications.map(notification => {
		accounts.set(notification.account.id, notification.account);
		if (notification.status) statuses.set(notification.status.id, notification.status);
		return {
			group_key: `ungrouped-${notification.id}`,
			notifications_count: 1,
			type: notification.type,
			most_recent_notification_id: notification.id,
			...(paginated ? { page_min_id: notification.id, page_max_id: notification.id, latest_page_notification_at: notification.created_at } : {}),
			sample_account_ids: [notification.account.id],
			...(notification.status ? { status_id: notification.status.id } : {}),
		};
	});
	return { accounts: [...accounts.values()], statuses: [...statuses.values()], notification_groups: notificationGroups, ...(c.query.expand_accounts === 'partial_avatars' ? { partial_accounts: [] } : {}) };
}

function validateQuery(query: Json): void {
	if (query.expand_accounts !== undefined && !['full', 'partial_avatars'].includes(query.expand_accounts)) throw new HttpError(422, 'Invalid account expansion');
	for (const field of ['types', 'exclude_types', 'grouped_types', 'supported_types']) if (query[field] !== undefined) strings(query[field]);
	boolean(query.include_filtered);
}

async function readPage(routes: Routes, c: RequestContext, limit: number, query = c.query, hydrate = true): Promise<NotificationPage> {
	validateQuery(query);
	const types = strings(query.types);
	const excluded = strings(query.exclude_types);
	const accountId = string(query.account_id);
	const minId = string(query.min_id);
	const sinceId = string(query.since_id);
	const maxId = string(query.max_id);
	const cleared = await routes.deps.store.get<string>('notifications', c.userId, 'cleared');
	const lowerBound = [minId, sinceId, cleared ?? ''].filter(Boolean).sort(compareIds).at(-1) ?? '';
	if (maxId && lowerBound && compareIds(maxId, lowerBound) <= 0) return { notifications: [], cursors: [] };
	const ascending = !!minId;
	let cursor = ascending ? lowerBound : maxId;
	const notifications: Json[] = [];
	const cursors: Json[] = [];
	const seen = new Set<string>();
	const visited = new Set<string>();
	let pages = 0;
	while (notifications.length < limit && pages++ < MAX_SCAN_PAGES) {
		if (visited.has(cursor)) break;
		visited.add(cursor);
		const batchLimit = Math.min(100, limit - notifications.length);
		const rows = await c.call<Json[]>('i/notifications', { limit: batchLimit, markAsRead: false, ...(cursor ? { [ascending ? 'sinceId' : 'untilId']: cursor } : {}) });
		if (!rows.length) break;
		const ordered = [...rows].sort((a, b) => (ascending ? 1 : -1) * compareIds(string(a.id), string(b.id)));
		const candidates: Json[] = [];
		let crossedBound = false;
		for (const row of ordered) {
			const id = string(row.id);
			if ((ascending && maxId && compareIds(id, maxId) >= 0) || (!ascending && lowerBound && compareIds(id, lowerBound) <= 0)) { crossedBound = true; break; }
			if (seen.has(id)) continue;
			seen.add(id);
			candidates.push(row);
		}
		if (candidates.length) {
			const dismissedEntries = await routes.deps.store.getMany(candidates.map(row => ({ namespace: 'dismissed-notification', owner: c.userId, key: string(row.id) })));
			const dismissed = new Set(dismissedEntries.map(entry => entry.key));
			for (const row of candidates) {
				const id = string(row.id);
				cursors.push(row);
				if ((cleared && compareIds(id, cleared) <= 0) || dismissed.has(id)) continue;
				const preview = routes.deps.entities.notification(row, { viewerId: c.userId || null, allowLocalOnly: true });
				if (!preview || (types.length && !types.includes(preview.type)) || excluded.includes(preview.type) || (accountId && preview.account.id !== accountId)) continue;
				const notification = hydrate ? await convert(routes, c, row, true) : preview;
				if (!notification) continue;
				notifications.push(notification);
				if (notifications.length === limit) break;
			}
		}
		if (crossedBound || notifications.length === limit) break;
		const next = string(ordered.at(-1)!.id);
		if (cursor && (ascending ? compareIds(next, cursor) <= 0 : compareIds(next, cursor) >= 0)) break;
		cursor = next;
	}
	return { notifications: notifications.sort((a, b) => compareIds(b.id, a.id)), cursors: cursors.sort((a, b) => compareIds(b.id, a.id)) };
}

const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HEX_LOWER_CHARS = '0123456789abcdef';
const HEX_UPPER_CHARS = '0123456789ABCDEF';

function incrementAlphabet(id: string, alphabet: string): string | undefined {
	const chars = id.split('');
	for (let i = chars.length - 1; i >= 0; i--) {
		const index = alphabet.indexOf(chars[i]);
		if (index === -1) return undefined;
		if (index < alphabet.length - 1) {
			chars[i] = alphabet[index + 1];
			return chars.join('');
		}
		chars[i] = alphabet[0];
	}
	return undefined;
}

function nextProbeId(id: string): string | undefined {
	if (/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) return incrementAlphabet(id, ULID_CHARS);
	if (/^g[0-9a-f]{23}$/u.test(id)) {
		const nextHex = incrementAlphabet(id.slice(1), HEX_LOWER_CHARS);
		return nextHex ? `g${nextHex}` : undefined;
	}
	if (/^[0-9a-f]{16}$/u.test(id) || /^[0-9a-f]{24}$/u.test(id)) return incrementAlphabet(id, HEX_LOWER_CHARS);
	if (/^[0-9A-F]{16}$/u.test(id) || /^[0-9A-F]{24}$/u.test(id)) return incrementAlphabet(id, HEX_UPPER_CHARS);
	if (/^[0-9a-z]{1,32}$/u.test(id)) return incrementAlphabet(id, BASE36_CHARS);
	return undefined;
}

async function findNotification(routes: Routes, c: RequestContext, target: string): Promise<Json> {
	if (await isDismissed(routes, c, target)) throw new HttpError(404, 'Record not found');
	const cleared = await routes.deps.store.get<string>('notifications', c.userId, 'cleared');
	if (cleared && compareIds(target, cleared) <= 0) throw new HttpError(404, 'Record not found');
	const probeUntilId = nextProbeId(target);
	if (probeUntilId) {
		const probe = await c.call<Json[]>('i/notifications', { limit: 10, markAsRead: false, untilId: probeUntilId }).catch(() => []);
		const raw = probe.find(row => row.id === target);
		if (raw) {
			const result = await convert(routes, c, raw);
			if (result) return result;
			throw new HttpError(404, 'Record not found');
		}
	}
	let untilId: string | undefined;
	const visited = new Set<string>();
	let pages = 0;
	while (pages++ < MAX_SCAN_PAGES) {
		const rows = await c.call<Json[]>('i/notifications', { limit: 100, markAsRead: false, ...(untilId ? { untilId } : {}) });
		if (!rows.length) break;
		const raw = rows.find(row => row.id === target);
		if (raw) {
			const result = await convert(routes, c, raw);
			if (result) return result;
			break;
		}
		const oldest = rows.map(row => string(row.id)).sort(compareIds)[0];
		if (compareIds(oldest, target) < 0 || visited.has(oldest)) break;
		visited.add(oldest);
		untilId = oldest;
	}
	throw new HttpError(404, 'Record not found');
}

async function dismissNotification(routes: Routes, c: RequestContext, id: string): Promise<Json> {
	if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(id)) throw new HttpError(404, 'Record not found');
	await routes.deps.store.put('dismissed-notification', c.userId, id, true);
	return {};
}

async function clearNotifications(routes: Routes, c: RequestContext): Promise<Json> {
	const latest = await c.call<Json[]>('i/notifications', { limit: 1, markAsRead: false });
	await c.call('notifications/mark-all-as-read');
	if (latest[0]) {
		const latestId = string(latest[0].id);
		await routes.deps.store.transaction(async () => {
			const existing = await routes.deps.store.get<string>('notifications', c.userId, 'cleared');
			if (!existing || compareIds(latestId, existing) > 0) await routes.deps.store.put('notifications', c.userId, 'cleared', latestId);
		});
	}
	return {};
}

async function unreadCount(routes: Routes, c: RequestContext): Promise<Json> {
	const marker = await routes.deps.store.get<Json>('marker', c.userId, 'notifications');
	const query = { types: c.query.types, exclude_types: c.query.exclude_types, account_id: c.query.account_id, grouped_types: c.query.grouped_types, since_id: marker?.last_read_id };
	const page = await readPage(routes, c, integer(c.query.limit, 100, 1, 1000), query, false);
	return { count: page.notifications.length };
}

export function registerNotifications(routes: Routes): void {
	routes.add('GET', '/api/v1/notifications', 'read:notifications', async c => {
		const page = await readPage(routes, c, integer(c.query.limit, 20, 1, 80));
		return routes.page(c, page.cursors, page.notifications);
	});
	routes.add('GET', '/api/v1/notifications/:id', 'read:notifications', c => findNotification(routes, c, string(c.params.id)));
	routes.add('POST', '/api/v1/notifications/:id/dismiss', 'write:notifications', c => dismissNotification(routes, c, string(c.params.id)));
	routes.add('POST', '/api/v1/notifications/clear', 'write:notifications', c => clearNotifications(routes, c));
	routes.add('GET', '/api/v1/notifications/unread_count', 'read:notifications', c => unreadCount(routes, c));
	registerGroupedNotifications(routes);
}

export function registerGroupedNotifications(routes: Routes): void {
	routes.add('GET', '/api/v2/notifications', 'read:notifications', async c => {
		const page = await readPage(routes, c, integer(c.query.limit, 40, 1, 80));
		routes.page(c, page.cursors, []);
		return grouped(page.notifications, c, true);
	});
	routes.add('GET', '/api/v2/notifications/:group_key', 'read:notifications', async c => {
		validateQuery(c.query);
		return grouped([await findNotification(routes, c, groupNotificationId(c.params.group_key))], c, false);
	});
	routes.add('GET', '/api/v2/notifications/:group_key/accounts', 'read:notifications', async c => [(await findNotification(routes, c, groupNotificationId(c.params.group_key))).account]);
	routes.add('POST', '/api/v2/notifications/:group_key/dismiss', 'write:notifications', c => dismissNotification(routes, c, groupNotificationId(c.params.group_key)));
	routes.add('POST', '/api/v2/notifications/clear', 'write:notifications', c => clearNotifications(routes, c));
	routes.add('GET', '/api/v2/notifications/unread_count', 'read:notifications', c => unreadCount(routes, c));
}
