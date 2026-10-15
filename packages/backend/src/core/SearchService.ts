/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { type Config, FulltextSearchProvider } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { MiNote } from '@/models/Note.js';
import type { MiMeta, NotesRepository } from '@/models/_.js';
import { MiUser } from '@/models/_.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { CacheService } from '@/core/CacheService.js';
import { QueryService } from '@/core/QueryService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type { Index, Meilisearch } from 'meilisearch';

type K = string;
type V = string | number | boolean;
type Q =
	{ op: '=', k: K, v: V } |
	{ op: '!=', k: K, v: V } |
	{ op: '>', k: K, v: number } |
	{ op: '<', k: K, v: number } |
	{ op: '>=', k: K, v: number } |
	{ op: '<=', k: K, v: number } |
	{ op: 'is null', k: K } |
	{ op: 'is not null', k: K } |
	{ op: 'and', qs: Q[] } |
	{ op: 'or', qs: Q[] } |
	{ op: 'not', q: Q };

export type SearchOpts = {
	userId?: MiNote['userId'] | null;
	channelId?: MiNote['channelId'] | null;
	host?: string | null;
	rangeStartAt?: number | null;
	rangeEndAt?: number | null;
};

// Candidate windows start at one day and grow until they reach the search bounds.
const INITIAL_SEARCH_WINDOW_MS = 1000 * 60 * 60 * 24;
const SEARCH_WINDOW_GROWTH = 4;
// Time-based IDs (aid/aidx) cannot represent earlier times.
const EARLIEST_SEARCH_WINDOW_TIME = Date.UTC(2000, 0, 1);

export type SearchPagination = {
	untilId?: MiNote['id'];
	sinceId?: MiNote['id'];
	limit: number;
};

