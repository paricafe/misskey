/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import type { Config } from '@/config.js';
import { IdService } from '@/core/IdService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DI } from '@/di-symbols.js';
import { langmap } from '@/misc/langmap.js';
import type { MiUser } from '@/models/User.js';
import type { BlockingsRepository, MiMastodonUserState, UsersRepository } from '@/models/_.js';
import { MastodonApiError } from './errors.js';
import { MastodonApiStateService, type MastodonApiStateLock } from './MastodonApiStateService.js';
import { MastodonEntityService } from './MastodonEntityService.js';

const COLLECTION_KIND = 'collection';
const MEMBERSHIP_KIND = 'collection_membership';
const COLLECTION_LIMIT = 10;
const ITEM_LIMIT = 25;
const PAGE_LIMIT = 80;
const MEMBERSHIP_SCAN_LIMIT = 1000;
export const MASTODON_COLLECTION_WINDOW_LIMIT = 1000;

type Dictionary = Record<string, unknown>;

export type MastodonCollectionItem = {
	id: string;
	account_id: MiUser['id'];
	state: 'accepted';
	created_at: string;
};

export type MastodonCollection = {
	id: string;
	account_id: MiUser['id'];
	uri: string;
	url: null;
	name: string;
	description: string | null;
	language: string | null;
	local: true;
	sensitive: boolean;
	discoverable: boolean;
	tag: { name: string; url: string } | null;
	item_count: number;
	items: MastodonCollectionItem[];
	created_at: string;
	updated_at: string;
};

export type MastodonCollectionPage = {
	items: MastodonCollection[];
	total: number;
	hasMore: boolean;
};

type StoredCollection = {
	id: string;
	accountId: MiUser['id'];
	name: string;
	description: string | null;
	language: string | null;
	sensitive: boolean;
	discoverable: boolean;
	tag: string | null;
	items: MastodonCollectionItem[];
	createdAt: string;
	updatedAt: string;
};

type StoredMembership = {
	collectionId: string;
	collectionOwnerId: MiUser['id'];
	item: MastodonCollectionItem;
};

type CollectionInput = {
	name?: string;
	description?: string | null;
	language?: string | null;
	tag?: string | null;
	sensitive?: boolean;
	discoverable?: boolean;
	accountIds?: MiUser['id'][];
};

type ReconciledCollection = {
	stored: StoredCollection;
	owner: MiUser;
	users: Map<MiUser['id'], MiUser>;
};

