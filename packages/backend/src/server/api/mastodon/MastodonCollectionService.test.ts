/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MfmService } from '@/core/MfmService.js';
import { MastodonCollectionService } from './MastodonCollectionService.js';
import { MastodonEntityService } from './MastodonEntityService.js';

describe(MastodonCollectionService, () => {
	type User = { id: string; username: string; host: string | null; isSuspended: boolean };
	type Row = {
		id: string;
		userId: string;
		tokenId: null;
		kind: string;
		key: string;
		value: unknown;
		version: number;
		createdAt: Date;
		updatedAt: Date;
		expiresAt: null;
	};

	function createService(options: {
		users?: User[];
		blocks?: { blockerId: string; blockeeId: string }[];
	} = {}) {
		const rows: Row[] = [];
		const locks: { userId: string; kind: string }[][] = [];
		let sequence = 0;
		const idService = { gen: vi.fn(() => `id-${++sequence}`) };
		const users = options.users ?? [
			{ id: 'owner', username: 'owner', host: null, isSuspended: false },
			{ id: 'member', username: 'member', host: null, isSuspended: false },
		];
		const usersRepository = {
			findBy: vi.fn(async () => [...users]),
		};
		const blockingsRepository = {
			findBy: vi.fn(async () => [...(options.blocks ?? [])]),
		};
		const stateService = {
			list: vi.fn(async (userId: string, kind: string) => rows
				.filter(row => row.userId === userId && row.kind === kind)
				.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))),
			get: vi.fn(async (userId: string, kind: string, key: string) => rows
				.find(row => row.userId === userId && row.kind === kind && row.key === key) ?? null),
			getById: vi.fn(async (id: string) => rows.find(row => row.id === id) ?? null),
			listPage: vi.fn(async (userId: string, kind: string, page: { offset: number; limit: number }) => {
				const all = rows
					.filter(row => row.userId === userId && row.kind === kind)
					.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
				return { items: all.slice(page.offset, page.offset + page.limit), total: all.length };
			}),
			put: vi.fn(async (input: { userId: string; kind: string; key: string; value: unknown }) => {
				const existing = rows.find(row => row.userId === input.userId && row.kind === input.kind && row.key === input.key);
				const now = new Date();
				if (existing != null) {
					existing.value = input.value;
					existing.updatedAt = now;
					existing.version++;
					return existing;
				}
				const row: Row = {
					id: `state-${rows.length + 1}`,
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
				rows.push(row);
				return row;
			}),
			createWithId: vi.fn(async (input: { id: string; userId: string; kind: string; key: string; value: unknown }) => {
				if (rows.some(row => row.id === input.id || (row.userId === input.userId && row.kind === input.kind && row.key === input.key))) {
					throw Object.assign(new Error('conflict'), { statusCode: 409, code: 'conflict' });
				}
				const now = new Date();
				const row: Row = {
					id: input.id,
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
				rows.push(row);
				return row;
			}),
			delete: vi.fn(async (userId: string, kind: string, key: string) => {
				const index = rows.findIndex(row => row.userId === userId && row.kind === kind && row.key === key);
				if (index < 0) return false;
				rows.splice(index, 1);
				return true;
			}),
			withUserKindLocks: vi.fn(async (requested: { userId: string; kind: string }[], callback: (service: unknown) => unknown) => {
				locks.push(requested);
				return await callback(stateService);
			}),
		};
		const config = { url: 'https://misskey.example/' };
		const mfmService = new MfmService(config as never);
		const mastodonEntityService = new MastodonEntityService(config as never, mfmService);
		const userEntityService = {
			packMany: vi.fn(async (requested: User[]) => [...requested].reverse().map(user => ({
				id: user.id,
				username: user.username,
				host: user.host,
				isSuspended: user.isSuspended,
				createdAt: '2026-07-17T00:00:00.000Z',
			}))),
		};
		return {
			service: new MastodonCollectionService(
				config as never,
				stateService as never,
				usersRepository as never,
				blockingsRepository as never,
				idService as never,
				userEntityService as never,
				mastodonEntityService,
			),
			rows,
			locks,
			stateService,
			blockingsRepository,
			users,
		};
	}

	test('creates an exact REST-only collection and mirrors accepted items with one public id', async () => {
		const { service, rows, locks, stateService } = createService();

		const collection = await service.create('owner', {
			name: 'Nice accounts',
			description: '<script>alert(1)</script> **nice**',
			language: 'en',
			tag_name: '#Discovery',
			sensitive: true,
			discoverable: true,
			account_ids: ['member'],
		});

		expect(collection).toMatchObject({
			id: 'id-1',
			account_id: 'owner',
			uri: 'https://misskey.example/api/v1/collections/id-1',
			url: null,
			name: 'Nice accounts',
			language: 'en',
			local: true,
			sensitive: true,
			discoverable: true,
			tag: { name: 'discovery', url: 'https://misskey.example/tags/discovery' },
			item_count: 1,
			items: [{ id: 'id-2', account_id: 'member', state: 'accepted' }],
		});
		expect(collection.description).toBe('<script>alert(1)</script> **nice**');
		const master = rows.find(row => row.kind === 'collection');
		const reverse = rows.find(row => row.kind === 'collection_membership');
		expect((master?.value as { items: { id: string }[] }).items[0].id).toBe('id-2');
		expect(master?.id).toBe(collection.id);
		expect(stateService.createWithId).toHaveBeenCalledWith(expect.objectContaining({ id: collection.id, key: collection.id }));
		expect((reverse?.value as { item: { id: string } }).item.id).toBe('id-2');
		expect(locks[0]).toEqual(expect.arrayContaining([
			{ userId: 'owner', kind: 'collection' },
			{ userId: 'member', kind: 'collection_membership' },
		]));
	});

	test('round-trips URL, MFM, and HTML collection descriptions without transforming them', async () => {
		const { service } = createService();
		const description = 'https://example.test **bold** <b>raw</b>';

		const created = await service.create('owner', {
			name: 'Raw description',
			description,
		});

		expect(created.description).toBe(description);
		expect((await service.get(created.id, 'owner')).collection.description).toBe(description);

		const updatedDescription = `${description} updated`;
		const updated = await service.update('owner', created.id, { description: updatedDescription });

		expect(updated.description).toBe(updatedDescription);
		expect((await service.get(created.id, 'owner')).collection.description).toBe(updatedDescription);
	});

	test('enforces collection validation and rejects ineligible item accounts with 422', async () => {
		const { service } = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'remote', username: 'remote', host: 'remote.example', isSuspended: false },
				{ id: 'suspended', username: 'suspended', host: null, isSuspended: true },
			],
		});

		await expect(service.create('owner', { name: '' })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'x'.repeat(41) })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', description: 'x'.repeat(101) })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', language: 'not-a-language' })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', tag_name: '#one #two' })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', account_ids: ['missing'] })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', account_ids: ['remote'] })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', account_ids: ['suspended'] })).rejects.toMatchObject({ statusCode: 422 });
	});

	test('rejects duplicate and blocked accounts with 422', async () => {
		const { service } = createService({ blocks: [{ blockerId: 'member', blockeeId: 'owner' }] });

		await expect(service.create('owner', { name: 'valid', account_ids: ['member', 'member'] })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create('owner', { name: 'valid', account_ids: ['member'] })).rejects.toMatchObject({ statusCode: 422 });
	});

	test('accepts boolean values from JSON and form-encoded requests', async () => {
		const { service } = createService();

		await expect(service.create('owner', {
			name: 'People',
			sensitive: 'true',
			discoverable: '0',
		})).resolves.toMatchObject({ sensitive: true, discoverable: false });
	});

	test('normalizes hashtag spelling without discarding diacritics', async () => {
		const { service } = createService();

		await expect(service.create('owner', {
			name: 'People',
			tag_name: '#CAFÉ',
		})).resolves.toMatchObject({ tag: { name: 'café' } });
	});

	test('allows the tenth collection under the lock and rejects the eleventh', async () => {
		const { service, rows } = createService();
		for (let i = 0; i < 9; i++) {
			await service.create('owner', { name: `Collection ${i}` });
		}

		await expect(service.create('owner', { name: 'Tenth' })).resolves.toMatchObject({ name: 'Tenth' });
		await expect(service.create('owner', { name: 'Eleventh' })).rejects.toMatchObject({ statusCode: 422 });
		expect(rows.filter(row => row.kind === 'collection')).toHaveLength(10);
	});

	test('allows the twenty-fifth item then rejects overflow and duplicates', async () => {
		const users = [
			{ id: 'owner', username: 'owner', host: null, isSuspended: false },
			...Array.from({ length: 26 }, (_, index) => ({
				id: `member-${index}`,
				username: `member-${index}`,
				host: null,
				isSuspended: false,
			})),
		];
		const { service } = createService({ users });
		const created = await service.create('owner', {
			name: 'People',
			account_ids: users.slice(1, 25).map(user => user.id),
		});

		await expect(service.addItem('owner', created.id, 'member-24')).resolves.toMatchObject({ account_id: 'member-24' });
		await expect(service.addItem('owner', created.id, 'member-25')).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.addItem('owner', created.id, 'member-24')).rejects.toMatchObject({ statusCode: 422 });
	});

	test('returns 403 for a known non-owner mutation and 404 for an unknown collection', async () => {
		const { service } = createService();
		const created = await service.create('owner', { name: 'People' });

		await expect(service.update('member', created.id, { name: 'Nope' })).rejects.toMatchObject({ statusCode: 403 });
		await expect(service.update('member', 'missing', { name: 'Nope' })).rejects.toMatchObject({ statusCode: 404 });
	});

	test('uses the public collection id primary key for unknown reads', async () => {
		const { service, stateService } = createService();

		await expect(service.get('missing', null)).rejects.toMatchObject({ statusCode: 404 });
		expect(stateService.getById).toHaveBeenCalledWith('missing');
	});

	test('rejects a primary-key match that is not collection state', async () => {
		const { service, rows } = createService();
		const now = new Date();
		rows.push({
			id: 'marker-state',
			userId: 'owner',
			tokenId: null,
			kind: 'marker',
			key: 'home',
			value: {},
			version: 1,
			createdAt: now,
			updatedAt: now,
			expiresAt: null,
		});

		await expect(service.get('marker-state', null)).rejects.toMatchObject({ statusCode: 404 });
	});

	test('tailors blocked members, preserves suspended member shape, and keeps owner first', async () => {
		const context = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'blocked', username: 'blocked', host: null, isSuspended: false },
				{ id: 'suspended', username: 'suspended', host: null, isSuspended: false },
				{ id: 'viewer', username: 'viewer', host: null, isSuspended: false },
			],
			blocks: [{ blockerId: 'viewer', blockeeId: 'blocked' }],
		});
		const created = await context.service.create('owner', {
			name: 'People',
			account_ids: ['blocked', 'suspended'],
		});
		context.users.find(user => user.id === 'suspended')!.isSuspended = true;

		const result = await context.service.get(created.id, 'viewer');

		expect(result.collection.item_count).toBe(1);
		expect(result.collection.items.map(item => item.account_id)).toEqual(['suspended']);
		expect(result.accounts.map(account => account.id)).toEqual(['owner', 'suspended']);
	});

	test('shows undiscoverable collections only to the owner and hides an owner block from the viewer', async () => {
		const context = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'member', username: 'member', host: null, isSuspended: false },
				{ id: 'viewer', username: 'viewer', host: null, isSuspended: false },
			],
		});
		const hidden = await context.service.create('owner', { name: 'Hidden', discoverable: false });

		await expect(context.service.listByAccount('owner', null, { offset: 0, limit: 40 })).resolves.toMatchObject({ items: [] });
		await expect(context.service.listByAccount('owner', 'owner', { offset: 0, limit: 40 })).resolves.toMatchObject({ items: [{ id: hidden.id }] });
		context.rows.find(row => row.kind === 'collection')!.value = {
			...(context.rows.find(row => row.kind === 'collection')!.value as Record<string, unknown>),
			discoverable: true,
		};
		context.blockingsRepository.findBy.mockResolvedValue([{ blockerId: 'owner', blockeeId: 'viewer' }]);

		await expect(context.service.get(hidden.id, 'viewer')).rejects.toMatchObject({ statusCode: 403 });
		await expect(context.service.listByAccount('owner', 'viewer', { offset: 0, limit: 40 })).resolves.toMatchObject({ items: [] });
	});

	test('keeps a collection visible when the viewer blocks its owner', async () => {
		const context = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'viewer', username: 'viewer', host: null, isSuspended: false },
			],
			blocks: [{ blockerId: 'viewer', blockeeId: 'owner' }],
		});
		const created = await context.service.create('owner', { name: 'People', discoverable: true });

		await expect(context.service.get(created.id, 'viewer')).resolves.toMatchObject({ collection: { id: created.id } });
		await expect(context.service.listByAccount('owner', 'viewer', { offset: 0, limit: 40 })).resolves.toMatchObject({ items: [{ id: created.id }] });
	});

	test('keeps owner-blocked memberships in in_collections so the item can revoke', async () => {
		const context = createService();
		const created = await context.service.create('owner', { name: 'People', account_ids: ['member'] });
		const itemId = created.items[0].id;
		context.blockingsRepository.findBy.mockResolvedValue([{ blockerId: 'owner', blockeeId: 'member' }]);

		await expect(context.service.listInCollections('member', 'member', { offset: 0, limit: 40 })).resolves.toMatchObject({
			items: [{ id: created.id, items: [{ id: itemId, account_id: 'member' }] }],
		});
		await expect(context.service.revoke('member', created.id, itemId)).resolves.toEqual({});
	});

	test('repairs both sides when a member is actually deleted', async () => {
		const context = createService();
		const created = await context.service.create('owner', { name: 'People', account_ids: ['member'] });
		context.users.splice(context.users.findIndex(user => user.id === 'member'), 1);

		const result = await context.service.get(created.id, 'owner');

		expect(result.collection.items).toEqual([]);
		expect(context.rows.some(row => row.kind === 'collection_membership')).toBe(false);
		expect((context.rows.find(row => row.kind === 'collection')?.value as { items: unknown[] }).items).toEqual([]);
	});

	test('rebuilds a missing reverse membership while holding the collection locks', async () => {
		const context = createService();
		const created = await context.service.create('owner', { name: 'People', account_ids: ['member'] });
		context.rows.splice(context.rows.findIndex(row => row.kind === 'collection_membership'), 1);

		await context.service.get(created.id, 'owner');

		const reverse = context.rows.find(row => row.kind === 'collection_membership');
		expect(reverse).toMatchObject({ userId: 'member', key: created.id });
		expect((reverse?.value as { item: { id: string } }).item.id).toBe(created.items[0].id);
	});

	test('retries reconciliation with an expanded lock set after a concurrent add', async () => {
		const context = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'member', username: 'member', host: null, isSuspended: false },
				{ id: 'late-member', username: 'late-member', host: null, isSuspended: false },
			],
		});
		const created = await context.service.create('owner', { name: 'People', account_ids: ['member'] });
		const master = context.rows.find(row => row.kind === 'collection')!;
		const lateItem = {
			id: 'late-item',
			account_id: 'late-member',
			state: 'accepted',
			created_at: '2026-07-17T00:01:00.000Z',
		};
		let concurrentAdd = true;
		context.stateService.withUserKindLocks.mockReset();
		context.stateService.withUserKindLocks.mockImplementation(async (_locks, callback) => {
			if (concurrentAdd) {
				(master.value as { items: unknown[] }).items.push(lateItem);
				concurrentAdd = false;
			}
			return await callback(context.stateService);
		});

		await context.service.get(created.id, 'owner');

		expect(context.stateService.withUserKindLocks).toHaveBeenCalledTimes(2);
		expect(context.stateService.withUserKindLocks.mock.calls[1][0]).toContainEqual({
			userId: 'late-member',
			kind: 'collection_membership',
		});
		expect(context.rows.find(row => row.userId === 'late-member' && row.kind === 'collection_membership')).toBeDefined();
	});

	test('retries deletion with an expanded lock set after a concurrent add', async () => {
		const context = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'late-member', username: 'late-member', host: null, isSuspended: false },
			],
		});
		const created = await context.service.create('owner', { name: 'People' });
		const master = context.rows.find(row => row.kind === 'collection')!;
		const lateItem = {
			id: 'late-item',
			account_id: 'late-member',
			state: 'accepted',
			created_at: '2026-07-17T00:01:00.000Z',
		};
		let concurrentAdd = true;
		context.stateService.withUserKindLocks.mockReset();
		context.stateService.withUserKindLocks.mockImplementation(async (_locks, callback) => {
			if (concurrentAdd) {
				(master.value as { items: unknown[] }).items.push(lateItem);
				await context.stateService.put({
					userId: 'late-member',
					kind: 'collection_membership',
					key: created.id,
					value: { collectionId: created.id, collectionOwnerId: 'owner', item: lateItem },
				});
				concurrentAdd = false;
			}
			return await callback(context.stateService);
		});

		await context.service.delete('owner', created.id);

		expect(context.stateService.withUserKindLocks).toHaveBeenCalledTimes(2);
		expect(context.stateService.withUserKindLocks.mock.calls[1][0]).toContainEqual({
			userId: 'late-member',
			kind: 'collection_membership',
		});
		expect(context.rows).toEqual([]);
	});

	test('stops reverse scanning after offset plus limit plus one visible collections', async () => {
		const context = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'owner-2', username: 'owner-2', host: null, isSuspended: false },
				{ id: 'member', username: 'member', host: null, isSuspended: false },
			],
		});
		await context.service.create('owner', { name: 'First', account_ids: ['member'] });
		await context.service.create('owner-2', { name: 'Second', account_ids: ['member'] });
		const reverse = context.rows.filter(row => row.kind === 'collection_membership');
		context.stateService.listPage.mockReset();
		context.stateService.listPage
			.mockResolvedValueOnce({ items: reverse, total: 100 })
			.mockRejectedValueOnce(new Error('unbounded scan'));

		const page = await context.service.listInCollections('member', 'member', { offset: 0, limit: 1 });

		expect(page.items).toHaveLength(1);
		expect(page.hasMore).toBe(true);
		expect(context.stateService.listPage).toHaveBeenCalledTimes(1);
	});

	test('rejects reverse-list offsets beyond the bounded scan window', async () => {
		const context = createService();

		await expect(context.service.listInCollections('member', 'member', { offset: 1000, limit: 1 })).rejects.toMatchObject({
			statusCode: 422,
			description: 'collection window exceeds 1000',
		});
		expect(context.stateService.listPage).not.toHaveBeenCalled();
	});

	test('bounds raw reverse scanning when blocked memberships never become visible', async () => {
		const context = createService({ blocks: [{ blockerId: 'member', blockeeId: 'owner' }] });
		const createdAt = new Date('2026-07-17T00:00:00.000Z');
		for (let index = 0; index < 1001; index++) {
			const collectionId = `collection-${index}`;
			const item = {
				id: `item-${index}`,
				account_id: 'member',
				state: 'accepted',
				created_at: createdAt.toISOString(),
			};
			context.rows.push({
				id: `master-${index}`,
				userId: 'owner',
				tokenId: null,
				kind: 'collection',
				key: collectionId,
				value: { id: collectionId, accountId: 'owner', name: collectionId, items: [item] },
				version: 1,
				createdAt,
				updatedAt: createdAt,
				expiresAt: null,
			}, {
				id: `reverse-${index}`,
				userId: 'member',
				tokenId: null,
				kind: 'collection_membership',
				key: collectionId,
				value: { collectionId, collectionOwnerId: 'owner', item },
				version: 1,
				createdAt,
				updatedAt: createdAt,
				expiresAt: null,
			});
		}

		await expect(context.service.listInCollections('member', 'member', { offset: 0, limit: 1 })).rejects.toMatchObject({
			statusCode: 422,
			description: 'collection membership scan exceeds 1000 rows',
		});
		const requestedRows = context.stateService.listPage.mock.calls.reduce((total, call) => total + call[2].limit, 0);
		expect(requestedRows).toBeLessThanOrEqual(1000);
	});

	test('does not skip a membership after stale-owner cleanup at an 80-row boundary', async () => {
		const users = [
			{ id: 'member', username: 'member', host: null, isSuspended: false },
			...Array.from({ length: 82 }, (_, index) => ({
				id: `owner-${index}`,
				username: `owner-${index}`,
				host: null,
				isSuspended: false,
			})),
		];
		const context = createService({ users });
		for (const owner of users.slice(1)) {
			await context.service.create(owner.id, { name: owner.username, account_ids: ['member'] });
		}
		const orderedReverseRows = context.rows
			.filter(row => row.userId === 'member' && row.kind === 'collection_membership')
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
		const staleOwnerId = (orderedReverseRows[40].value as { collectionOwnerId: string }).collectionOwnerId;
		users.splice(users.findIndex(user => user.id === staleOwnerId), 1);
		context.stateService.listPage.mockClear();

		const page = await context.service.listInCollections('member', 'member', { offset: 0, limit: 80 });

		expect(page.items).toHaveLength(80);
		expect(page.hasMore).toBe(true);
		expect(new Set(page.items.map(collection => collection.id)).size).toBe(80);
		expect(context.stateService.listPage).toHaveBeenCalledTimes(2);
	});

	test('allows in_collections only for the authenticated account and removes dangling reverse rows', async () => {
		const context = createService();
		const created = await context.service.create('owner', { name: 'People', account_ids: ['member'] });
		context.rows.splice(context.rows.findIndex(row => row.kind === 'collection'), 1);

		await expect(context.service.listInCollections('member', 'owner', { offset: 0, limit: 40 })).rejects.toMatchObject({ statusCode: 403 });
		await expect(context.service.listInCollections('member', 'member', { offset: 0, limit: 40 })).resolves.toMatchObject({ items: [], hasMore: false });
		expect(context.rows.some(row => row.kind === 'collection_membership' && row.key === created.id)).toBe(false);
	});

	test('revoke succeeds only for the account represented by the item', async () => {
		const { service } = createService({
			users: [
				{ id: 'owner', username: 'owner', host: null, isSuspended: false },
				{ id: 'member', username: 'member', host: null, isSuspended: false },
				{ id: 'other', username: 'other', host: null, isSuspended: false },
			],
		});
		const created = await service.create('owner', { name: 'People', account_ids: ['member'] });
		const itemId = created.items[0].id;

		await expect(service.revoke('other', created.id, itemId)).rejects.toMatchObject({ statusCode: 403 });
		await expect(service.revoke('member', created.id, itemId)).resolves.toEqual({});
		await expect(service.get(created.id, 'owner')).resolves.toMatchObject({ collection: { item_count: 0 } });
	});
});