function compileValue(value: V): string {
	if (typeof value === 'string') {
		return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`;
	} else if (typeof value === 'number') {
		return value.toString();
	} else if (typeof value === 'boolean') {
		return value.toString();
	}
	throw new Error('unrecognized value');
}

function compileQuery(q: Q): string {
	switch (q.op) {
		case '=': return `(${q.k} = ${compileValue(q.v)})`;
		case '!=': return `(${q.k} != ${compileValue(q.v)})`;
		case '>': return `(${q.k} > ${compileValue(q.v)})`;
		case '<': return `(${q.k} < ${compileValue(q.v)})`;
		case '>=': return `(${q.k} >= ${compileValue(q.v)})`;
		case '<=': return `(${q.k} <= ${compileValue(q.v)})`;
		case 'and': return q.qs.length === 0 ? '' : `(${ q.qs.map(_q => compileQuery(_q)).join(' AND ') })`;
		case 'or': return q.qs.length === 0 ? '' : `(${ q.qs.map(_q => compileQuery(_q)).join(' OR ') })`;
		case 'is null': return `(${q.k} IS NULL)`;
		case 'is not null': return `(${q.k} IS NOT NULL)`;
		case 'not': return `(NOT ${compileQuery(q.q)})`;
		default: throw new Error('unrecognized query operator');
	}
}

@Injectable()
export class SearchService {
	private readonly meilisearchIndexScope: 'local' | 'global' | string[] = 'local';
	private readonly meilisearchNoteIndex: Index | null = null;
	private readonly provider: FulltextSearchProvider;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meilisearch)
		private meilisearch: Meilisearch | null,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private cacheService: CacheService,
		private queryService: QueryService,
		private idService: IdService,
		private loggerService: LoggerService,

		@Inject(DI.meta)
		private meta: MiMeta,
	) {
		if (meilisearch) {
			this.meilisearchNoteIndex = meilisearch.index(`${config.meilisearch!.index}---notes`);
			this.meilisearchNoteIndex.updateSettings({
				searchableAttributes: [
					'text',
					'cw',
				],
				sortableAttributes: [
					'createdAt',
				],
				filterableAttributes: [
					'createdAt',
					'userId',
					'userHost',
					'channelId',
					'tags',
				],
				typoTolerance: {
					enabled: false,
				},
				pagination: {
					maxTotalHits: 10000,
				},
			});
		}

		if (config.meilisearch?.scope) {
			this.meilisearchIndexScope = config.meilisearch.scope;
		}

		this.provider = config.fulltextSearch?.provider ?? 'sqlLike';
		this.loggerService.getLogger('SearchService').info(`-- Provider: ${this.provider}`);
	}

	@bindThis
	public async indexNote(note: MiNote): Promise<void> {
		if (!this.meilisearch) return;
		if (note.text == null && note.cw == null) return;
		if (!['home', 'public'].includes(note.visibility)) return;

		switch (this.meilisearchIndexScope) {
			case 'global':
				break;

			case 'local':
				if (note.userHost == null) break;
				return;

			default: {
				if (note.userHost == null) break;
				if (this.meilisearchIndexScope.includes(note.userHost)) break;
				return;
			}
		}

		await this.meilisearchNoteIndex?.addDocuments([{
			id: note.id,
			createdAt: this.idService.parse(note.id).date.getTime(),
			userId: note.userId,
			userHost: note.userHost,
			channelId: note.channelId,
			cw: note.cw,
			text: note.text,
			tags: note.tags,
		}], {
			primaryKey: 'id',
		});
	}

	@bindThis
	public async unindexNote(note: MiNote): Promise<void> {
		if (!this.meilisearch) return;
		if (!['home', 'public'].includes(note.visibility)) return;

		await this.meilisearchNoteIndex?.deleteDocument(note.id);
	}

	@bindThis
	public async searchNote(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		switch (this.provider) {
			case 'sqlLike':
			case 'sqlPgroonga': {
				// ほとんど内容に差がないのでsqlLikeとsqlPgroongaを同じ処理にしている.
				// 今後の拡張で差が出る用であれば関数を分ける.
				return this.searchNoteByLike(q, me, opts, pagination);
			}
			case 'meilisearch': {
				return this.searchNoteByMeilisearch(q, me, opts, pagination);
			}
			default: {
				const _: never = this.provider;
				return [];
			}
		}
	}

	@bindThis
	private async searchNoteByLike(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'), pagination.sinceId, pagination.untilId);

		if (opts.userId) {
			query.andWhere('note.userId = :userId', { userId: opts.userId });
		} else if (opts.channelId) {
			query.andWhere('note.channelId = :channelId', { channelId: opts.channelId });
		}

		if (opts.host) {
			if (opts.host === '.') {
				query.andWhere('note.userHost IS NULL');
			} else {
				query.andWhere('note.userHost = :host', { host: opts.host });
			}
		}

		if (opts.rangeStartAt != null) {
			const date = this.idService.gen(opts.rangeStartAt - 1);
			query.andWhere('note.id > :rangeStartAt', { rangeStartAt: date });
		}

		if (opts.rangeEndAt != null) {
			const date = this.idService.gen(opts.rangeEndAt + 1);
			query.andWhere('note.id < :rangeEndAt', { rangeEndAt: date });
		}

		let matches: SelectQueryBuilder<MiNote> | undefined;
		if (this.provider === 'sqlPgroonga') {
			// The index name preserves its tokenizer/normalizers for the condition.
			const textMatch = 'note_search_text(note.text, note.replyId) &@~ (:q, NULL, \'"IDX_note_search_text_id"\')::pgroonga_full_text_search_condition';
			// Keep ORDER BY / LIMIT out of the full-text query: otherwise the planner can
			// scan the primary key backwards and evaluate PGroonga on every visited row.
			// Retain the range/scope filters inside the full-text query.
			// Hydration does not repeat the text match: it could let the planner drive
			// the bounded ID lookup from the full-text index.
			matches = query.clone()
				.select('note.id', 'id')
				.orderBy()
				.andWhere(textMatch, { q });
		} else {
			query.andWhere('LOWER(note_search_text(note.text, note.replyId)) LIKE :q', { q: `%${ sqlLikeEscape(q.toLowerCase()) }%` });
		}

		query
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		this.queryService.generateVisibilityQuery(query, me);
		if (me == null) this.queryService.generateUgcVisibilityQueryForVisitor(query);
		this.queryService.generateBaseNoteFilteringQuery(query, me);

		if (matches) return this.fetchPgroongaNotes(matches, query, opts, pagination);
		return query.limit(pagination.limit).getMany();
	}

	@bindThis
	private async fetchPgroongaNotes(
		matches: SelectQueryBuilder<MiNote>,
		query: SelectQueryBuilder<MiNote>,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		const ascending = Boolean(pagination.sinceId && !pagination.untilId);
		const batchSize = Math.max(100, pagination.limit);
		const notes: MiNote[] = [];
		// Exclusive bound on the side that has already been examined.
		let cursor: MiNote['id'] | undefined;

		// Search in ID windows moving away from the pagination cursor. PGroonga applies
		// the window inside the (search text, id) index, so only matches in the window
		// are fetched from the table; frequent terms no longer read every matching row.
		const startId = ascending ? pagination.sinceId : pagination.untilId;
		let edge = startId != null ? this.idService.parse(startId).date.getTime() : Date.now();
		if (!ascending && opts.rangeEndAt != null) edge = Math.min(edge, opts.rangeEndAt);
		if (ascending && opts.rangeStartAt != null) edge = Math.max(edge, opts.rangeStartAt);
		const floor = Math.max(opts.rangeStartAt ?? EARLIEST_SEARCH_WINDOW_TIME, EARLIEST_SEARCH_WINDOW_TIME);
		const ceiling = opts.rangeEndAt ?? Date.now();
		let span = INITIAL_SEARCH_WINDOW_MS;

		while (true) {
			const farTime = ascending ? edge + span : edge - span;
			// The last window has no far bound, so it also covers IDs outside the time scale.
			const far = (ascending ? farTime >= ceiling : farTime <= floor) ? undefined : this.idService.gen(farTime);

			while (true) {
				const batchMatches = matches.clone();
				if (cursor != null) {
					batchMatches.andWhere(`note.id ${ascending ? '>' : '<'} :searchCursor`, { searchCursor: cursor });
				}
				if (far != null) {
					batchMatches.andWhere(`note.id ${ascending ? '<=' : '>='} :searchWindow`, { searchWindow: far });
				}

				// Do not join the candidate CTE back to note. Its estimated cardinality can
				// make PostgreSQL merge-join against a backward scan of the entire note PK.
				const candidates = await this.notesRepository.manager.createQueryBuilder()
					.addCommonTableExpression(batchMatches, 'matched_note', { materialized: true })
					.select('matched_note.id', 'id')
					.from('matched_note', 'matched_note')
					.orderBy('matched_note.id', ascending ? 'ASC' : 'DESC')
					.limit(batchSize)
					.getRawMany<{ id: MiNote['id'] }>();

				if (candidates.length > 0) {
					const batch = await query.clone()
						.andWhere('note.id IN (:...searchResultIds)', { searchResultIds: candidates.map(note => note.id) })
						.limit(pagination.limit - notes.length)
						.getMany();
					notes.push(...batch);
					if (notes.length >= pagination.limit) return notes;
				}

				// Advance past every examined candidate, including invisible or deleted
				// notes, and keep fetching until the window is exhausted.
				if (candidates.length < batchSize) break;
				cursor = candidates[candidates.length - 1].id;
			}

			if (far == null) return notes;
			// The next window starts just past this window's inclusive far bound.
			cursor = far;
			edge = farTime;
			span *= SEARCH_WINDOW_GROWTH;
		}
	}

	@bindThis
	private async searchNoteByMeilisearch(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		if (!this.meilisearch || !this.meilisearchNoteIndex) {
			throw new Error('Meilisearch is not available');
		}

		const filter: Q = {
			op: 'and',
			qs: [],
		};
		if (pagination.untilId) filter.qs.push({
			op: '<',
			k: 'createdAt',
			v: this.idService.parse(pagination.untilId).date.getTime(),
		});
		if (opts.rangeEndAt) filter.qs.push({
			op: '<=',
			k: 'createdAt',
			v: opts.rangeEndAt,
		});
		if (pagination.sinceId) filter.qs.push({
			op: '>',
			k: 'createdAt',
			v: this.idService.parse(pagination.sinceId).date.getTime(),
		});
		if (opts.rangeStartAt) filter.qs.push({
			op: '>=',
			k: 'createdAt',
			v: opts.rangeStartAt,
		});
		if (opts.userId) filter.qs.push({ op: '=', k: 'userId', v: opts.userId });
		if (opts.channelId) filter.qs.push({ op: '=', k: 'channelId', v: opts.channelId });
		if (opts.host) {
			if (opts.host === '.') {
				filter.qs.push({ op: 'is null', k: 'userHost' });
			} else {
				filter.qs.push({ op: '=', k: 'userHost', v: opts.host });
			}
		}
		if (me == null) {
			if (this.meta.ugcVisibilityForVisitor === 'none') return [];
			if (this.meta.ugcVisibilityForVisitor === 'local') filter.qs.push({ op: 'is null', k: 'userHost' });
		}

		const res = await this.meilisearchNoteIndex.search(q, {
			sort: ['createdAt:desc'],
			matchingStrategy: 'all',
			attributesToRetrieve: ['id', 'createdAt'],
			filter: compileQuery(filter),
			limit: pagination.limit,
		});
		if (res.hits.length === 0) {
			return [];
		}

		const [
			userIdsWhoMeMuting,
			userIdsWhoBlockingMe,
		] = me
			? await Promise.all([
				this.cacheService.userMutingsCache.fetch(me.id),
				this.cacheService.userBlockedCache.fetch(me.id),
			])
			: [new Set<string>(), new Set<string>()];

		const query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		query.where('note.id IN (:...noteIds)', { noteIds: res.hits.map(x => x.id) });

		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const notes = (await query.getMany()).filter(note => {
			if (me && isUserRelated(note, userIdsWhoBlockingMe)) return false;
			if (me && isUserRelated(note, userIdsWhoMeMuting)) return false;
			return true;
		});

		return notes.sort((a, b) => a.id > b.id ? -1 : 1);
	}
}
