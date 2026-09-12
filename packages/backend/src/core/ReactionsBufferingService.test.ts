/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import type * as Redis from 'ioredis';
import type { Config } from '@/config.js';
import type { MiNote, NotesRepository } from '@/models/_.js';
import type { LoggerService } from '@/core/LoggerService.js';
import { PER_NOTE_REACTION_USER_PAIR_CACHE_MAX } from '@/const.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';

type StoredNote = Pick<MiNote, 'id' | 'reactions' | 'reactionAndUserPairCache' | 'lastReactionsBufferId'>;
type RedisValue = string | Map<string, string> | string[];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

// Models atomic Redis operations and response loss. The production Lua itself is
// covered by integration tests, not by this protocol test double.
class BufferedRedis {
	public ackFailure: 'before' | 'after' | undefined;
	public constructor(public readonly store = new Map<string, RedisValue>(), private readonly prefix = '') {}

	private hash(key: string): Map<string, string> {
		let hash = this.store.get(key) as Map<string, string> | undefined;
		if (hash == null) {
			hash = new Map();
			this.store.set(key, hash);
		}
		return hash;
	}

	private entries(key: string): string[] {
		return [...(this.store.get(key) as Map<string, string> | undefined ?? [])].flat();
	}

	public async eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown> {
		const keys = args.slice(0, numberOfKeys).map(key => this.prefix + key);
		const values = args.slice(numberOfKeys);
		if (numberOfKeys === 2) {
			const deltas = this.hash(keys[0]);
			deltas.set(values[0], String(Number(deltas.get(values[0]) ?? 0) + Number(values[1])));
			const changes = this.hash(keys[1]);
			changes.set(values[2], values[3]);
			while (changes.size - Number(changes.has('')) > PER_NOTE_REACTION_USER_PAIR_CACHE_MAX) {
				const evicted = [...changes.keys()].find(userId => userId !== '' && userId !== values[2]);
				changes.delete(evicted!);
				changes.set('', '1');
			}
			return 1;
		}
		if (numberOfKeys === 1) {
			const failure = this.ackFailure;
			this.ackFailure = undefined;
			if (failure === 'before') throw new Error('ACK response lost before execution');
			const pending = this.store.get(keys[0]) as string | undefined;
			const deleted = pending != null && JSON.parse(pending).id === values[0] && this.store.delete(keys[0]);
			if (failure === 'after') throw new Error('ACK response lost after execution');
			return deleted ? 1 : 0;
		}
		if (script.includes('local entries')) {
			const pending = this.store.get(keys[3]);
			if (pending != null) return pending;
			const entries = this.entries(keys[0]);
			if (entries.length === 0) return '';
			const deltas: Record<string, number> = {};
			for (let i = 0; i < entries.length; i += 2) deltas[entries[i]] = Number(entries[i + 1]);
			const pairs = this.store.get(keys[1]) as string[] | undefined ?? [];
			const changes = this.entries(keys[2]);
			const batch = JSON.stringify({ id: values[0], deltas, pairs: pairs.length > 0 ? pairs : {}, changes: changes.length > 0 ? changes : {} });
			this.store.set(keys[3], batch);
			for (const key of keys.slice(0, 3)) this.store.delete(key);
			return batch;
		}
		return [this.entries(keys[0]), this.store.get(keys[1]) ?? [], this.entries(keys[2]), this.store.get(keys[3]) ?? ''];
	}

	public async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
		return ['0', [...this.store.keys()].filter(key => key.startsWith(pattern.slice(0, -1)))];
	}

	public async del(...keys: string[]): Promise<number> {
		return keys.filter(key => this.store.delete(this.prefix + key)).length;
	}

	public pipeline() {
		const commands: Parameters<BufferedRedis['eval']>[] = [];
		return {
			eval: (...args: Parameters<BufferedRedis['eval']>) => { commands.push(args); },
			exec: async () => Promise.all(commands.map(async args => [null, await this.eval(...args)])),
		};
	}
}

