/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { acquireDistributedLock } from '@/misc/distributed-lock.js';
import type { Packed } from '@/misc/json-schema.js';
import type * as Redis from 'ioredis';
import { MastodonApiStateService } from './MastodonApiStateService.js';
import { MastodonApiError } from './errors.js';
import { MastodonMediaService } from './MastodonMediaService.js';

type Dictionary = Record<string, unknown>;
export type MastodonStatusMetadata = { language?: string | null; sensitive?: boolean };
export type MastodonPostingPreferences = { privacy: string; sensitive: boolean; language: string | null };
type StoredStatusMetadata = MastodonStatusMetadata & { revisions?: Record<string, MastodonStatusMetadata> };

@Injectable()
export class MastodonStatusMetadataService {
	constructor(
		private state: MastodonApiStateService,
		private media: MastodonMediaService,
		@Inject(DI.redis) private redis: Redis.Redis,
	) {}

	public async withWrite<T>(userId: string, callback: () => Promise<T>): Promise<T> {
		// A stream may wait here while the writer still needs native repository
		// queries. Redis keeps these waiters out of the shared database pool.
		const unlock = await acquireDistributedLock(this.redis, `mastodon-status-write:${userId}`, 30_000, 300, 100);
		try {
			const result = await callback();
			await unlock.assertOwned();
			return result;
		} finally {
			await unlock();
		}
	}

	public async decoratePublished(note: Packed<'Note'>, status: Dictionary): Promise<Dictionary> {
		return await this.withWrite(note.userId, () => this.decorate(note, status));
	}

	public parse(body: Dictionary): MastodonStatusMetadata {
		const metadata: MastodonStatusMetadata = {};
		if (Object.hasOwn(body, 'language')) {
			const language = body.language;
			if (language != null && language !== '' && (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(language))) {
				throw new MastodonApiError(422, 'unprocessable_entity', 'language must be a language code');
			}
			metadata.language = language === '' || language == null ? null : (language as string).toLowerCase();
		}
		if (Object.hasOwn(body, 'sensitive')) metadata.sensitive = this.boolean(body.sensitive);
		return metadata;
	}

	public async preferences(userId: string): Promise<MastodonPostingPreferences> {
		const value = (await this.state.get(userId, 'posting_preferences', 'default'))?.value as Partial<MastodonPostingPreferences> | undefined;
		return { privacy: value?.privacy ?? 'public', sensitive: value?.sensitive ?? false, language: value?.language ?? null };
	}

	public parsePreferences(body: Dictionary): Partial<MastodonPostingPreferences> {
		const source = body.source != null && typeof body.source === 'object' && !Array.isArray(body.source) ? { ...body.source } as Dictionary : {};
		for (const key of ['privacy', 'sensitive', 'language']) {
			if (Object.hasOwn(body, `source[${key}]`)) source[key] = body[`source[${key}]`];
		}
		const result: Partial<MastodonPostingPreferences> = this.parse(source);
		if (Object.hasOwn(source, 'privacy')) {
			if (typeof source.privacy !== 'string' || !['public', 'unlisted', 'private', 'direct'].includes(source.privacy)) throw new MastodonApiError(422, 'unprocessable_entity', 'Invalid default visibility');
			result.privacy = source.privacy;
		}
		return result;
	}

	public async savePreferences(userId: string, update: Partial<MastodonPostingPreferences>): Promise<void> {
		if (Object.keys(update).length === 0) return;
		await this.state.withUserKindLock(userId, 'posting_preferences', async state => {
			const previous = (await state.get(userId, 'posting_preferences', 'default'))?.value as Dictionary | undefined;
			await state.put({ userId, kind: 'posting_preferences', key: 'default', value: { ...previous, ...update } });
		});
	}

	public async save(userId: string, noteId: string, metadata: MastodonStatusMetadata, previousVersion?: { createdAt: string; language: string | null; sensitive: boolean }): Promise<void> {
		if (Object.keys(metadata).length === 0 && previousVersion == null) return;
		await this.state.withUserKindLock(userId, `status_metadata:${noteId}`, async state => {
			const previous = (await state.get(userId, 'status_metadata', noteId))?.value as StoredStatusMetadata | undefined;
			const value: StoredStatusMetadata = {
				...previous,
				...metadata,
				...(previousVersion == null ? {} : {
					revisions: { ...previous?.revisions, [previousVersion.createdAt]: this.exposedMetadata(previousVersion) },
				}),
			};
			await state.put({ userId, kind: 'status_metadata', key: noteId, value });
		});
	}

	public async decorate(note: Packed<'Note'>, status: Dictionary): Promise<Dictionary> {
		const value = (await this.state.get(note.userId, 'status_metadata', note.id))?.value;
		const result = await this.decorateVersion(note.userId, status, value);
		if (note.renote != null) {
			if (result.reblog != null && typeof result.reblog === 'object') result.reblog = await this.decorate(note.renote, result.reblog as Dictionary);
			const quote = result.quote as Dictionary | undefined;
			if (quote?.quoted_status != null) result.quote = { ...quote, quoted_status: await this.decorate(note.renote, quote.quoted_status as Dictionary) };
		}
		return result;
	}

	public async decorateHistory(userId: string, noteId: string, edits: Dictionary[]): Promise<Dictionary[]> {
		if (edits.length === 0) return [];
		const value = (await this.state.get(userId, 'status_metadata', noteId))?.value as StoredStatusMetadata | undefined;
		return await Promise.all(edits.map((edit, index) => this.decorateVersion(userId, edit, index === edits.length - 1
			? value
			: typeof edit.created_at === 'string' ? value?.revisions?.[edit.created_at] : undefined)));
	}

	public async credentialAccount(userId: string, account: Dictionary): Promise<Dictionary> {
		return { ...account, source: { ...(account.source as Dictionary), ...await this.preferences(userId) } };
	}

	private async decorateVersion(userId: string, status: Dictionary, value: unknown): Promise<Dictionary> {
		const result: Dictionary = { ...status, ...this.exposedMetadata(value) };
		if (Array.isArray(result.media_attachments)) result.media_attachments = await Promise.all(result.media_attachments.map(attachment => this.media.decorate(userId, attachment as Dictionary)));
		return result;
	}

	private exposedMetadata(value: unknown): MastodonStatusMetadata {
		if (value == null || typeof value !== 'object') return {};
		const metadata: MastodonStatusMetadata = {};
		if ('language' in value && (value.language === null || typeof value.language === 'string')) metadata.language = value.language;
		if ('sensitive' in value && typeof value.sensitive === 'boolean') metadata.sensitive = value.sensitive;
		return metadata;
	}

	private boolean(value: unknown): boolean {
		if ([true, 1, '1', 'true', 'on'].includes(value as string)) return true;
		if ([false, 0, '0', 'false', 'off'].includes(value as string)) return false;
		throw new MastodonApiError(422, 'unprocessable_entity', 'sensitive must be a boolean');
	}
}
