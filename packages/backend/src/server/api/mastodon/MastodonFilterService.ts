/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MiUser } from '@/models/User.js';
import { MastodonApiError } from './errors.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';

export const MASTODON_FILTER_CONTEXTS = ['home', 'notifications', 'public', 'thread', 'account'] as const;
export const MASTODON_FILTER_ACTIONS = ['warn', 'hide', 'blur'] as const;

export type MastodonFilterContext = typeof MASTODON_FILTER_CONTEXTS[number];
export type MastodonFilterAction = typeof MASTODON_FILTER_ACTIONS[number];

export type MastodonFilterKeyword = {
	id: string;
	keyword: string;
	whole_word: boolean;
};

export type MastodonFilterStatus = {
	id: string;
	status_id: string;
};

export type MastodonFilter = {
	id: string;
	title: string;
	context: MastodonFilterContext[];
	expires_at: string | null;
	filter_action: MastodonFilterAction;
	keywords: MastodonFilterKeyword[];
	statuses: MastodonFilterStatus[];
};

export type MastodonV1Filter = {
	id: string;
	phrase: string;
	context: MastodonFilterContext[];
	whole_word: boolean;
	expires_at: string | null;
	irreversible: boolean;
};

export type MastodonFilterApplyOptions = {
	preserveHidden?: boolean;
	corpora?: ReadonlyMap<string, readonly string[]>;
};

type Dictionary = Record<string, unknown>;

const FILTER_KIND = 'filter';
const MAX_FILTERS = 100;
const MAX_KEYWORDS = 20;
const MAX_STATUSES = 100;
const MAX_TITLE_LENGTH = 100;
const MAX_KEYWORD_LENGTH = 200;
const MAX_FILTER_STATE_BYTES = 256 * 1024;

@Injectable()
export class MastodonFilterService {
	constructor(
		private mastodonApiStateService: MastodonApiStateService,
	) {}

	public async listV2(userId: MiUser['id']): Promise<MastodonFilter[]> {
		return await this.snapshot(userId);
	}

	public async getV2(userId: MiUser['id'], filterId: string): Promise<MastodonFilter> {
		return this.requireFilter(await this.snapshot(userId), filterId);
	}

	public async createV2(userId: MiUser['id'], input: Dictionary): Promise<MastodonFilter> {
		return await this.mutate(userId, async stateService => await this.createV2Locked(stateService, userId, input));
	}

	private async createV2Locked(stateService: MastodonApiStateService, userId: MiUser['id'], input: Dictionary): Promise<MastodonFilter> {
		const filters = await this.snapshot(userId, stateService);
		if (filters.length >= MAX_FILTERS) this.invalid(`Filters are limited to ${MAX_FILTERS}`);
		const filter: MastodonFilter = {
			id: randomUUID(),
			title: this.title(input.title),
			context: this.contexts(input.context),
			expires_at: this.expiresAt(input.expires_in, null),
			filter_action: this.action(input.filter_action, 'warn'),
			keywords: this.newKeywords(input.keywords ?? input.keywords_attributes),
			statuses: this.newStatuses(input.statuses),
		};
		await this.save(userId, filter, filters, stateService);
		return filter;
	}

	public async updateV2(userId: MiUser['id'], filterId: string, input: Dictionary): Promise<MastodonFilter> {
		return await this.mutate(userId, async stateService => {
			const filters = await this.snapshot(userId, stateService);
			const current = this.requireFilter(filters, filterId);
			let keywords = current.keywords;
			if (Object.hasOwn(input, 'keywords')) keywords = this.newKeywords(input.keywords);
			if (Object.hasOwn(input, 'keywords_attributes')) keywords = this.updateKeywords(keywords, input.keywords_attributes);
			const filter: MastodonFilter = {
				...current,
				title: Object.hasOwn(input, 'title') ? this.title(input.title) : current.title,
				context: Object.hasOwn(input, 'context') ? this.contexts(input.context) : current.context,
				expires_at: Object.hasOwn(input, 'expires_in') ? this.expiresAt(input.expires_in, null) : current.expires_at,
				filter_action: Object.hasOwn(input, 'filter_action') ? this.action(input.filter_action, current.filter_action) : current.filter_action,
				keywords,
			};
			await this.save(userId, filter, filters, stateService);
			return filter;
		});
	}

	public async deleteV2(userId: MiUser['id'], filterId: string): Promise<Record<string, never>> {
		return await this.mutate(userId, async stateService => {
			this.requireFilter(await this.snapshot(userId, stateService), filterId);
			await stateService.delete(userId, FILTER_KIND, filterId);
			return {};
		});
	}