// Transactions hold a shared lock and commit the count, pair cache, and marker
// together. Failures can happen before the write or after a successful commit.
class NoteDatabase {
	public failUpdate = false;
	public loseCommitResponse = false;
	public beforeUpdate: (() => Promise<void>) | undefined;
	public updates = 0;
	public notes = new Map<string, StoredNote>();
	private transactionTail = Promise.resolve();

	public constructor(note: Partial<StoredNote> = {}) {
		this.notes.set('note', { id: 'note', reactions: {}, reactionAndUserPairCache: [], lastReactionsBufferId: null, ...note });
	}

	public readonly repository = {
		target: 'note',
		manager: {
			transaction: async <T>(callback: (manager: { getRepository: () => unknown }) => Promise<T>): Promise<T> => {
				const previous = this.transactionTail;
				const unlock = deferred();
				this.transactionTail = unlock.promise;
				await previous;
				const working = structuredClone(this.notes);
				try {
					const result = await callback({
						getRepository: () => ({
							findOne: async ({ where }: { where: { id: string } }) => working.get(where.id) ?? null,
							update: async (id: string, changes: Partial<StoredNote>) => {
								await this.beforeUpdate?.();
								if (this.failUpdate) {
									this.failUpdate = false;
									throw new Error('Database write failed');
								}
								this.updates++;
								Object.assign(working.get(id)!, changes);
							},
						}),
					});
					this.notes = working;
					if (this.loseCommitResponse) {
						this.loseCommitResponse = false;
						throw new Error('Commit response lost');
					}
					return result;
				} finally {
					unlock.resolve();
				}
			},
		},
	};

	public get note(): StoredNote {
		return this.notes.get('note')!;
	}
}

function makeService(db: NoteDatabase, redis = new BufferedRedis(), keyPrefix = '') {
	return new ReactionsBufferingService(
		{ redis: { keyPrefix: 'unrelated:' }, redisForReactions: { keyPrefix } } as Config,
		new EventEmitter() as Redis.Redis,
		redis as unknown as Redis.Redis,
		db.repository as unknown as NotesRepository,
		{ getLogger: () => ({ error: () => undefined }) } as unknown as LoggerService,
	);
}

function setup(note: Partial<StoredNote> = {}) {
	const db = new NoteDatabase(note);
	const redis = new BufferedRedis();
	return { db, redis, service: makeService(db, redis) };
}

