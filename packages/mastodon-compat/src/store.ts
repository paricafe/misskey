/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export { createPostgresStore } from './postgres-store.js';

export interface CompatClient {
	id: string;
	name: string;
	redirectUris: string[];
	scopes: string[];
	website?: string;
	createdAt: number;
}

export interface Grant {
	tokenHash: string;
	clientId: string;
	scopes: string[];
	kind: 'user' | 'app';
	userId?: string;
	nativeToken?: string;
	createdAt: number;
}

export interface AuthorizationCode {
	clientId: string;
	redirectUri: string;
	scopes: string[];
	userId: string;
	nativeToken: string;
	codeChallenge?: string;
}

export interface StoreEntry {
	namespace: string;
	owner: string;
	key: string;
	value: unknown;
	expiresAt: number | null;
}

export type StoreKey = Pick<StoreEntry, 'namespace' | 'owner' | 'key'>;

/** Storage adapters must serialize mutations with their transaction lock. */
export interface StoreAdapter {
	close(): Promise<void>;
	transaction<T>(callback: () => T | Promise<T>): Promise<T>;
	get(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined>;
	getMany(keys: StoreKey[]): Promise<StoreEntry[]>;
	put(entry: StoreEntry, insertOnly?: boolean): Promise<void>;
	delete(namespace: string, owner: string, key: string): Promise<boolean>;
	take(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined>;
	list(namespace: string, owner: string): Promise<StoreEntry[]>;
	prune(now: number): Promise<void>;
}

export const hashCredential = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomCredential = (): string => `mc_${randomBytes(32).toString('base64url')}`;

const clone = <T>(value: T): T => {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError('Compatibility values must be JSON serializable');
	return JSON.parse(json) as T;
};
const entryKey = (namespace: string, owner: string, key: string): string => JSON.stringify([namespace, owner, key]);

interface MemoryTransaction { entries: Map<string, StoreEntry>; active: boolean; }

/** Explicit test storage, with the same async isolation boundary as PostgreSQL. */
class MemoryAdapter implements StoreAdapter {
	private entries = new Map<string, StoreEntry>();
	private queue: Promise<void> = Promise.resolve();
	private readonly context = new AsyncLocalStorage<MemoryTransaction>();
	private closed = false;

	private async locked<T>(callback: () => T | Promise<T>): Promise<T> {
		const current = this.context.getStore();
		if (current) {
			if (!current.active) throw new Error('The compatibility transaction has ended');
			return callback();
		}
		let release!: () => void;
		const previous = this.queue;
		this.queue = new Promise<void>(resolve => { release = resolve; });
		await previous;
		try {
			if (this.closed) throw new Error('The compatibility store is closed');
			return await callback();
		} finally { release(); }
	}

	private data(): Map<string, StoreEntry> { return this.context.getStore()?.entries ?? this.entries; }

	async close(): Promise<void> {
		if (this.closed) return;
		await this.locked(() => { this.closed = true; });
	}

	async transaction<T>(callback: () => T | Promise<T>): Promise<T> {
		if (this.context.getStore()) return this.locked(callback);
		return this.locked(async () => {
			const current: MemoryTransaction = { entries: new Map(this.entries), active: true };
			try {
				const result = await this.context.run(current, callback);
				this.entries = current.entries;
				return result;
			} finally { current.active = false; }
		});
	}

	async get(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined> {
		return this.locked(() => {
			const entry = this.data().get(entryKey(namespace, owner, key));
			return entry ? clone(entry) : undefined;
		});
	}

	async put(entry: StoreEntry, insertOnly = false): Promise<void> {
		await this.locked(() => {
			const key = entryKey(entry.namespace, entry.owner, entry.key);
			if (insertOnly && this.data().has(key)) throw new Error('Compatibility entry already exists');
			this.data().set(key, { ...clone(entry), value: clone(entry.value) });
		});
	}

	async getMany(keys: StoreKey[]): Promise<StoreEntry[]> {
		return this.locked(() => keys.flatMap(key => {
			const entry = this.data().get(entryKey(key.namespace, key.owner, key.key));
			return entry ? [clone(entry)] : [];
		}));
	}

	async delete(namespace: string, owner: string, key: string): Promise<boolean> {
		return this.locked(() => this.data().delete(entryKey(namespace, owner, key)));
	}

	async take(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined> {
		return this.locked(() => {
			const id = entryKey(namespace, owner, key);
			const entry = this.data().get(id);
			this.data().delete(id);
			return entry ? clone(entry) : undefined;
		});
	}

	async list(namespace: string, owner: string): Promise<StoreEntry[]> {
		return this.locked(() => [...this.data().values()].filter(entry => entry.namespace === namespace && entry.owner === owner).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(clone));
	}

	async prune(now: number): Promise<void> {
		await this.locked(() => {
			for (const [key, entry] of this.data()) {
				if (['codes', 'operations'].includes(entry.namespace) && entry.expiresAt != null && entry.expiresAt <= now) this.data().delete(key);
			}
		});
	}
}

/** PostgreSQL is production storage; ':memory:' is available only when explicitly requested. */
export class CompatStore {
	private readonly adapter: StoreAdapter;

	constructor(storage: ':memory:' | StoreAdapter) {
		if (typeof storage === 'string' && storage !== ':memory:') throw new Error('Use createPostgresStore for persistent compatibility storage');
		this.adapter = storage === ':memory:' ? new MemoryAdapter() : storage;
	}

	async close(): Promise<void> { await this.adapter.close(); }

	/** Keep callbacks limited to short store operations; never perform network writes here. */
	async transaction<T>(callback: () => T | Promise<T>): Promise<T> { return this.adapter.transaction(callback); }

	async createClient(input: Omit<CompatClient, 'id' | 'createdAt'>, now = Date.now()): Promise<{ client: CompatClient; clientSecret: string }> {
		const client: CompatClient = { ...input, id: randomCredential(), createdAt: now };
		const clientSecret = randomCredential();
		await this.adapter.put({ namespace: 'clients', owner: '', key: client.id, value: { client, secretHash: hashCredential(clientSecret) }, expiresAt: null }, true);
		return { client, clientSecret };
	}

	async getClient(id: string): Promise<CompatClient | undefined> {
		const entry = await this.adapter.get('clients', '', id);
		return (entry?.value as { client: CompatClient } | undefined)?.client;
	}

	async verifyClient(id: string, secret: string): Promise<CompatClient | undefined> {
		const entry = await this.adapter.get('clients', '', id);
		const data = entry?.value as { client: CompatClient; secretHash: string } | undefined;
		if (!data) return undefined;
		const expected = Buffer.from(data.secretHash, 'hex');
		const actual = Buffer.from(hashCredential(secret), 'hex');
		return expected.length === actual.length && timingSafeEqual(expected, actual) ? data.client : undefined;
	}

	async issueCode(code: AuthorizationCode, expiresAt: number): Promise<string> {
		const raw = randomCredential();
		await this.adapter.put({ namespace: 'codes', owner: '', key: hashCredential(raw), value: code, expiresAt }, true);
		return raw;
	}

	async getCode(raw: string, now = Date.now()): Promise<AuthorizationCode | undefined> {
		const entry = await this.adapter.get('codes', '', hashCredential(raw));
		return entry?.expiresAt != null && entry.expiresAt > now ? entry.value as AuthorizationCode : undefined;
	}

	async deleteCode(raw: string): Promise<boolean> { return this.adapter.delete('codes', '', hashCredential(raw)); }

	async createGrant(input: Omit<Grant, 'tokenHash' | 'createdAt'>, now = Date.now()): Promise<{ token: string; grant: Grant }> {
		return this.transaction(async () => {
			if (!await this.getClient(input.clientId)) throw new Error('Unknown compatibility client');
			const token = randomCredential();
			const grant = { ...input, tokenHash: hashCredential(token), createdAt: now };
			await this.adapter.put({ namespace: 'grants', owner: '', key: grant.tokenHash, value: grant, expiresAt: null }, true);
			return { token, grant };
		});
	}

	async getGrant(token: string): Promise<Grant | undefined> { return (await this.adapter.get('grants', '', hashCredential(token)))?.value as Grant | undefined; }

	async revokeGrant(token: string, clientId: string): Promise<boolean> {
		return this.transaction(async () => {
			const grant = await this.getGrant(token);
			return grant?.clientId === clientId ? this.adapter.delete('grants', '', hashCredential(token)) : false;
		});
	}

	async get<T>(namespace: string, ownerId: string, key: string): Promise<T | undefined> { return (await this.adapter.get(`kv:${namespace}`, ownerId, key))?.value as T | undefined; }

	async getMany(keys: StoreKey[]): Promise<StoreEntry[]> {
		if (keys.length === 0) return [];
		const entries = await this.adapter.getMany(keys.map(key => ({ ...key, namespace: `kv:${key.namespace}` })));
		return entries.map(entry => ({ ...entry, namespace: entry.namespace.slice(3) }));
	}

	async put(namespace: string, ownerId: string, key: string, value: unknown): Promise<void> {
		await this.adapter.put({ namespace: `kv:${namespace}`, owner: ownerId, key, value, expiresAt: null });
	}

	async list<T>(namespace: string, ownerId: string): Promise<Array<{ key: string; value: T }>> {
		return (await this.adapter.list(`kv:${namespace}`, ownerId)).map(entry => ({ key: entry.key, value: entry.value as T }));
	}

	async delete(namespace: string, ownerId: string, key: string): Promise<boolean> { return this.adapter.delete(`kv:${namespace}`, ownerId, key); }

	async putOperation(kind: string, id: string, value: unknown, expiresAt: number): Promise<void> {
		await this.adapter.put({ namespace: 'operations', owner: kind, key: id, value, expiresAt });
	}

	async getOperation<T>(kind: string, id: string, now = Date.now()): Promise<T | undefined> {
		const entry = await this.adapter.get('operations', kind, id);
		return entry?.expiresAt != null && entry.expiresAt > now ? entry.value as T : undefined;
	}

	async takeOperation<T>(kind: string, id: string, now = Date.now()): Promise<T | undefined> {
		const entry = await this.adapter.take('operations', kind, id);
		return entry?.expiresAt != null && entry.expiresAt > now ? entry.value as T : undefined;
	}

	async deleteOperation(kind: string, id: string): Promise<boolean> { return this.adapter.delete('operations', kind, id); }
	async prune(now = Date.now()): Promise<void> { await this.adapter.prune(now); }
}