	public async listKeywords(userId: MiUser['id'], filterId: string): Promise<MastodonFilterKeyword[]> {
		return this.requireFilter(await this.snapshot(userId), filterId).keywords;
	}

	public async getKeyword(userId: MiUser['id'], keywordId: string): Promise<MastodonFilterKeyword> {
		return this.requireKeyword(await this.snapshot(userId), keywordId).keyword;
	}

	public async createKeyword(userId: MiUser['id'], filterId: string, input: Dictionary): Promise<MastodonFilterKeyword> {
		return await this.mutate(userId, async stateService => {
			const filters = await this.snapshot(userId, stateService);
			const filter = this.requireFilter(filters, filterId);
			if (filter.keywords.length >= MAX_KEYWORDS) this.invalid(`Keywords are limited to ${MAX_KEYWORDS} per filter`);
			const keyword = this.newKeyword(input);
			await this.save(userId, { ...filter, keywords: [...filter.keywords, keyword] }, filters, stateService);
			return keyword;
		});
	}

	public async updateKeyword(userId: MiUser['id'], keywordId: string, input: Dictionary): Promise<MastodonFilterKeyword> {
		return await this.mutate(userId, async stateService => {
			const filters = await this.snapshot(userId, stateService);
			const { filter, keyword } = this.requireKeyword(filters, keywordId);
			const updated: MastodonFilterKeyword = {
				...keyword,
				keyword: Object.hasOwn(input, 'keyword') ? this.keyword(input.keyword) : keyword.keyword,
				whole_word: Object.hasOwn(input, 'whole_word') ? this.boolean(input.whole_word, 'whole_word') : keyword.whole_word,
			};
			await this.save(userId, {
				...filter,
				keywords: filter.keywords.map(value => value.id === keywordId ? updated : value),
			}, filters, stateService);
			return updated;
		});
	}

	public async deleteKeyword(userId: MiUser['id'], keywordId: string): Promise<Record<string, never>> {
		return await this.mutate(userId, async stateService => await this.deleteKeywordLocked(stateService, userId, keywordId));
	}

	private async deleteKeywordLocked(stateService: MastodonApiStateService, userId: MiUser['id'], keywordId: string): Promise<Record<string, never>> {
		const filters = await this.snapshot(userId, stateService);
		const { filter } = this.requireKeyword(filters, keywordId);
		await this.save(userId, {
			...filter,
			keywords: filter.keywords.filter(value => value.id !== keywordId),
		}, filters, stateService);
		return {};
	}

	public async listStatuses(userId: MiUser['id'], filterId: string): Promise<MastodonFilterStatus[]> {
		return this.requireFilter(await this.snapshot(userId), filterId).statuses;
	}

	public async getStatus(userId: MiUser['id'], filterStatusId: string): Promise<MastodonFilterStatus> {
		return this.requireStatus(await this.snapshot(userId), filterStatusId).status;
	}

	public async createStatus(userId: MiUser['id'], filterId: string, input: Dictionary): Promise<MastodonFilterStatus> {
		return await this.mutate(userId, async stateService => {
			const filters = await this.snapshot(userId, stateService);
			const filter = this.requireFilter(filters, filterId);
			if (filter.statuses.length >= MAX_STATUSES) this.invalid(`Statuses are limited to ${MAX_STATUSES} per filter`);
			const status = this.newStatus(input);
			await this.save(userId, { ...filter, statuses: [...filter.statuses, status] }, filters, stateService);
			return status;
		});
	}

	public async deleteStatus(userId: MiUser['id'], filterStatusId: string): Promise<Record<string, never>> {
		return await this.mutate(userId, async stateService => {
			const filters = await this.snapshot(userId, stateService);
			const { filter } = this.requireStatus(filters, filterStatusId);
			await this.save(userId, {
				...filter,
				statuses: filter.statuses.filter(value => value.id !== filterStatusId),
			}, filters, stateService);
			return {};
		});
	}

	public async listV1(userId: MiUser['id']): Promise<MastodonV1Filter[]> {
		return (await this.snapshot(userId)).flatMap(filter => filter.keywords.map(keyword => this.v1(filter, keyword)));
	}

	public async getV1(userId: MiUser['id'], keywordId: string): Promise<MastodonV1Filter> {
		const { filter, keyword } = this.requireKeyword(await this.snapshot(userId), keywordId);
		return this.v1(filter, keyword);
	}