describe('ReactionsBufferingService recovery protocol', () => {
	test('persists every reaction delta without overwriting other emoji increments', async () => {
		const { service, db } = setup({ reactions: { '😀': 5, '👍': 3 } });
		await service.create('note', 'alice', '😀');
		await service.create('note', 'bob', '👍');
		await service.bake();

		expect(db.note.reactions).toEqual({ '😀': 6, '👍': 4 });
		expect(db.note.reactionAndUserPairCache).toEqual(['alice/😀', 'bob/👍']);
		expect(service.getDeltas(db.note, await service.get('note'))).toEqual({});
	});

	test('retries a pending-only batch after a database failure or worker restart', async () => {
		const { service, db, redis } = setup();
		await service.create('note', 'alice', '😀');
		db.failUpdate = true;
		await expect(service.bake()).rejects.toThrow('Database write failed');
		const buffered = await service.get('note');

		expect(buffered.deltas).toEqual({});
		expect(buffered.pending).toBeDefined();
		expect(db.note.reactions).toEqual({});
		expect(service.getDeltas(db.note, buffered)).toEqual({ '😀': 1 });
		expect(service.getPairs(db.note, buffered)).toEqual(['alice/😀']);

		await makeService(db, redis).bake();
		expect(db.note.reactions).toEqual({ '😀': 1 });
		expect((await service.get('note')).pending).toBeUndefined();
	});

	test('does not replay a committed batch when the commit response was lost', async () => {
		const { service, db } = setup();
		await service.create('note', 'alice', '😀');
		db.loseCommitResponse = true;
		await expect(service.bake()).rejects.toThrow('Commit response lost');
		const buffered = await service.get('note');

		expect(buffered.pending).toBeDefined();
		expect(service.getDeltas(db.note, buffered)).toEqual({});
		expect(service.getPairs(db.note, buffered)).toEqual(['alice/😀']);
		await service.bake();
		expect(db.note.reactions).toEqual({ '😀': 1 });
		expect(db.updates).toBe(1);
		expect((await service.get('note')).pending).toBeUndefined();
	});

	test.each(['before', 'after'] as const)('recovers when acknowledgement fails %s Redis executes it', async failure => {
		const { service, db, redis } = setup();
		await service.create('note', 'alice', '😀');
		redis.ackFailure = failure;
		await expect(service.bake()).rejects.toThrow('ACK response lost');
		await service.create('note', 'bob', '👍');
		await service.bake();

		expect(db.note.reactions).toEqual({ '😀': 1, '👍': 1 });
		expect(db.note.reactionAndUserPairCache).toEqual(['alice/😀', 'bob/👍']);
		expect(db.updates).toBe(2);
		expect(service.getDeltas(db.note, await service.get('note'))).toEqual({});
	});

	test('waits for the database and preserves writes arriving after a batch was frozen', async () => {
		const { service, db } = setup();
		const updating = deferred();
		const release = deferred();
		db.beforeUpdate = async () => {
			updating.resolve();
			await release.promise;
		};
		await service.create('note', 'alice', '😀');
		let finished = false;
		const baking = service.bake().then(() => { finished = true; });
		await updating.promise;
		await service.create('note', 'bob', '👍');
		const buffered = await service.get('note');

		expect(finished).toBe(false);
		expect(db.note.reactions).toEqual({});
		expect(service.getDeltas(db.note, buffered)).toEqual({ '😀': 1, '👍': 1 });
		release.resolve();
		await baking;
		expect(db.note.reactions).toEqual({ '😀': 1 });
		expect(service.getDeltas(db.note, await service.get('note'))).toEqual({ '👍': 1 });
		await service.bake();
		expect(db.note.reactions).toEqual({ '😀': 1, '👍': 1 });
	});

	test('applies pending changes before a live delete and replacement for the same user', async () => {
		const { service, db } = setup();
		await service.create('note', 'alice', '😀');
		db.failUpdate = true;
		await expect(service.bake()).rejects.toThrow('Database write failed');
		await service.delete('note', 'alice', '😀');
		await service.create('note', 'alice', '👍');
		const buffered = await service.get('note');

		expect(service.getDeltas(db.note, buffered)).toEqual({ '😀': 0, '👍': 1 });
		expect(service.getPairs(db.note, buffered)).toEqual(['alice/👍']);
		await service.bake();
		expect(db.note.reactions).toEqual({ '😀': 0, '👍': 1 });
		expect(db.note.reactionAndUserPairCache).toEqual(['alice/👍']);
	});

	test('persists changed user pairs even when the net reaction count is zero', async () => {
		const { service, db } = setup({ reactions: { '😀': 1 }, reactionAndUserPairCache: ['alice/😀'] });
		await service.delete('note', 'alice', '😀');
		await service.create('note', 'bob', '😀');
		expect(service.getPairs(db.note, await service.get('note'))).toEqual(['bob/😀']);
		await service.bake();

		expect(db.note.reactions).toEqual({ '😀': 1 });
		expect(db.note.reactionAndUserPairCache).toEqual(['bob/😀']);
		expect(db.updates).toBe(1);
	});

	test('keeps reaction Redis prefixes isolated from other stores and from other instances', async () => {
		const store = new Map<string, RedisValue>();
		const firstDb = new NoteDatabase();
		const secondDb = new NoteDatabase();
		const first = makeService(firstDb, new BufferedRedis(store, 'first:'), 'first:');
		const second = makeService(secondDb, new BufferedRedis(store, 'second:'), 'second:');
		await first.create('note', 'alice', '😀');
		await second.create('note', 'bob', '👍');
		await first.bake();

		expect(firstDb.note.reactions).toEqual({ '😀': 1 });
		expect(secondDb.note.reactions).toEqual({});
		expect(second.getDeltas(secondDb.note, await second.get('note'))).toEqual({ '👍': 1 });
		await second.bake();
		expect(secondDb.note.reactions).toEqual({ '👍': 1 });
	});

	test('bounds pair changes while retaining all counts and removing evicted users from the cache', async () => {
		const { service, db } = setup();
		const users = Array.from({ length: PER_NOTE_REACTION_USER_PAIR_CACHE_MAX * 2 }, (_, i) => `user${i}`);
		for (const user of users) await service.create('note', user, '😀');
		const created = await service.get('note');
		expect(created.pairChanges.size).toBeLessThanOrEqual(PER_NOTE_REACTION_USER_PAIR_CACHE_MAX + 1);
		await service.bake();
		expect(db.note.reactions).toEqual({ '😀': users.length });
		expect(db.note.reactionAndUserPairCache).toHaveLength(PER_NOTE_REACTION_USER_PAIR_CACHE_MAX);

		// Delete cached users first, so their removals are evicted by later uncached
		// users. An incomplete change set must not preserve their old cached pairs.
		const cachedUsers = db.note.reactionAndUserPairCache.map(pair => pair.split('/')[0]);
		const removalOrder = [...cachedUsers, ...users.filter(user => !cachedUsers.includes(user))];
		for (const user of removalOrder) await service.delete('note', user, '😀');
		const replacementUser = removalOrder[removalOrder.length - 1];
		await service.create('note', replacementUser, '👍');
		const changed = await service.get('note');

		expect(changed.pairChanges.size).toBeLessThanOrEqual(PER_NOTE_REACTION_USER_PAIR_CACHE_MAX + 1);
		expect(service.mergeReactions(db.note.reactions, service.getDeltas(db.note, changed))).toEqual({ '😀': 0, '👍': 1 });
		expect(service.getPairs(db.note, changed)).toEqual([`${replacementUser}/👍`]);
		await service.bake();
		expect(db.note.reactions).toEqual({ '😀': 0, '👍': 1 });
		expect(db.note.reactionAndUserPairCache).toEqual([`${replacementUser}/👍`]);
	});

	test('concurrent bake calls and workers persist a batch only once', async () => {
		const { service, db, redis } = setup();
		const otherWorker = makeService(db, redis);
		const updating = deferred();
		const release = deferred();
		db.beforeUpdate = async () => {
			updating.resolve();
			await release.promise;
		};
		await service.create('note', 'alice', '😀');
		const first = service.bake();
		await updating.promise;
		const second = service.bake();
		const third = otherWorker.bake();
		release.resolve();
		await Promise.all([first, second, third]);

		expect(db.note.reactions).toEqual({ '😀': 1 });
		expect(db.updates).toBe(1);
		expect((await service.get('note')).pending).toBeUndefined();
	});

	test('bulk reads preserve per-note snapshots and omit already applied pending deltas', async () => {
		const { service, db } = setup();
		await service.create('note', 'alice', '😀');
		db.loseCommitResponse = true;
		await expect(service.bake()).rejects.toThrow('Commit response lost');
		await service.delete('note', 'alice', '😀');
		await service.create('other', 'bob', '👍');
		const buffered = await service.getMany(['note', 'other', 'note']);

		expect([...buffered.keys()]).toEqual(['note', 'other']);
		expect(service.getDeltas(db.note, buffered.get('note'))).toEqual({ '😀': -1 });
		expect(service.getPairs(db.note, buffered.get('note'))).toEqual([]);
		expect(service.getDeltas(db.note, buffered.get('other'))).toEqual({ '👍': 1 });
		expect(await service.getMany([])).toEqual(new Map());
	});
});
