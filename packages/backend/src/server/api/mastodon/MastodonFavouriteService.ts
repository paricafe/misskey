/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { DI } from '@/di-symbols.js';
import { ReactionService } from '@/core/ReactionService.js';
import { RoleService } from '@/core/RoleService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import type { Packed } from '@/misc/json-schema.js';
import type { NoteReactionsRepository } from '@/models/_.js';
import { GetterService } from '@/server/api/GetterService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import { ApiError } from '@/server/api/error.js';
import { MastodonApiCallService } from './MastodonApiCallService.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import { MastodonApiError } from './errors.js';
import type { MastodonUserAuth } from './types.js';
import { isMastodonFavourite } from './utils.js';

export { isMastodonFavourite } from './utils.js';

const FAVOURITE = '\u2764';

@Injectable()
export class MastodonFavouriteService {
	constructor(
		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,
		private getterService: GetterService,
		private noteEntityService: NoteEntityService,
		private reactionService: ReactionService,
		private mastodonApiCallService: MastodonApiCallService,
		private mastodonScopeService: MastodonScopeService,
		private rateLimiterService: RateLimiterService,
		private roleService: RoleService,
	) {}

	public async set(noteId: string, enabled: boolean, auth: MastodonUserAuth, request: FastifyRequest): Promise<Packed<'Note'>> {
		this.mastodonScopeService.assert(auth.token.scopes, 'write:favourites');
		if (auth.user.isSuspended || auth.user.isDeleted) throw new MastodonApiError(403, 'forbidden', 'This account is unavailable');
		if (enabled && auth.user.movedToUri) throw new MastodonApiError(403, 'forbidden', 'You have moved your account');
		try {
			const note = await this.getterService.getNote(noteId);
			if (!await this.noteEntityService.isVisibleForMe(note, auth.user.id)) throw new MastodonApiError(404, 'not_found', 'Record not found');
			const current = await this.noteReactionsRepository.findOneBy({ noteId, userId: auth.user.id });
			if (enabled) {
				if (current != null && !isMastodonFavourite(current.reaction)) this.conflict();
				if (current == null) {
					try {
						// Keep the native Like, notification and federation path, without replacing an emoji set concurrently.
						await this.reactionService.create(auth.user, note, FAVOURITE, { replaceExisting: false });
					} catch (error) {
						if (!(error instanceof IdentifiableError) || error.id !== '51c42bb4-931a-456b-bff7-e5a8a70dd298') throw error;
						const existing = await this.noteReactionsRepository.findOneBy({ noteId, userId: auth.user.id });
						if (!isMastodonFavourite(existing?.reaction)) this.conflict();
					}
				}
			} else if (current != null && isMastodonFavourite(current.reaction)) {
				await this.checkDeleteRate(auth.user.id);
				try {
					// ReactionService checks the expected value and deletes the selected row ID, preserving newer emojis.
					await this.reactionService.delete(auth.user, note, current.reaction);
				} catch (error) {
					if (!(error instanceof IdentifiableError) || error.id !== '60527ec9-b4cb-4a88-a6bd-32d3ad26817d') throw error;
				}
			}
		} catch (error) {
			if (error instanceof IdentifiableError) {
				if (['9725d0ce-ba28-4dde-95a7-2cbb2c15de24', '68e9d2d1-48bf-42c2-b90a-b20e09fd3d48'].includes(error.id)) {
					throw new MastodonApiError(404, 'not_found', 'Record not found');
				}
				if (error.id === 'e70412a4-7197-4726-8e74-f3e0deb92aa7') throw new MastodonApiError(403, 'forbidden', 'You cannot favourite this status');
				if (error.id === '12c35529-3c79-4327-b1cc-e2cf63a71925') throw new MastodonApiError(422, 'unprocessable_entity', 'You cannot favourite a reblog wrapper');
			}
			throw error;
		}
		return await this.mastodonApiCallService.invoke('notes/show', { noteId }, auth, request) as Packed<'Note'>;
	}

	private conflict(): never {
		throw new MastodonApiError(422, 'unprocessable_entity', 'This status already has a Misskey emoji reaction; remove it before favouriting');
	}

	private async checkDeleteRate(userId: string): Promise<void> {
		const factor = (await this.roleService.getUserPolicies(userId)).rateLimitFactor;
		if (factor === 0) return;
		const rate = await this.rateLimiterService.limit({ key: 'notes/reactions/delete', duration: 3_600_000, max: 60, minInterval: 3000 }, userId, factor);
		if (rate != null) {
			throw new ApiError({ message: 'Rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED', kind: 'client', id: 'mastodon-favourite-rate-limit', httpStatusCode: 429 }, rate.info);
		}
	}
}
