/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { PollVoteService } from '@/core/PollVoteService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,

	prohibitMoved: true,

	kind: 'write:votes',

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'ecafbd2e-c283-4d6d-aecb-1a0a33b75396',
		},

		noPoll: {
			message: 'The note does not attach a poll.',
			code: 'NO_POLL',
			id: '5f979967-52d9-4314-a911-1c673727f92f',
		},

		invalidChoice: {
			message: 'Choice ID is invalid.',
			code: 'INVALID_CHOICE',
			id: 'e0cc9a04-f2e8-41e4-a5f1-4127293260cc',
		},

		alreadyVoted: {
			message: 'You have already voted.',
			code: 'ALREADY_VOTED',
			id: '0963fc77-efac-419b-9424-b391608dc6d8',
		},

		alreadyExpired: {
			message: 'The poll is already expired.',
			code: 'ALREADY_EXPIRED',
			id: '1022a357-b085-4054-9083-8f8de358337e',
		},

		youHaveBeenBlocked: {
			message: 'You cannot vote this poll because you have been blocked by this user.',
			code: 'YOU_HAVE_BEEN_BLOCKED',
			id: '85a5377e-b1e9-4617-b0b9-5bea73331e49',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		choice: { type: 'integer' },
	},
	required: ['noteId', 'choice'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private pollVoteService: PollVoteService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.pollVoteService.vote(ps.noteId, [ps.choice], me);
		});
	}
}
