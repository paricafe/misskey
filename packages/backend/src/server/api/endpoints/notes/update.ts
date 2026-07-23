/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import type { DriveFilesRepository, MiDriveFile, UsersRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { GetterService } from '@/server/api/GetterService.js';
import { MAX_NOTE_FILES, MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import { ApiError } from '@/server/api/error.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NOTE_HISTORY_LIMIT_ERROR_ID, NoteUpdateService } from '@/core/NoteUpdateService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	requiredRolePolicy: 'canEditNote',

	kind: 'write:notes',

	limit: {
		duration: ms('1hour'),
		max: 10,
		minInterval: ms('1sec'),
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			updatedNote: {
				type: 'object',
				optional: false, nullable: false,
				ref: 'Note',
			},
		},
	},

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'a6584e14-6e01-4ad3-b566-851e7bf0d474',
		},

		noSuchFile: {
			message: 'Some files are not found.',
			code: 'NO_SUCH_FILE',
			id: 'b6992544-63e7-67f0-fa7f-32444b1b5306',
		},

		historyLimitExceeded: {
			message: 'Note edit history limit exceeded.',
			code: 'NOTE_HISTORY_LIMIT_EXCEEDED',
			id: NOTE_HISTORY_LIMIT_ERROR_ID,
			kind: 'client',
			httpStatusCode: 422,
		},

		noContent: {
			message: 'A note must have text or files.',
			code: 'NO_CONTENT',
			id: '0bee35b5-4dfa-4a0b-a9b7-34d69c4938e1',
			kind: 'client',
			httpStatusCode: 400,
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		text: {
			type: 'string',
			minLength: 1,
			maxLength: MAX_NOTE_TEXT_LENGTH,
			nullable: true,
		},
		fileIds: {
			type: 'array',
			uniqueItems: true,
			minItems: 0,
			maxItems: MAX_NOTE_FILES,
			items: { type: 'string', format: 'misskey:id' },
		},
		mediaIds: {
			type: 'array',
			uniqueItems: true,
			minItems: 0,
			maxItems: MAX_NOTE_FILES,
			items: { type: 'string', format: 'misskey:id' },
		},
		cw: { type: 'string', nullable: true, maxLength: 100 },
	},
	required: ['noteId', 'text', 'cw'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private getterService: GetterService,

		private noteEntityService: NoteEntityService,
		private noteUpdateService: NoteUpdateService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			if (note.userId !== me.id) {
				throw new ApiError(meta.errors.noSuchNote);
			}

			let files: MiDriveFile[] | undefined;
			const fileIds = ps.fileIds ?? ps.mediaIds ?? null;
			if (fileIds != null) {
				files = fileIds.length === 0
					? []
					: await this.driveFilesRepository.createQueryBuilder('file')
						.where('file.userId = :userId AND file.id IN (:...fileIds)', {
							userId: me.id,
							fileIds,
						})
						.orderBy('array_position(ARRAY[:...fileIds], "id"::text)')
						.setParameters({ fileIds })
						.getMany();

				if (files.length !== fileIds.length) {
					throw new ApiError(meta.errors.noSuchFile);
				}
			}

			const finalFileIds = fileIds ?? note.fileIds;
			if (ps.text == null && finalFileIds.length === 0) {
				throw new ApiError(meta.errors.noContent);
			}

			if (
				note.text === ps.text &&
				note.cw === ps.cw &&
				note.fileIds.length === finalFileIds.length &&
				note.fileIds.every((fileId, index) => fileId === finalFileIds[index])
			) {
				// The same as old note, nothing to do
				return {
					updatedNote: await this.noteEntityService.pack(note, me),
				};
			}

			const updatedNote = await this.noteUpdateService.update(await this.usersRepository.findOneByOrFail({ id: note.userId }), note, {
				text: ps.text,
				cw: ps.cw,
				updatedAt: new Date(),
				files,
			}, false, me).catch(error => {
				if (error instanceof IdentifiableError && error.id === NOTE_HISTORY_LIMIT_ERROR_ID) {
					throw new ApiError(meta.errors.historyLimitExceeded);
				}
				throw error;
			});

			return {
				updatedNote: await this.noteEntityService.pack(updatedNote, me),
			};
		});
	}
}