@Injectable()
export class MastodonCollectionService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		private mastodonApiStateService: MastodonApiStateService,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		private idService: IdService,
		private userEntityService: UserEntityService,
		private mastodonEntityService: MastodonEntityService,
	) {}

	public async create(ownerId: MiUser['id'], rawInput: Dictionary): Promise<MastodonCollection> {
		const input = this.collectionInput(rawInput, true);
		const collectionId = this.idService.gen();
		const createdAt = new Date().toISOString();
		const items = (input.accountIds ?? []).map(accountId => ({
			id: this.idService.gen(),
			account_id: accountId,
			state: 'accepted' as const,
			created_at: createdAt,
		}));
		const locks: MastodonApiStateLock[] = [
			{ userId: ownerId, kind: COLLECTION_KIND },
			...items.map(item => ({ userId: item.account_id, kind: MEMBERSHIP_KIND })),
		];

		return await this.mastodonApiStateService.withUserKindLocks(locks, async stateService => {
			const existing = await stateService.list(ownerId, COLLECTION_KIND);
			if (existing.length >= COLLECTION_LIMIT) this.invalid(`You cannot create more than ${COLLECTION_LIMIT} collections`);
			await this.assertEligibleMembers(ownerId, items.map(item => item.account_id));
			const stored: StoredCollection = {
				id: collectionId,
				accountId: ownerId,
				name: input.name!,
				description: input.description ?? null,
				language: input.language ?? null,
				sensitive: input.sensitive ?? false,
				discoverable: input.discoverable ?? false,
				tag: input.tag ?? null,
				items,
				createdAt,
				updatedAt: createdAt,
			};
			await stateService.createWithId({ id: collectionId, userId: ownerId, kind: COLLECTION_KIND, key: collectionId, value: stored });
			for (const item of items) {
				await stateService.put({
					userId: item.account_id,
					kind: MEMBERSHIP_KIND,
					key: collectionId,
					value: this.membership(stored, item),
				});
			}
			return this.collection(stored);
		});
	}

	public async get(
		collectionId: string,
		viewerId: MiUser['id'] | null = null,
		options: { ignoreOwnerBlock?: boolean } = {},
	): Promise<{
		collection: MastodonCollection;
		accounts: ReturnType<MastodonEntityService['account']>[];
	}> {
		const row = await this.collectionRow(this.mastodonApiStateService, collectionId);
		if (row == null) this.notFound();
		const reconciled = await this.reconcile(row);
		if (!options.ignoreOwnerBlock && viewerId != null && viewerId !== reconciled.stored.accountId && await this.hasOwnerBlock(reconciled.stored.accountId, viewerId)) {
			this.forbidden();
		}
		const blockedIds = viewerId == null
			? new Set<MiUser['id']>()
			: await this.blockedBy(viewerId, reconciled.stored.items.map(item => item.account_id));
		const visibleItems = reconciled.stored.items.filter(item => !blockedIds.has(item.account_id));
		const visibleUsers = [
			reconciled.owner,
			...visibleItems.map(item => reconciled.users.get(item.account_id)).filter((user): user is MiUser => user != null),
		];
		const packed = await this.userEntityService.packMany(visibleUsers, viewerId == null ? null : { id: viewerId }, { schema: 'UserDetailed' });
		const packedById = new Map(packed.map(user => [user.id, user]));
		const accounts = visibleUsers
			.map(user => packedById.get(user.id))
			.filter((user): user is NonNullable<typeof user> => user != null)
			.map(user => this.mastodonEntityService.account(user));
		return {
			collection: this.collection({ ...reconciled.stored, items: visibleItems }),
			accounts,
		};
	}

	public async listByAccount(
		accountId: MiUser['id'],
		viewerId: MiUser['id'] | null,
		page: { offset: number; limit: number },
	): Promise<MastodonCollectionPage> {
		const account = await this.users(accountId);
		if (account == null) this.notFound('Account not found');
		if (viewerId != null && viewerId !== accountId && await this.hasOwnerBlock(accountId, viewerId)) return { items: [], total: 0, hasMore: false };
		const rows = await this.mastodonApiStateService.list(accountId, COLLECTION_KIND);
		const collections: MastodonCollection[] = [];
		for (const row of rows) {
			const stored = this.storedCollection(row);
			if (stored == null || (viewerId !== accountId && !stored.discoverable)) continue;
			try {
				collections.push((await this.get(stored.id, viewerId)).collection);
			} catch (error) {
				if (!(error instanceof MastodonApiError) || ![403, 404].includes(error.statusCode)) throw error;
			}
		}
		collections.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
		const pagination = this.page(page);
		return {
			items: collections.slice(pagination.offset, pagination.offset + pagination.limit),
			total: collections.length,
			hasMore: pagination.offset + pagination.limit < collections.length,
		};
	}

	public async listInCollections(
		accountId: MiUser['id'],
		viewerId: MiUser['id'],
		page: { offset: number; limit: number },
	): Promise<MastodonCollectionPage> {
		if (accountId !== viewerId) this.forbidden();
		const pagination = this.page(page);
		const needed = pagination.offset + pagination.limit + 1;
		const collections: MastodonCollection[] = [];
		let scanOffset = 0;
		let rawScanned = 0;
		let rawEnd = false;
		while (collections.length < needed && !rawEnd) {
			const chunk = await this.mastodonApiStateService.listPage(accountId, MEMBERSHIP_KIND, {
				offset: scanOffset,
				limit: Math.min(PAGE_LIMIT, MEMBERSHIP_SCAN_LIMIT - rawScanned),
			});
			if (chunk.items.length === 0) break;
			rawScanned += chunk.items.length;
			let validInChunk = 0;
			for (const row of chunk.items) {
				if (!(await this.validMembership(row))) continue;
				const membership = this.storedMembership(row);
				if (membership == null) continue;
				try {
					const collection = (await this.get(membership.collectionId, viewerId, { ignoreOwnerBlock: true })).collection;
					validInChunk++;
					collections.push(collection);
				} catch (error) {
					if (!(error instanceof MastodonApiError) || ![403, 404].includes(error.statusCode)) throw error;
					if (error.statusCode === 403) validInChunk++;
				}
				if (collections.length >= needed) break;
			}
			scanOffset += validInChunk;
			rawEnd = scanOffset >= chunk.total;
			if (!rawEnd && collections.length < needed && rawScanned >= MEMBERSHIP_SCAN_LIMIT) {
				this.invalid(`collection membership scan exceeds ${MEMBERSHIP_SCAN_LIMIT} rows`);
			}
		}
		const hasMore = collections.length > pagination.offset + pagination.limit;
		const items = collections.slice(pagination.offset, pagination.offset + pagination.limit);
		return {
			items,
			total: pagination.offset + items.length + (hasMore ? 1 : 0),
			hasMore,
		};
	}

	public async update(ownerId: MiUser['id'], collectionId: string, rawInput: Dictionary): Promise<MastodonCollection> {
		const input = this.collectionInput(rawInput, false);
		const row = await this.collectionRow(this.mastodonApiStateService, collectionId);
		if (row == null) this.notFound();
		return await this.mastodonApiStateService.withUserKindLocks([{ userId: row.userId, kind: COLLECTION_KIND }], async stateService => {
			const current = await this.requireOwned(stateService, ownerId, collectionId);
			const updated: StoredCollection = {
				...current,
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.description === undefined ? {} : { description: input.description }),
				...(input.language === undefined ? {} : { language: input.language }),
				...(input.tag === undefined ? {} : { tag: input.tag }),
				...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
				...(input.discoverable === undefined ? {} : { discoverable: input.discoverable }),
				updatedAt: new Date().toISOString(),
			};
			await stateService.put({ userId: current.accountId, kind: COLLECTION_KIND, key: collectionId, value: updated });
			return this.collection(updated);
		});
	}

	public async delete(ownerId: MiUser['id'], collectionId: string): Promise<Record<string, never>> {
		const initial = await this.collectionRow(this.mastodonApiStateService, collectionId);
		if (initial == null) return this.notFound();
		let candidate: MiMastodonUserState = initial;
		while (true) {
			const preflight = this.storedCollection(candidate);
			if (preflight == null) return this.notFound();
			const lockedAccountIds = new Set(preflight.items.map(item => item.account_id));
			const result = await this.mastodonApiStateService.withUserKindLocks<
				{ retry: MiMastodonUserState } | { value: Record<string, never> }
			>([
				{ userId: candidate.userId, kind: COLLECTION_KIND },
				...preflight.items.map(item => ({ userId: item.account_id, kind: MEMBERSHIP_KIND })),
			], async stateService => {
				const reread = await this.collectionRow(stateService, collectionId);
				if (reread == null) return this.notFound();
				const current = this.storedCollection(reread);
				if (current == null) return this.notFound();
				if (current.accountId !== ownerId) return this.forbidden();
				if (current.items.some(item => !lockedAccountIds.has(item.account_id))) return { retry: reread };
				for (const item of current.items) await stateService.delete(item.account_id, MEMBERSHIP_KIND, collectionId);
				await stateService.delete(current.accountId, COLLECTION_KIND, collectionId);
				return { value: {} };
			});
			if ('retry' in result) {
				candidate = result.retry;
				continue;
			}
			return result.value;
		}
	}

	public async addItem(ownerId: MiUser['id'], collectionId: string, accountId: MiUser['id']): Promise<MastodonCollectionItem> {
		if (typeof accountId !== 'string' || accountId === '') this.invalid('`account_id` parameter is missing');
		const row = await this.collectionRow(this.mastodonApiStateService, collectionId);
		if (row == null) this.notFound();
		const item: MastodonCollectionItem = {
			id: this.idService.gen(),
			account_id: accountId,
			state: 'accepted',
			created_at: new Date().toISOString(),
		};
		return await this.mastodonApiStateService.withUserKindLocks([
			{ userId: row.userId, kind: COLLECTION_KIND },
			{ userId: accountId, kind: MEMBERSHIP_KIND },
		], async stateService => {
			const current = await this.requireOwned(stateService, ownerId, collectionId);
			if (current.items.some(currentItem => currentItem.account_id === accountId)) this.invalid('Account is already in this collection');
			if (current.items.length >= ITEM_LIMIT) this.invalid(`A collection cannot contain more than ${ITEM_LIMIT} accounts`);
			await this.assertEligibleMembers(ownerId, [accountId]);
			const updated = { ...current, items: [...current.items, item], updatedAt: item.created_at };
			await stateService.put({ userId: ownerId, kind: COLLECTION_KIND, key: collectionId, value: updated });
			await stateService.put({ userId: accountId, kind: MEMBERSHIP_KIND, key: collectionId, value: this.membership(updated, item) });
			return item;
		});
	}

	public async removeItem(ownerId: MiUser['id'], collectionId: string, itemId: string): Promise<Record<string, never>> {
		const row = await this.collectionRow(this.mastodonApiStateService, collectionId);
		if (row == null) this.notFound();
		const preflight = this.storedCollection(row);
		const targetId = preflight?.items.find(item => item.id === itemId)?.account_id;
		return await this.mastodonApiStateService.withUserKindLocks([
			{ userId: row.userId, kind: COLLECTION_KIND },
			...(targetId == null ? [] : [{ userId: targetId, kind: MEMBERSHIP_KIND }]),
		], async stateService => {
			const current = await this.requireOwned(stateService, ownerId, collectionId);
			const item = current.items.find(currentItem => currentItem.id === itemId);
			if (item == null) this.notFound('Collection item not found');
			await this.removeLocked(stateService, current, item);
			return {};
		});
	}

	public async revoke(accountId: MiUser['id'], collectionId: string, itemId: string): Promise<Record<string, never>> {
		const row = await this.collectionRow(this.mastodonApiStateService, collectionId);
		if (row == null) this.notFound();
		return await this.mastodonApiStateService.withUserKindLocks([
			{ userId: row.userId, kind: COLLECTION_KIND },
			{ userId: accountId, kind: MEMBERSHIP_KIND },
		], async stateService => {
			const reread = await this.collectionRow(stateService, collectionId);
			const current = reread == null ? null : this.storedCollection(reread);
			if (current == null) this.notFound();
			const item = current.items.find(currentItem => currentItem.id === itemId);
			if (item == null || item.account_id !== accountId) this.forbidden();
			await this.removeLocked(stateService, current, item);
			return {};
		});
	}

	private collection(stored: StoredCollection): MastodonCollection {
		return {
			id: stored.id,
			account_id: stored.accountId,
			uri: new URL(`/api/v1/collections/${encodeURIComponent(stored.id)}`, this.config.url).toString(),
			url: null,
			name: stored.name,
			description: stored.description,
			language: stored.language,
			local: true,
			sensitive: stored.sensitive,
			discoverable: stored.discoverable,
			tag: stored.tag == null ? null : {
				name: stored.tag,
				url: new URL(`/tags/${encodeURIComponent(stored.tag)}`, this.config.url).toString(),
			},
			item_count: stored.items.length,
			items: stored.items,
			created_at: stored.createdAt,
			updated_at: stored.updatedAt,
		};
	}

	private collectionInput(rawInput: Dictionary, creating: boolean): CollectionInput {
		const input: CollectionInput = {};
		if (creating || Object.hasOwn(rawInput, 'name')) input.name = this.name(rawInput.name);
		if (Object.hasOwn(rawInput, 'description')) input.description = this.nullableString(rawInput.description, 100, 'description');
		if (Object.hasOwn(rawInput, 'language')) input.language = this.language(rawInput.language);
		if (Object.hasOwn(rawInput, 'tag_name')) input.tag = this.tag(rawInput.tag_name);
		if (Object.hasOwn(rawInput, 'sensitive')) input.sensitive = this.boolean(rawInput.sensitive, 'sensitive');
		if (Object.hasOwn(rawInput, 'discoverable')) input.discoverable = this.boolean(rawInput.discoverable, 'discoverable');
		if (creating && Object.hasOwn(rawInput, 'account_ids')) {
			if (!Array.isArray(rawInput.account_ids) || rawInput.account_ids.some(id => typeof id !== 'string' || id === '')) this.invalid('Invalid account_ids');
			input.accountIds = rawInput.account_ids as string[];
			if (input.accountIds.length > ITEM_LIMIT) this.invalid(`A collection cannot contain more than ${ITEM_LIMIT} accounts`);
			if (new Set(input.accountIds).size !== input.accountIds.length) this.invalid('Duplicate account_ids are not allowed');
		}
		return input;
	}

	private name(value: unknown): string {
		if (typeof value !== 'string' || value.trim() === '' || [...value].length > 40) this.invalid('Name must be between 1 and 40 characters');
		return value;
	}

	private nullableString(value: unknown, limit: number, field: string): string | null {
		if (value === null) return null;
		if (typeof value !== 'string' || [...value].length > limit) this.invalid(`${field} is too long`);
		return value;
	}

	private language(value: unknown): string | null {
		if (value === null) return null;
		if (typeof value !== 'string') this.invalid('Unsupported language');
		const language = value.normalize('NFKC').trim();
		if (!Object.hasOwn(langmap, language)) this.invalid('Unsupported language');
		return language;
	}

	private tag(value: unknown): string | null {
		if (value === null || value === '') return null;
		if (typeof value !== 'string') this.invalid('Invalid hashtag name');
		const name = value.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase();
		if (name === '' || [...name].length > 100 || !/^[\p{L}\p{M}\p{N}_]+$/u.test(name)) this.invalid('Invalid hashtag name');
		return name;
	}

	private boolean(value: unknown, field: string): boolean {
		if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return true;
		if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
		this.invalid(`${field} must be a boolean`);
	}

	private page(page: { offset: number; limit: number }): { offset: number; limit: number } {
		const offset = Math.max(0, Math.floor(page.offset));
		const limit = Math.max(1, Math.min(PAGE_LIMIT, Math.floor(page.limit)));
		if (offset + limit > MASTODON_COLLECTION_WINDOW_LIMIT) this.invalid(`collection window exceeds ${MASTODON_COLLECTION_WINDOW_LIMIT}`);
		return { offset, limit };
	}

	private async assertEligibleMembers(ownerId: MiUser['id'], accountIds: MiUser['id'][]): Promise<void> {
		if (accountIds.length === 0) return;
		const requested = new Set(accountIds);
		const users = await this.usersRepository.findBy({ id: In(accountIds) });
		const usersById = new Map(users.filter(user => requested.has(user.id)).map(user => [user.id, user]));
		if (accountIds.some(id => {
			const user = usersById.get(id);
			return user == null || user.host != null || user.isSuspended;
		})) this.invalid('One or more accounts cannot be added to collections');
		const blocks = await this.blockingsRepository.findBy({
			blockerId: In([ownerId, ...accountIds]),
			blockeeId: In([ownerId, ...accountIds]),
		});
		if (blocks.some(block => (
			block.blockerId === ownerId && requested.has(block.blockeeId)
		) || (
			block.blockeeId === ownerId && requested.has(block.blockerId)
		))) this.invalid('Blocked accounts cannot be added to collections');
	}

	private async reconcile(initialRow: MiMastodonUserState): Promise<ReconciledCollection> {
		let candidate = initialRow;
		while (true) {
			const preflight = this.storedCollection(candidate);
			if (preflight == null) this.notFound();
			const lockedAccountIds = new Set(preflight.items.map(item => item.account_id));
			const result = await this.mastodonApiStateService.withUserKindLocks<
				{ retry: MiMastodonUserState } | { value: ReconciledCollection }
			>([
				{ userId: preflight.accountId, kind: COLLECTION_KIND },
				...preflight.items.map(item => ({ userId: item.account_id, kind: MEMBERSHIP_KIND })),
			], async stateService => {
				const reread = await this.collectionRow(stateService, preflight.id);
				if (reread == null) return this.notFound();
				const stored = this.storedCollection(reread);
				if (stored == null) return this.notFound();
				if (stored.items.some(item => !lockedAccountIds.has(item.account_id))) return { retry: reread };
				const ids = [stored.accountId, ...stored.items.map(item => item.account_id)];
				const requested = new Set(ids);
				const found = await this.usersRepository.findBy({ id: In(ids) });
				const users = new Map(found.filter(user => requested.has(user.id)).map(user => [user.id, user]));
				const owner = users.get(stored.accountId);
				if (owner == null) {
					for (const item of stored.items) await stateService.delete(item.account_id, MEMBERSHIP_KIND, stored.id);
					await stateService.delete(stored.accountId, COLLECTION_KIND, stored.id);
					this.notFound();
				}
				const validItems = stored.items.filter(item => users.has(item.account_id));
				if (validItems.length !== stored.items.length) {
					const validIds = new Set(validItems.map(item => item.account_id));
					for (const item of stored.items) {
						if (!validIds.has(item.account_id)) await stateService.delete(item.account_id, MEMBERSHIP_KIND, stored.id);
					}
					stored.items = validItems;
					stored.updatedAt = new Date().toISOString();
					await stateService.put({ userId: stored.accountId, kind: COLLECTION_KIND, key: stored.id, value: stored });
				}
				for (const item of validItems) {
					const reverse = await stateService.get(item.account_id, MEMBERSHIP_KIND, stored.id);
					const membership = reverse == null ? null : this.storedMembership(reverse);
					if (membership?.collectionId !== stored.id || membership.collectionOwnerId !== stored.accountId || membership.item.id !== item.id || membership.item.account_id !== item.account_id) {
						await stateService.put({
							userId: item.account_id,
							kind: MEMBERSHIP_KIND,
							key: stored.id,
							value: this.membership(stored, item),
						});
					}
				}
				return { value: { stored, owner, users } };
			});
			if ('retry' in result) {
				candidate = result.retry;
				continue;
			}
			return result.value;
		}
	}

	private async validMembership(row: MiMastodonUserState): Promise<boolean> {
		const membership = this.storedMembership(row);
		if (membership == null) {
			await this.mastodonApiStateService.withUserKindLocks([{ userId: row.userId, kind: MEMBERSHIP_KIND }], async stateService => {
				await stateService.delete(row.userId, MEMBERSHIP_KIND, row.key);
			});
			return false;
		}
		const master = await this.collectionRow(this.mastodonApiStateService, membership.collectionId);
		const stored = master == null ? null : this.storedCollection(master);
		const valid = stored?.items.some(item => item.id === membership.item.id && item.account_id === row.userId) ?? false;
		if (valid) return true;
		return await this.mastodonApiStateService.withUserKindLocks([
			{ userId: row.userId, kind: MEMBERSHIP_KIND },
			...(stored == null ? [] : [{ userId: stored.accountId, kind: COLLECTION_KIND }]),
		], async stateService => {
			const reread = await this.collectionRow(stateService, membership.collectionId);
			const current = reread == null ? null : this.storedCollection(reread);
			if (current?.items.some(item => item.id === membership.item.id && item.account_id === row.userId)) return true;
			await stateService.delete(row.userId, MEMBERSHIP_KIND, membership.collectionId);
			return false;
		});
	}

	private async collectionRow(
		stateService: MastodonApiStateService,
		collectionId: string,
	): Promise<MiMastodonUserState | null> {
		const row = await stateService.getById(collectionId);
		return row?.kind === COLLECTION_KIND ? row : null;
	}

	private async requireOwned(stateService: MastodonApiStateService, ownerId: MiUser['id'], collectionId: string): Promise<StoredCollection> {
		const row = await this.collectionRow(stateService, collectionId);
		const stored = row == null ? null : this.storedCollection(row);
		if (stored == null) this.notFound();
		if (stored.accountId !== ownerId) this.forbidden();
		return stored;
	}

	private async removeLocked(stateService: MastodonApiStateService, stored: StoredCollection, item: MastodonCollectionItem): Promise<void> {
		const updated = {
			...stored,
			items: stored.items.filter(current => current.id !== item.id),
			updatedAt: new Date().toISOString(),
		};
		await stateService.put({ userId: stored.accountId, kind: COLLECTION_KIND, key: stored.id, value: updated });
		await stateService.delete(item.account_id, MEMBERSHIP_KIND, stored.id);
	}

	private async users(userId: MiUser['id']): Promise<MiUser | null> {
		return (await this.usersRepository.findBy({ id: In([userId]) })).find(user => user.id === userId) ?? null;
	}

	private async hasOwnerBlock(ownerId: MiUser['id'], viewerId: MiUser['id']): Promise<boolean> {
		const blocks = await this.blockingsRepository.findBy({ blockerId: ownerId, blockeeId: viewerId });
		return blocks.some(block => block.blockerId === ownerId && block.blockeeId === viewerId);
	}

	private async blockedBy(viewerId: MiUser['id'], accountIds: MiUser['id'][]): Promise<Set<MiUser['id']>> {
		if (accountIds.length === 0) return new Set();
		const requested = new Set(accountIds);
		const blocks = await this.blockingsRepository.findBy({ blockerId: viewerId, blockeeId: In(accountIds) });
		return new Set(blocks
			.filter(block => block.blockerId === viewerId && requested.has(block.blockeeId))
			.map(block => block.blockeeId));
	}

	private membership(stored: StoredCollection, item: MastodonCollectionItem): StoredMembership {
		return { collectionId: stored.id, collectionOwnerId: stored.accountId, item };
	}

	private storedCollection(row: Pick<MiMastodonUserState, 'key' | 'userId' | 'value'>): StoredCollection | null {
		const value = row.value;
		if (!this.record(value) || typeof value.name !== 'string' || !Array.isArray(value.items)) return null;
		const items = value.items.filter((item): item is MastodonCollectionItem => this.item(item));
		return {
			id: typeof value.id === 'string' ? value.id : row.key,
			accountId: typeof value.accountId === 'string' ? value.accountId : row.userId,
			name: value.name,
			description: typeof value.description === 'string' || value.description === null ? value.description : null,
			language: typeof value.language === 'string' || value.language === null ? value.language : null,
			sensitive: value.sensitive === true,
			discoverable: value.discoverable === true,
			tag: typeof value.tag === 'string' || value.tag === null ? value.tag : null,
			items,
			createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
			updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
		};
	}

	private storedMembership(row: Pick<MiMastodonUserState, 'value'>): StoredMembership | null {
		const value = row.value;
		if (!this.record(value) || typeof value.collectionId !== 'string' || typeof value.collectionOwnerId !== 'string' || !this.item(value.item)) return null;
		return { collectionId: value.collectionId, collectionOwnerId: value.collectionOwnerId, item: value.item };
	}

	private item(value: unknown): value is MastodonCollectionItem {
		return this.record(value) && typeof value.id === 'string' && typeof value.account_id === 'string' && value.state === 'accepted' && typeof value.created_at === 'string';
	}

	private record(value: unknown): value is Record<string, unknown> {
		return value != null && typeof value === 'object' && !Array.isArray(value);
	}

	private invalid(description: string): never {
		throw new MastodonApiError(422, 'validation_error', description);
	}

	private forbidden(description = 'This action is not allowed'): never {
		throw new MastodonApiError(403, 'forbidden', description);
	}

	private notFound(description = 'Collection not found'): never {
		throw new MastodonApiError(404, 'not_found', description);
	}
}
