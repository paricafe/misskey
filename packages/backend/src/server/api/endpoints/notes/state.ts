/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { NotesRepository, NoteThreadMutingsRepository, NoteFavoritesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	kind: 'read:account',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			isFavorited: {
				type: 'boolean',
				optional: false, nullable: false,
			},
			isMutedThread: {
				type: 'boolean',
				optional: false, nullable: false,
			},
			myRenoteId: {
				type: 'string',
				format: 'misskey:id',
				optional: true, nullable: true,
			},
		},
	},

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'f4b8c3d1-7e29-4a15-9c6b-8e4a2d1f7c30',
			httpStatusCode: 404,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
	},
	required: ['noteId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private noteThreadMutingsRepository: NoteThreadMutingsRepository,

		@Inject(DI.noteFavoritesRepository)
		private noteFavoritesRepository: NoteFavoritesRepository,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.notesRepository.findOneBy({ id: ps.noteId });
			if (note == null) {
				throw new ApiError(meta.errors.noSuchNote);
			}

			const [favorite, threadMuting, myRenote] = await Promise.all([
				this.noteFavoritesRepository.count({
					where: {
						userId: me.id,
						noteId: note.id,
					},
					take: 1,
				}),
				this.noteThreadMutingsRepository.count({
					where: {
						userId: me.id,
						threadId: note.threadId ?? note.id,
					},
					take: 1,
				}),
				this.notesRepository.createQueryBuilder('renote')
					.select('renote.id')
					.where('renote.userId = :userId', { userId: me.id })
					.andWhere('renote.renoteId = :noteId', { noteId: note.id })
					.andWhere('renote.replyId IS NULL')
					.andWhere('renote.text IS NULL')
					.andWhere('renote.cw IS NULL')
					.andWhere('renote.hasPoll = FALSE')
					.andWhere('renote.fileIds = \'{}\'')
					.orderBy('renote.id', 'DESC')
					.limit(1)
					.getOne(),
			]);

			return {
				isFavorited: favorite !== 0,
				isMutedThread: threadMuting !== 0,
				myRenoteId: myRenote?.id ?? null,
			};
		});
	}
}