	public async createV1(userId: MiUser['id'], input: Dictionary): Promise<MastodonV1Filter> {
		return await this.mutate(userId, async stateService => {
			const phrase = this.keyword(input.phrase);
			const filter = await this.createV2Locked(stateService, userId, {
				title: phrase,
				context: input.context,
				filter_action: this.boolean(input.irreversible, 'irreversible', false) ? 'hide' : 'warn',
				expires_in: input.expires_in,
				keywords: [{ keyword: phrase, whole_word: this.boolean(input.whole_word, 'whole_word', false) }],
			});
			return this.v1(filter, filter.keywords[0]!);
		});
	}

	public async updateV1(userId: MiUser['id'], keywordId: string, input: Dictionary): Promise<MastodonV1Filter> {
		return await this.mutate(userId, async stateService => {
			const filters = await this.snapshot(userId, stateService);
			const { filter, keyword } = this.requireKeyword(filters, keywordId);
			const phrase = Object.hasOwn(input, 'phrase') ? this.keyword(input.phrase) : keyword.keyword;
			const context = Object.hasOwn(input, 'context') ? this.contexts(input.context) : filter.context;
			const action = Object.hasOwn(input, 'irreversible')
				? this.boolean(input.irreversible, 'irreversible') ? 'hide' : 'warn'
				: filter.filter_action;
			const expiresAt = Object.hasOwn(input, 'expires_in') ? this.expiresAt(input.expires_in, null) : filter.expires_at;
			if (filter.keywords.length > 1 && (
				JSON.stringify(context) !== JSON.stringify(filter.context) ||
			action !== filter.filter_action ||
			expiresAt !== filter.expires_at
			)) this.invalid('A v1 filter cannot change shared attributes while its v2 filter has multiple keywords');
			const updatedKeyword = {
				...keyword,
				keyword: phrase,
				whole_word: Object.hasOwn(input, 'whole_word') ? this.boolean(input.whole_word, 'whole_word') : keyword.whole_word,
			};
			const updatedFilter: MastodonFilter = {
				...filter,
				title: filter.keywords.length === 1 ? phrase : filter.title,
				context,
				filter_action: action,
				expires_at: expiresAt,
				keywords: filter.keywords.map(value => value.id === keywordId ? updatedKeyword : value),
			};
			await this.save(userId, updatedFilter, filters, stateService);
			return this.v1(updatedFilter, updatedKeyword);
		});
	}

	public async deleteV1(userId: MiUser['id'], keywordId: string): Promise<Record<string, never>> {
		return await this.mutate(userId, async stateService => await this.deleteKeywordLocked(stateService, userId, keywordId));
	}

	public async apply<T extends Record<string, unknown>>(
		userId: MiUser['id'],
		context: MastodonFilterContext,
		statuses: T[],
		options: MastodonFilterApplyOptions = {},
	): Promise<T[]> {
		if (!MASTODON_FILTER_CONTEXTS.includes(context)) this.invalid('Invalid filter context');
		const now = Date.now();
		const filters = (await this.snapshot(userId)).filter(filter =>
			filter.context.includes(context) &&
			(filter.expires_at == null || Date.parse(filter.expires_at) > now));
		return statuses.flatMap(status => {
			const statusId = typeof status.id === 'string' ? status.id : String(status.id ?? '');
			const corpus = options.corpora?.get(statusId) ?? [];
			const matches = filters.flatMap(filter => {
				const keywordMatches = filter.keywords.filter(keyword => corpus.some(text => this.matches(text, keyword.keyword, keyword.whole_word)));
				const statusMatches = filter.statuses.filter(value => value.status_id === statusId);
				if (keywordMatches.length === 0 && statusMatches.length === 0) return [];
				return [{
					filter: {
						id: filter.id,
						title: filter.title,
						context: filter.context,
						expires_at: filter.expires_at,
						filter_action: filter.filter_action,
					},
					keyword_matches: keywordMatches.length === 0 ? null : keywordMatches.map(keyword => keyword.keyword),
					status_matches: statusMatches.length === 0 ? null : statusMatches.map(value => value.status_id),
				}];
			});
			if (matches.length === 0) return [status];
			if (!options.preserveHidden && matches.some(match => match.filter.filter_action === 'hide')) return [];
			const existing = Array.isArray(status.filtered) ? status.filtered : [];
			return [{ ...status, filtered: [...existing, ...matches] } as T];
		});
	}

