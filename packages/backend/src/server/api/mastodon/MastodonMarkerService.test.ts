/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from './errors.js';
import { MastodonMarkerService } from './MastodonMarkerService.js';

describe(MastodonMarkerService, () => {
	function createService() {
		const rows = new Map<string, {
			id: string;
			userId: string;
			tokenId: null;
			kind: string;
			key: string;
			value: { lastReadId: string };
			version: number;
			createdAt: Date;
			updatedAt: Date;
			expiresAt: null;
		}>();
		let lockTail = Promise.resolve();
		const stateService = {
			get: vi.fn(async (userId: string, kind: string, key: string) => {
				const row = rows.get(key);
				return row?.userId === userId && row.kind === kind ? row : null;
			}),
			createIfAbsent: vi.fn(async (input: { userId: string; kind: string; key: string; value: { lastReadId: string } }) => {
				if (rows.has(input.key)) {
					throw Object.assign(new MastodonApiError(409, 'conflict', 'The compatibility state has changed'), { code: 'conflict' });
				}
				const now = new Date('2026-07-17T01:02:03.000Z');
				const row = {
					id: `state-${input.key}`,
					userId: input.userId,
					tokenId: null,
					kind: input.kind,
					key: input.key,
					value: input.value,
					version: 1,
					createdAt: now,
					updatedAt: now,
					expiresAt: null,
				};
				rows.set(input.key, row);
				return row;
			}),
			compareAndSet: vi.fn(async (input: { userId: string; kind: string; key: string; expectedVersion: number; value: { lastReadId: string } }) => {
				const previous = rows.get(input.key);
				if (previous == null || previous.version !== input.expectedVersion) {
					throw Object.assign(new MastodonApiError(409, 'conflict', 'The compatibility state has changed'), { code: 'conflict' });
				}
				const row = {
					...previous,
					value: input.value,
					version: previous.version + 1,
					updatedAt: new Date('2026-07-17T01:03:00.000Z'),
				};
				rows.set(input.key, row);
				return row;
			}),
			withUserKindLock: vi.fn(async (_userId: string, _kind: string, callback: (service: typeof stateService) => Promise<unknown>) => {
				const previous = lockTail;
				let release!: () => void;
				lockTail = new Promise<void>(resolve => {
					release = resolve;
				});
				await previous;
				const snapshot = new Map([...rows.entries()].map(([key, row]) => [key, { ...row }]));
				try {
					return await callback(stateService);
				} catch (error) {
					rows.clear();
					for (const [key, row] of snapshot) rows.set(key, row);
					throw error;
				} finally {
					release();
				}
			}),
		};
		return { service: new MastodonMarkerService(stateService as never), stateService, rows };
	}

	test('updates home and notifications markers independently and returns Mastodon marker fields', async () => {
		const { service } = createService();

		await expect(service.update('u1', {
			home: { last_read_id: '10' },
			notifications: { last_read_id: '20' },
		})).resolves.toMatchObject({
			home: { last_read_id: '10', version: 1, updated_at: '2026-07-17T01:02:03.000Z' },
			notifications: { last_read_id: '20', version: 1, updated_at: '2026-07-17T01:02:03.000Z' },
		});
		await expect(service.get('u1', ['notifications'])).resolves.toEqual({
			notifications: { last_read_id: '20', version: 1, updated_at: '2026-07-17T01:02:03.000Z' },
		});
	});

	test('uses an atomic expected version and reports stale marker updates as 409 conflicts', async () => {
		const { service, stateService } = createService();
		await service.update('u1', { home: { last_read_id: '10' } });

		await expect(service.update('u1', { home: { last_read_id: '11', version: 1 } })).resolves.toMatchObject({
			home: { last_read_id: '11', version: 2 },
		});
		expect(stateService.compareAndSet).toHaveBeenCalledWith(expect.objectContaining({
			userId: 'u1',
			kind: 'marker',
			key: 'home',
			expectedVersion: 1,
		}));
		await expect(service.update('u1', { home: { last_read_id: '12', version: 1 } })).rejects.toMatchObject({
			statusCode: 409,
			code: 'conflict',
		});
	});

	test('rolls back every timeline when one compare-and-set conflicts', async () => {
		const { service, rows } = createService();
		await service.update('u1', {
			home: { last_read_id: '10' },
			notifications: { last_read_id: '20' },
		});

		await expect(service.update('u1', {
			home: { last_read_id: '11', version: 1 },
			notifications: { last_read_id: '21', version: 0 },
		})).rejects.toMatchObject({ statusCode: 409, code: 'conflict' });

		expect(rows.get('home')).toMatchObject({ value: { lastReadId: '10' }, version: 1 });
		expect(rows.get('notifications')).toMatchObject({ value: { lastReadId: '20' }, version: 1 });
	});

	test('validates every timeline before starting any marker write', async () => {
		const { service, rows, stateService } = createService();

		await expect(service.update('u1', {
			home: { last_read_id: '10' },
			notifications: { last_read_id: '' },
		})).rejects.toMatchObject({ statusCode: 422 });
		await Promise.resolve();

		expect(rows.size).toBe(0);
		expect(stateService.createIfAbsent).not.toHaveBeenCalled();
		expect(stateService.compareAndSet).not.toHaveBeenCalled();
	});

	test('serializes concurrent no-version updates without surfacing a compatibility conflict', async () => {
		const { service, rows, stateService } = createService();

		const results = await Promise.allSettled([
			service.update('u1', { home: { last_read_id: '10' } }),
			service.update('u1', { home: { last_read_id: '20' } }),
		]);

		expect(results.every(result => result.status === 'fulfilled')).toBe(true);
		expect(rows.get('home')).toMatchObject({ value: { lastReadId: '20' }, version: 2 });
		expect(stateService.withUserKindLock).toHaveBeenCalledTimes(2);
	});

	test('rejects unsupported timelines and malformed last-read ids', async () => {
		const { service } = createService();

		await expect(service.get('u1', ['direct'] as never)).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.update('u1', { home: { last_read_id: '' } })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.update('u1', { direct: { last_read_id: '1' } } as never)).rejects.toMatchObject({ statusCode: 422 });
	});
});
