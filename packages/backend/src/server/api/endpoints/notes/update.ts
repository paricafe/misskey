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
import {
	NOTE_CANNOT_EDIT_RENOTE_ERROR_ID,
	NOTE_FILE_NOT_FOUND_ERROR_ID,
	NOTE_HISTORY_LIMIT_ERROR_ID,
	NOTE_NO_CONTENT_ERROR_ID,
	NOTE_NOT_FOUND_ERROR_ID,
	NOTE_PROHIBITED_WORDS_ERROR_ID,
	NOTE_SENSITIVE_WORDS_ERROR_ID,
	NOTE_TOO_MANY_MENTIONS_ERROR_ID,
	NoteUpdateService,
} from '@/core/NoteUpdateService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,
	requiredRolePolicy: 'canEditNote',
	prohibitMoved: true,

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

		containsProhibitedWords: {
			message: 'Cannot update because it contains prohibited words.',
			code: 'CONTAINS_PROHIBITED_WORDS',
			id: 'b2f1c6a4-7d3e-4e8b-9c5a-1f6d2e8a4b70',
		},

		containsSensitiveWords: {
			message: 'Cannot add sensitive words to a public note.',
			code: 'CONTAINS_SENSITIVE_WORDS',
			id: 'c4e7a2b9-1f5d-4a3c-8e6b-2d9f7a1c5e38',
		},

		noContent: {
			message: 'A note must have text, files, or a poll.',
			code: 'NO_CONTENT',
			id: '0bee35b5-4dfa-4a0b-a9b7-34d69c4938e1',
			kind: 'client',
			httpStatusCode: 400,
		},

		cannotEditRenote: {
			message: 'Cannot edit a pure renote.',
			code: 'CANNOT_EDIT_RENOTE',
			id: NOTE_CANNOT_EDIT_RENOTE_ERROR_ID,
			kind: 'client',
			httpStatusCode: 400,
		},

		tooManyMentions: {
			message: 'Too many mentions.',
			code: 'TOO_MANY_MENTIONS',
			id: NOTE_TOO_MANY_MENTIONS_ERROR_ID,
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
		cw: { type: 'string', nullable: true, minLength: 1, maxLength: 100 },
		fileComments: {
			type: 'array',
			minItems: 0,
			maxItems: MAX_NOTE_FILES,
			items: {
				type: 'object',
				properties: {
					fileId: { type: 'string', format: 'misskey:id' },
					comment: { type: 'string', maxLength: 512, nullable: true },
				},
				required: ['fileId', 'comment'],
			},
		},
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

			if (isRenote(note) && !isQuote(note)) {
				throw new ApiError(meta.errors.cannotEditRenote);
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

			const normalizedText = ps.text?.trim() ? ps.text.trim() : null;
			const normalizedCw = ps.cw != null && ps.cw.length > 0 ? ps.cw : null;
			const finalFileIds = fileIds ?? note.fileIds;
			if (normalizedText == null && finalFileIds.length === 0 && !note.hasPoll) {
				throw new ApiError(meta.errors.noContent);
			}

			let changedFileComments: Array<{ fileId: MiDriveFile['id']; comment: string | null }> = [];
			if (ps.fileComments != null && ps.fileComments.length > 0) {
				const commentFileIds = ps.fileComments.map(entry => entry.fileId);
				if (
					new Set(commentFileIds).size !== commentFileIds.length ||
					commentFileIds.some(fileId => !finalFileIds.includes(fileId))
				) {
					throw new ApiError(meta.errors.noSuchFile);
				}

				const targetFiles = files != null
					? files
					: await this.driveFilesRepository.createQueryBuilder('file')
						.where('file.userId = :userId AND file.id IN (:...commentFileIds)', {
							userId: me.id,
							commentFileIds,
						})
						.getMany();
				const fileById = new Map(targetFiles.map(file => [file.id, file]));
				if (commentFileIds.some(fileId => !fileById.has(fileId))) {
					throw new ApiError(meta.errors.noSuchFile);
				}

				changedFileComments = ps.fileComments
					.map(entry => ({
						fileId: entry.fileId,
						comment: entry.comment != null && entry.comment.length > 0 ? entry.comment : null,
					}))
					.filter(entry => (fileById.get(entry.fileId)!.comment ?? null) !== entry.comment);
			}

			if (
				note.text === normalizedText &&
				note.cw === normalizedCw &&
				note.fileIds.length === finalFileIds.length &&
				note.fileIds.every((fileId, index) => fileId === finalFileIds[index]) &&
				changedFileComments.length === 0
			) {
				return {
					updatedNote: await this.noteEntityService.pack(note, me),
				};
			}

			const updatedNote = await this.noteUpdateService.update(await this.usersRepository.findOneByOrFail({ id: note.userId }), note, {
				text: normalizedText,
				cw: normalizedCw,
				updatedAt: new Date(),
				files,
				...(changedFileComments.length > 0 ? { fileComments: changedFileComments } : {}),
			}, false, me).catch(error => {
				if (error instanceof IdentifiableError) {
					if (error.id === NOTE_HISTORY_LIMIT_ERROR_ID) throw new ApiError(meta.errors.historyLimitExceeded);
					if (error.id === NOTE_PROHIBITED_WORDS_ERROR_ID) throw new ApiError(meta.errors.containsProhibitedWords);
					if (error.id === NOTE_SENSITIVE_WORDS_ERROR_ID) throw new ApiError(meta.errors.containsSensitiveWords);
					if (error.id === NOTE_NOT_FOUND_ERROR_ID) throw new ApiError(meta.errors.noSuchNote);
					if (error.id === NOTE_NO_CONTENT_ERROR_ID) throw new ApiError(meta.errors.noContent);
					if (error.id === NOTE_CANNOT_EDIT_RENOTE_ERROR_ID) throw new ApiError(meta.errors.cannotEditRenote);
					if (error.id === NOTE_TOO_MANY_MENTIONS_ERROR_ID) throw new ApiError(meta.errors.tooManyMentions);
					if (error.id === NOTE_FILE_NOT_FOUND_ERROR_ID) throw new ApiError(meta.errors.noSuchFile);
				}
				throw error;
			});

			return {
				updatedNote: await this.noteEntityService.pack(updatedNote, me),
			};
		});
	}
}