	private async mutate<T>(userId: MiUser['id'], callback: (stateService: MastodonApiStateService) => Promise<T>): Promise<T> {
		return await this.mastodonApiStateService.withUserKindLock(userId, FILTER_KIND, callback);
	}

	private async snapshot(userId: MiUser['id'], stateService = this.mastodonApiStateService): Promise<MastodonFilter[]> {
		const rows = await stateService.list(userId, FILTER_KIND);
		return rows.flatMap(row => this.isFilter(row.value) ? [row.value] : []);
	}

	private async save(userId: MiUser['id'], filter: MastodonFilter, current: MastodonFilter[], stateService = this.mastodonApiStateService): Promise<void> {
		const next = current.some(value => value.id === filter.id)
			? current.map(value => value.id === filter.id ? filter : value)
			: [...current, filter];
		if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_FILTER_STATE_BYTES) {
			this.invalid(`Filter state is limited to ${MAX_FILTER_STATE_BYTES} bytes`);
		}
		await stateService.put({
			userId,
			kind: FILTER_KIND,
			key: filter.id,
			value: filter,
			expiresAt: filter.expires_at == null ? null : new Date(filter.expires_at),
		});
	}

	private requireFilter(filters: MastodonFilter[], filterId: string): MastodonFilter {
		const filter = filters.find(value => value.id === filterId);
		if (filter == null) this.notFound();
		return filter;
	}

	private requireKeyword(filters: MastodonFilter[], keywordId: string): { filter: MastodonFilter; keyword: MastodonFilterKeyword } {
		for (const filter of filters) {
			const keyword = filter.keywords.find(value => value.id === keywordId);
			if (keyword != null) return { filter, keyword };
		}
		this.notFound();
	}

	private requireStatus(filters: MastodonFilter[], filterStatusId: string): { filter: MastodonFilter; status: MastodonFilterStatus } {
		for (const filter of filters) {
			const status = filter.statuses.find(value => value.id === filterStatusId);
			if (status != null) return { filter, status };
		}
		this.notFound();
	}

	private newKeywords(value: unknown): MastodonFilterKeyword[] {
		if (value == null) return [];
		if (!Array.isArray(value)) this.invalid('keywords must be an array');
		if (value.length > MAX_KEYWORDS) this.invalid(`Keywords are limited to ${MAX_KEYWORDS} per filter`);
		return value.map(item => this.newKeyword(this.dictionary(item, 'keyword')));
	}

	private newKeyword(input: Dictionary): MastodonFilterKeyword {
		return {
			id: randomUUID(),
			keyword: this.keyword(input.keyword),
			whole_word: this.boolean(input.whole_word, 'whole_word', false),
		};
	}

	private updateKeywords(current: MastodonFilterKeyword[], value: unknown): MastodonFilterKeyword[] {
		if (!Array.isArray(value)) this.invalid('keywords_attributes must be an array');
		let keywords = [...current];
		for (const item of value) {
			const input = this.dictionary(item, 'keyword');
			const id = typeof input.id === 'string' ? input.id : null;
			if (id == null) {
				keywords.push(this.newKeyword(input));
				continue;
			}
			const existing = keywords.find(keyword => keyword.id === id);
			if (existing == null) this.notFound();
			if (this.boolean(input._destroy, '_destroy', false)) {
				keywords = keywords.filter(keyword => keyword.id !== id);
			} else {
				keywords = keywords.map(keyword => keyword.id === id ? {
					...keyword,
					keyword: Object.hasOwn(input, 'keyword') ? this.keyword(input.keyword) : keyword.keyword,
					whole_word: Object.hasOwn(input, 'whole_word') ? this.boolean(input.whole_word, 'whole_word') : keyword.whole_word,
				} : keyword);
			}
		}
		if (keywords.length > MAX_KEYWORDS) this.invalid(`Keywords are limited to ${MAX_KEYWORDS} per filter`);
		return keywords;
	}

	private newStatuses(value: unknown): MastodonFilterStatus[] {
		if (value == null) return [];
		if (!Array.isArray(value)) this.invalid('statuses must be an array');
		if (value.length > MAX_STATUSES) this.invalid(`Statuses are limited to ${MAX_STATUSES} per filter`);
		return value.map(item => this.newStatus(this.dictionary(item, 'status')));
	}

	private newStatus(input: Dictionary): MastodonFilterStatus {
		const statusId = typeof input.status_id === 'string' ? input.status_id : '';
		if (statusId === '') this.invalid('status_id cannot be blank');
		return { id: randomUUID(), status_id: statusId };
	}

	private title(value: unknown): string {
		if (typeof value !== 'string' || value.trim() === '') this.invalid('title cannot be blank');
		if ([...value].length > MAX_TITLE_LENGTH) this.invalid(`title is limited to ${MAX_TITLE_LENGTH} characters`);
		return value;
	}

	private keyword(value: unknown): string {
		if (typeof value !== 'string' || value.trim() === '') this.invalid('keyword cannot be blank');
		if ([...value].length > MAX_KEYWORD_LENGTH) this.invalid(`keyword is limited to ${MAX_KEYWORD_LENGTH} characters`);
		return value;
	}

	private contexts(value: unknown): MastodonFilterContext[] {
		const raw = Array.isArray(value) ? value : value == null ? [] : [value];
		if (raw.length === 0 || raw.some(context => typeof context !== 'string' || !MASTODON_FILTER_CONTEXTS.includes(context as MastodonFilterContext))) {
			this.invalid(`context must contain only ${MASTODON_FILTER_CONTEXTS.join(', ')}`);
		}
		return [...new Set(raw)] as MastodonFilterContext[];
	}

	private action(value: unknown, fallback: MastodonFilterAction): MastodonFilterAction {
		if (value == null || value === '') return fallback;
		if (typeof value !== 'string' || !MASTODON_FILTER_ACTIONS.includes(value as MastodonFilterAction)) {
			this.invalid(`filter_action must be ${MASTODON_FILTER_ACTIONS.join(', ')}`);
		}
		return value as MastodonFilterAction;
	}

	private expiresAt(value: unknown, fallback: string | null): string | null {
		if (value == null || value === '') return fallback;
		const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
		if (!Number.isInteger(seconds) || seconds < 0) this.invalid('expires_in must be a non-negative integer');
		const expiresAt = new Date(Date.now() + seconds * 1000);
		if (!Number.isFinite(expiresAt.getTime())) this.invalid('expires_in is out of range');
		return expiresAt.toISOString();
	}

	private boolean(value: unknown, name: string, fallback?: boolean): boolean {
		if (value == null || value === '') {
			if (fallback != null) return fallback;
			this.invalid(`${name} must be a boolean`);
		}
		if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return true;
		if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
		this.invalid(`${name} must be a boolean`);
	}

	private dictionary(value: unknown, name: string): Dictionary {
		if (value == null || typeof value !== 'object' || Array.isArray(value)) this.invalid(`${name} must be an object`);
		return value as Dictionary;
	}

	private v1(filter: MastodonFilter, keyword: MastodonFilterKeyword): MastodonV1Filter {
		return {
			id: keyword.id,
			phrase: keyword.keyword,
			context: filter.context,
			whole_word: keyword.whole_word,
			expires_at: filter.expires_at,
			irreversible: filter.filter_action === 'hide',
		};
	}

	private matches(text: string, literal: string, wholeWord: boolean): boolean {
		const haystack = text.normalize('NFKC').toLocaleLowerCase('und');
		const needle = literal.normalize('NFKC').toLocaleLowerCase('und');
		let from = 0;
		while (from <= haystack.length - needle.length) {
			const index = haystack.indexOf(needle, from);
			if (index < 0) return false;
			if (!wholeWord || this.hasWordBoundaries(haystack, needle, index)) return true;
			from = index + Math.max(1, needle.length);
		}
		return false;
	}

	private hasWordBoundaries(haystack: string, needle: string, index: number): boolean {
		const first = [...needle][0];
		const last = [...needle].at(-1);
		const previous = [...haystack.slice(0, index)].at(-1);
		const next = [...haystack.slice(index + needle.length)][0];
		return !(first != null && this.letterOrNumber(first) && previous != null && this.letterOrNumber(previous)) &&
			!(last != null && this.letterOrNumber(last) && next != null && this.letterOrNumber(next));
	}

	private letterOrNumber(value: string): boolean {
		return /[\p{L}\p{N}]/u.test(value);
	}

	private isFilter(value: unknown): value is MastodonFilter {
		if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
		const filter = value as Partial<MastodonFilter>;
		return typeof filter.id === 'string' &&
			typeof filter.title === 'string' &&
			Array.isArray(filter.context) &&
			typeof filter.filter_action === 'string' &&
			Array.isArray(filter.keywords) &&
			Array.isArray(filter.statuses);
	}

	private invalid(message: string): never {
		throw new MastodonApiError(422, 'unprocessable_entity', message);
	}

	private notFound(): never {
		throw new MastodonApiError(404, 'not_found', 'Record not found');
	}
}
