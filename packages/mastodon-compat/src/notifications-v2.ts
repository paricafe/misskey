/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { boolean, HttpError, integer, string, strings } from './parameters.js';
import type { RequestContext, Routes } from './routes.js';
import type { Json } from './types.js';

interface NotificationPage { notifications: Json[]; cursors: Json[]; }

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function groupNotificationId(value: unknown): string {
	const key = string(value);
	if (!key.startsWith('ungrouped-') || key.length === 'ungrouped-'.length) throw new HttpError(404, 'Record not found');
	return key.slice('ungrouped-'.length);
}

function isDismissed(routes: Routes, c: RequestContext, id: string): boolean {
	const cleared = routes.deps.store.get<string>('notifications', c.userId, 'cleared');
	return !!((cleared && compareIds(id, cleared) <= 0) || routes.deps.store.get('dismissed-notification', c.userId, id));
}

async function convert(routes: Routes, c: RequestContext, row: Json): Promise<Json | null> {
	if (isDismissed(routes, c, row.id)) return null;
	const result = routes.deps.entities.notification(row);
	if (!result) return null;
	if (result.status) {
		try { result.status = await routes.status(row.note, c); } catch (error) {
			if (error instanceof HttpError && error.statusCode === 404) return null;
			throw error;
		}
	}
	return result;
}

/** A native notification is always one stable group; no temporal aggregation is fabricated. */
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

/** Fill a protocol page after filtering while retaining native cursors for progress. */
async function readPage(routes: Routes, c: RequestContext, limit: number, query = c.query): Promise<NotificationPage> {
	validateQuery(query);
	const types = strings(query.types);
	const excluded = strings(query.exclude_types);
	const accountId = string(query.account_id);
	const minId = string(query.min_id);
	const sinceId = string(query.since_id);
	const maxId = string(query.max_id);
	const cleared = routes.deps.store.get<string>('notifications', c.userId, 'cleared');
	const lowerBound = [minId || sinceId, cleared ?? ''].sort(compareIds).at(-1)!;
	if (maxId && lowerBound && compareIds(maxId, lowerBound) <= 0) return { notifications: [], cursors: [] };
	const ascending = !!minId;
	let cursor = ascending ? lowerBound : maxId;
	const notifications: Json[] = [];
	const cursors: Json[] = [];
	const seen = new Set<string>();
	const visited = new Set<string>();
	while (notifications.length < limit) {
		if (visited.has(cursor)) break;
		visited.add(cursor);
		// since_id means newest-after, while min_id selects the immediately newer
		// page. Native sinceId alone is ascending, so use it only for min_id.
		const rows = await c.call<Json[]>('i/notifications', { limit: Math.min(100, limit - notifications.length), markAsRead: false, ...(cursor ? { [ascending ? 'sinceId' : 'untilId']: cursor } : {}) });
		if (!rows.length) break;
		const ordered = [...rows].sort((a, b) => (ascending ? 1 : -1) * compareIds(string(a.id), string(b.id)));
		let crossedBound = false;
		for (const row of ordered) {
			const id = string(row.id);
			if ((ascending && maxId && compareIds(id, maxId) >= 0) || (!ascending && lowerBound && compareIds(id, lowerBound) <= 0)) { crossedBound = true; break; }
			if (seen.has(id)) continue;
			seen.add(id);
			cursors.push(row);
			const notification = await convert(routes, c, row);
			if (!notification || (types.length && !types.includes(notification.type)) || excluded.includes(notification.type) || (accountId && notification.account.id !== accountId)) continue;
			notifications.push(notification);
			if (notifications.length === limit) break;
		}
		if (crossedBound || notifications.length === limit) break;
		const next = string(ordered.at(-1)!.id);
		if (cursor && (ascending ? compareIds(next, cursor) <= 0 : compareIds(next, cursor) >= 0)) break;
		cursor = next;
	}
	return { notifications: notifications.sort((a, b) => compareIds(b.id, a.id)), cursors: cursors.sort((a, b) => compareIds(b.id, a.id)) };
}

async function findNotification(routes: Routes, c: RequestContext, target: string): Promise<Json> {
	if (isDismissed(routes, c, target)) throw new HttpError(404, 'Record not found');
	let untilId: string | undefined;
	const visited = new Set<string>();
	while (true) {
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

function dismissNotification(routes: Routes, c: RequestContext, id: string): Json {
	routes.deps.store.put('dismissed-notification', c.userId, id, true);
	return {};
}

async function clearNotifications(routes: Routes, c: RequestContext): Promise<Json> {
	const latest = await c.call<Json[]>('i/notifications', { limit: 1, markAsRead: false });
	await c.call('notifications/mark-all-as-read');
	if (latest[0]) routes.deps.store.put('notifications', c.userId, 'cleared', latest[0].id);
	return {};
}

async function unreadCount(routes: Routes, c: RequestContext): Promise<Json> {
	const marker = routes.deps.store.get<Json>('marker', c.userId, 'notifications');
	const query = { types: c.query.types, exclude_types: c.query.exclude_types, account_id: c.query.account_id, grouped_types: c.query.grouped_types, since_id: marker?.last_read_id };
	const page = await readPage(routes, c, integer(c.query.limit, 100, 1, 1000), query);
	return { count: page.notifications.length };
}

/** Both API versions share native pagination, dismissal and the notification read marker. */
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
