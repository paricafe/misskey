/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { NotesRepository } from '@/models/_.js';
import type { Packed } from '@/misc/json-schema.js';
import type { FastifyRequest } from 'fastify';
import { MastodonApiStateService } from './MastodonApiStateService.js';
import { MastodonApiCallService } from './MastodonApiCallService.js';
import { MastodonEntityService } from './MastodonEntityService.js';
import { MastodonApiError } from './errors.js';
import type { MastodonUserAuth } from './types.js';

type Dictionary = Record<string, unknown>;
type MediaState = { deleted?: boolean; description?: string | null; focus?: { x: number; y: number } };

@Injectable()
export class MastodonMediaService {
	constructor(
		private state: MastodonApiStateService,
		private api: MastodonApiCallService,
		private entities: MastodonEntityService,
		@Inject(DI.notesRepository) private notes: NotesRepository,
	) {}

	public validate(body: Dictionary): MediaState {
		if (Object.hasOwn(body, 'thumbnail')) throw new MastodonApiError(422, 'unprocessable_entity', 'Custom thumbnails are not supported');
		if (Object.hasOwn(body, 'description') && body.description != null && typeof body.description !== 'string') throw new MastodonApiError(422, 'unprocessable_entity', 'description must be a string');
		if (typeof body.description === 'string' && [...body.description].length > 512) throw new MastodonApiError(422, 'unprocessable_entity', 'description must not exceed 512 characters');
		const metadata: MediaState = Object.hasOwn(body, 'description') ? { description: body.description as string | null ?? null } : {};
		if (!Object.hasOwn(body, 'focus')) return metadata;
		if (typeof body.focus !== 'string') throw new MastodonApiError(422, 'unprocessable_entity', 'focus must contain two coordinates');
		const coordinates = body.focus.split(',');
		const [x, y] = coordinates.map(Number);
		if (coordinates.length !== 2 || coordinates.some(value => value.trim() === '') || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1) throw new MastodonApiError(422, 'unprocessable_entity', 'focus coordinates must be between -1 and 1');
		return { ...metadata, focus: { x, y } };
	}

	public async register(file: Packed<'DriveFile'>, userId: string, metadata: MediaState): Promise<Dictionary> {
		await this.state.put({ userId, kind: 'media_attachment', key: file.id, value: metadata });
		return this.attachment(file, metadata);
	}

	public async show(id: string, auth: MastodonUserAuth, request: FastifyRequest): Promise<Dictionary> {
		const metadata = await this.owned(id, auth.user.id);
		const file = await this.api.invoke('drive/files/show', { fileId: id }, auth, request) as Packed<'DriveFile'>;
		return this.attachment(file, metadata);
	}

	public async update(id: string, body: Dictionary, auth: MastodonUserAuth, request: FastifyRequest): Promise<Dictionary> {
		const update = this.validate(body);
		await this.owned(id, auth.user.id);
		await this.assertUnused(id);
		const file = await this.api.invoke('drive/files/show', { fileId: id }, auth, request) as Packed<'DriveFile'>;
		return await this.state.withUserKindLock(auth.user.id, 'media_attachment', async state => {
			const previous = await this.owned(id, auth.user.id, state);
			// Post-upload edits are local compatibility metadata. Native Drive clients
			// and federation retain the original upload description, even if native
			// content attaches this file concurrently after the unused check.
			const metadata = { ...previous, ...update };
			await state.put({ userId: auth.user.id, kind: 'media_attachment', key: id, value: metadata });
			return this.attachment(file, metadata);
		});
	}

	public async remove(id: string, auth: MastodonUserAuth): Promise<void> {
		await this.owned(id, auth.user.id);
		await this.assertUnused(id);
		await this.state.withUserKindLock(auth.user.id, 'media_attachment', async state => {
			const metadata = await this.owned(id, auth.user.id, state);
			// Revoke the compatibility attachment only. Native clients can attach a Drive
			// file concurrently, so a queued physical deletion cannot be made safe here.
			await state.put({ userId: auth.user.id, kind: 'media_attachment', key: id, value: { ...metadata, deleted: true } });
		});
	}

	public async assertAvailable(ids: readonly string[], userId: string): Promise<void> {
		for (const id of ids) {
			const state = await this.state.get(userId, 'media_attachment', id);
			if ((state?.value as MediaState | undefined)?.deleted) throw new MastodonApiError(422, 'unprocessable_entity', 'Media attachment has been deleted');
		}
	}

	public async decorate(userId: string, attachment: Dictionary): Promise<Dictionary> {
		const metadata = (await this.state.get(userId, 'media_attachment', attachment.id as string))?.value as MediaState | undefined;
		return this.overlay(attachment, metadata);
	}

	private attachment(file: Packed<'DriveFile'>, metadata: MediaState): Dictionary {
		return this.overlay(this.entities.attachment(file), metadata);
	}

	private overlay(attachment: Dictionary, metadata: MediaState | undefined): Dictionary {
		if (metadata == null) return attachment;
		return {
			...attachment,
			...(Object.hasOwn(metadata, 'description') ? { description: metadata.description } : {}),
			...(metadata.focus == null ? {} : { meta: { ...(attachment.meta as Dictionary), focus: metadata.focus } }),
		};
	}

	private async owned(id: string, userId: string, state = this.state): Promise<MediaState> {
		const row = await state.get(userId, 'media_attachment', id);
		const metadata = row?.value as MediaState | undefined;
		if (metadata == null || metadata.deleted) throw new MastodonApiError(404, 'not_found', 'Record not found');
		return metadata;
	}

	private async assertUnused(id: string): Promise<void> {
		const rows = await this.notes.query(`SELECT EXISTS (
			SELECT 1 FROM "note" WHERE $1 = ANY("fileIds")
			UNION ALL SELECT 1 FROM "note_draft" WHERE $1 = ANY("fileIds")
			UNION ALL SELECT 1 FROM "user" WHERE "avatarId" = $1 OR "bannerId" = $1
		) AS used`, [id]) as { used: boolean }[];
		if (rows[0]?.used) throw new MastodonApiError(422, 'unprocessable_entity', 'Media attachment is already in use');
	}
}
