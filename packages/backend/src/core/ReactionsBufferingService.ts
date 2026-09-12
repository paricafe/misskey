/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiNote } from '@/models/Note.js';
import { bindThis } from '@/decorators.js';
import type { MiUser, NotesRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import { PER_NOTE_REACTION_USER_PAIR_CACHE_MAX } from '@/const.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';
import type { OnApplicationShutdown } from '@nestjs/common';

const REDIS_DELTA_PREFIX = 'reactionsBufferDeltas';
const REDIS_PAIR_PREFIX = 'reactionsBufferPairs';
const REDIS_CHANGES_PREFIX = 'reactionsBufferChanges';
const REDIS_PENDING_PREFIX = 'reactionsBufferPending';

// Keep the count and the last operation for each user in the same atomic write.
const MUTATE_SCRIPT = `
redis.call('hincrby', KEYS[1], ARGV[1], ARGV[2])
redis.call('hset', KEYS[2], ARGV[3], ARGV[4])
local limit = tonumber(ARGV[5])
local marked = redis.call('hexists', KEYS[2], '')
if redis.call('hlen', KEYS[2]) - marked > limit then
	redis.call('hset', KEYS[2], '', '1')
	for _, userId in ipairs(redis.call('hkeys', KEYS[2])) do
		if userId ~= '' and userId ~= ARGV[3] then
			redis.call('hdel', KEYS[2], userId)
			if redis.call('hlen', KEYS[2]) - 1 <= limit then break end
		end
	end
end
return 1
`;

const READ_SCRIPT = `
return {
	redis.call('hgetall', KEYS[1]),
	redis.call('zrange', KEYS[2], 0, -1),
	redis.call('hgetall', KEYS[3]),
	redis.call('get', KEYS[4]) or ''
}
`;

// The pending batch survives process exits and database failures. New writes use the live keys.
const PREPARE_SCRIPT = `
local pending = redis.call('get', KEYS[4])
if pending then return pending end
local entries = redis.call('hgetall', KEYS[1])
if #entries == 0 then return '' end
local deltas = {}
for i = 1, #entries, 2 do deltas[entries[i]] = tonumber(entries[i + 1]) end
local changes = redis.call('hgetall', KEYS[3])
local pairs = redis.call('zrange', KEYS[2], 0, -1)
local batch = cjson.encode({ id = ARGV[1], deltas = deltas, pairs = pairs, changes = changes })
redis.call('set', KEYS[4], batch)
redis.call('del', KEYS[1], KEYS[2], KEYS[3])
return batch
`;

const ACK_SCRIPT = `
local pending = redis.call('get', KEYS[1])
if pending and cjson.decode(pending).id == ARGV[1] then
	return redis.call('del', KEYS[1])
end
return 0
`;

type ReactionBatch = {
	id: string;
	deltas: Record<string, number>;
	pairs: string[];
	changes: string[];
};

export type BufferedReactions = {
	deltas: Record<string, number>;
	pairs: [MiUser['id'], string][];
	pairChanges: Map<MiUser['id'], string>;
	pending?: ReactionBatch;
};

type RedisReadResult = [string[], string[], string[], string];

function parseBatch(value: string): ReactionBatch {
	const batch = JSON.parse(value) as ReactionBatch;
	// Redis Lua encodes empty arrays as empty objects.
	batch.pairs = Array.isArray(batch.pairs) ? batch.pairs : [];
	batch.changes = Array.isArray(batch.changes) ? batch.changes : [];
	return batch;
}

function pairsToMap(entries: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (let i = 0; i < entries.length; i += 2) {
		map.set(entries[i], entries[i + 1]);
	}
	return map;
}

@Injectable()
export class ReactionsBufferingService implements OnApplicationShutdown {
	private logger: Logger;
	private pendingBake: Promise<void> | undefined;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.redisForReactions)
		private redisForReactions: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('reactions-buffer');
		this.redisForSub.on('message', this.onMessage);
	}

	@bindThis
	private async onMessage(_: string, data: string) {
		const obj = JSON.parse(data);
		if (obj.channel !== 'internal') return;
		const { type, body } = obj.message as GlobalEvents['internal']['payload'];
		if (type === 'metaUpdated' && body.before?.enableReactionsBuffering && !body.after.enableReactionsBuffering) {
			await this.bake().catch(error => this.logger.error('Failed to bake buffered reactions', error));
		}
	}

	@bindThis
	public async create(noteId: MiNote['id'], userId: MiUser['id'], reaction: string): Promise<void> {
		await this.redisForReactions.eval(MUTATE_SCRIPT, 2,
			REDIS_DELTA_PREFIX + ':' + noteId, REDIS_CHANGES_PREFIX + ':' + noteId,
			reaction, '1', userId, reaction, PER_NOTE_REACTION_USER_PAIR_CACHE_MAX);
	}

	@bindThis
	public async delete(noteId: MiNote['id'], userId: MiUser['id'], reaction: string): Promise<void> {
		await this.redisForReactions.eval(MUTATE_SCRIPT, 2,
			REDIS_DELTA_PREFIX + ':' + noteId, REDIS_CHANGES_PREFIX + ':' + noteId,
			reaction, '-1', userId, '', PER_NOTE_REACTION_USER_PAIR_CACHE_MAX);
	}

	private keys(noteId: MiNote['id']): [string, string, string, string] {
		return [REDIS_DELTA_PREFIX, REDIS_PAIR_PREFIX, REDIS_CHANGES_PREFIX, REDIS_PENDING_PREFIX]
			.map(prefix => prefix + ':' + noteId) as [string, string, string, string];
	}

	private parseReadResult(result: RedisReadResult): BufferedReactions {
		const [entries, pairs, changes, pending] = result;
		return {
			deltas: Object.fromEntries([...pairsToMap(entries)].map(([reaction, count]) => [reaction, Number(count)])),
			pairs: pairs.map(pair => pair.split('/') as [MiUser['id'], string]),
			pairChanges: pairsToMap(changes),
			pending: pending ? parseBatch(pending) : undefined,
		};
	}

	@bindThis
	public async get(noteId: MiNote['id']): Promise<BufferedReactions> {
		const result = await this.redisForReactions.eval(READ_SCRIPT, 4, ...this.keys(noteId));
		return this.parseReadResult(result as RedisReadResult);
	}

	@bindThis
	public async getMany(noteIds: MiNote['id'][]): Promise<Map<MiNote['id'], BufferedReactions>> {
		const ids = [...new Set(noteIds)];
		if (ids.length === 0) return new Map();
		const pipeline = this.redisForReactions.pipeline();
		for (const noteId of ids) {
			pipeline.eval(READ_SCRIPT, 4, ...this.keys(noteId));
		}
		const results = await pipeline.exec();
		if (results == null) throw new Error('Failed to read buffered reactions');
		return new Map(ids.map((noteId, index) => {
			const [error, result] = results[index];
			if (error) throw error;
			return [noteId, this.parseReadResult(result as RedisReadResult)];
		}));
	}

	@bindThis
	public getDeltas(note: Pick<MiNote, 'lastReactionsBufferId'>, buffered?: BufferedReactions): Record<string, number> {
		if (buffered == null) return {};
		const pending = buffered.pending;
		return pending && pending.id !== note.lastReactionsBufferId
			? this.mergeReactions(pending.deltas, buffered.deltas)
			: buffered.deltas;
	}

	@bindThis
	public getPairs(note: Pick<MiNote, 'lastReactionsBufferId' | 'reactionAndUserPairCache'>, buffered?: BufferedReactions): string[] {
		let pairs = note.reactionAndUserPairCache;
		const pending = buffered?.pending;
		if (pending && pending.id !== note.lastReactionsBufferId) {
			pairs = this.applyPairChanges(pairs, pending.pairs, pairsToMap(pending.changes));
		}
		return buffered
			? this.applyPairChanges(pairs, buffered.pairs.map(pair => pair.join('/')), buffered.pairChanges)
			: pairs;
	}

	private applyPairChanges(pairs: string[], legacyPairs: string[], changes: Map<string, string>): string[] {
		const map = new Map<string, string>();
		// An empty user ID marks an overflow. Only retained operations are safe to cache;
		// callers already query note_reaction when this cache cannot account for every reaction.
		for (const pair of changes.has('') ? [] : [...pairs, ...legacyPairs]) {
			const [userId, reaction] = pair.split('/');
			map.set(userId, reaction);
		}
		for (const [userId, reaction] of changes) {
			if (userId === '') continue;
			map.delete(userId);
			if (reaction !== '') map.set(userId, reaction);
		}
		return [...map].slice(-PER_NOTE_REACTION_USER_PAIR_CACHE_MAX).map(pair => pair.join('/'));
	}

	@bindThis
	public async bake(): Promise<void> {
		if (this.pendingBake) return this.pendingBake;
		const pendingBake = this.bakeAll();
		this.pendingBake = pendingBake;
		try {
			await pendingBake;
		} finally {
			if (this.pendingBake === pendingBake) this.pendingBake = undefined;
		}
	}

	private async bakeAll(): Promise<void> {
		// Scan each store in bounded pages, including batches left by a previous worker.
		const keyPrefix = this.config.redisForReactions.keyPrefix ?? '';
		for (const prefix of [REDIS_PENDING_PREFIX, REDIS_DELTA_PREFIX]) {
			let cursor = '0';
			do {
				const result = await this.redisForReactions.scan(cursor, 'MATCH', keyPrefix + prefix + ':*', 'COUNT', 100);
				cursor = result[0];
				for (const key of new Set(result[1])) {
					await this.bakeNote(key.slice((keyPrefix + prefix + ':').length));
				}
			} while (cursor !== '0');
		}
	}

	private async bakeNote(noteId: MiNote['id']): Promise<void> {
		const keys = this.keys(noteId);
		const batchId = await this.notesRepository.manager.transaction(async manager => {
			const repository = manager.getRepository(this.notesRepository.target);
			// The row lock serializes preparation and application across all workers.
			const note = await repository.findOne({
				where: { id: noteId },
				select: { id: true, reactions: true, reactionAndUserPairCache: true, lastReactionsBufferId: true },
				lock: { mode: 'pessimistic_write' },
			});
			if (note == null) {
				await this.redisForReactions.del(...keys);
				return null;
			}
			const raw = await this.redisForReactions.eval(PREPARE_SCRIPT, 4, ...keys, randomUUID()) as string;
			if (raw === '') return null;
			const batch = parseBatch(raw);
			if (note.lastReactionsBufferId !== batch.id) {
				await repository.update(noteId, {
					reactions: this.mergeReactions(note.reactions, batch.deltas),
					reactionAndUserPairCache: this.applyPairChanges(note.reactionAndUserPairCache, batch.pairs, pairsToMap(batch.changes)),
					lastReactionsBufferId: batch.id,
				});
			}
			return batch.id;
		});
		// Never acknowledge a batch before its counts and checkpoint have committed together.
		if (batchId != null) await this.redisForReactions.eval(ACK_SCRIPT, 1, keys[3], batchId);
	}

	@bindThis
	public mergeReactions(src: MiNote['reactions'], delta: Record<string, number>): MiNote['reactions'] {
		const reactions = { ...src };
		for (const [name, count] of Object.entries(delta)) {
			reactions[name] = (reactions[name] ?? 0) + count;
		}
		return reactions;
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	public async onApplicationShutdown(): Promise<void> {
		this.dispose();
		await this.pendingBake;
	}
}
