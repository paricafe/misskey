/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { NotesRepository, PollVotesRepository, UsersRepository } from '@/models/_.js';
import { MiPoll } from '@/models/Poll.js';
import { MiPollVote } from '@/models/PollVote.js';
import type { MiNote } from '@/models/Note.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';
import { ApiError } from '@/server/api/error.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { PollService } from '@/core/PollService.js';
import { QueueService } from '@/core/QueueService.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';

export const pollVoteErrors = {
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
} as const;

@Injectable()
export class PollVoteService {
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,

		private idService: IdService,
		private queueService: QueueService,
		private pollService: PollService,
		private apRendererService: ApRendererService,
		private globalEventService: GlobalEventService,
		private userBlockingService: UserBlockingService,
	) {
	}

	@bindThis
	public async vote(noteId: MiNote['id'], choices: number[], me: MiLocalUser): Promise<void> {
		const uniqueChoices = [...new Set(choices)];
		const note = await this.notesRepository.findOneBy({ id: noteId });

		if (note == null) {
			throw new ApiError(pollVoteErrors.noSuchNote);
		}

		if (!note.hasPoll) {
			throw new ApiError(pollVoteErrors.noPoll);
		}

		if (note.userId !== me.id) {
			const blocked = await this.userBlockingService.checkBlocked(note.userId, me.id);
			if (blocked) {
				throw new ApiError(pollVoteErrors.youHaveBeenBlocked);
			}
		}

		const result = await this.pollVotesRepository.manager.transaction(async manager => {
			const pollsRepository = manager.getRepository(MiPoll);
			const pollVotesRepository = manager.getRepository(MiPollVote);

			await pollsRepository.query(
				'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
				[JSON.stringify([note.id, me.id])],
			);

			const poll = await pollsRepository.findOneByOrFail({ noteId: note.id });
			const createdAt = new Date();
			const existingVotes = await pollVotesRepository.findBy({
				noteId: note.id,
				userId: me.id,
			});

			if (poll.expiresAt && poll.expiresAt < createdAt) {
				throw new ApiError(pollVoteErrors.alreadyExpired);
			}

			if (
				uniqueChoices.length === 0 ||
				(!poll.multiple && uniqueChoices.length > 1) ||
				uniqueChoices.some(choice => poll.choices[choice] == null)
			) {
				throw new ApiError(pollVoteErrors.invalidChoice);
			}

			if (
				(!poll.multiple && existingVotes.length > 0) ||
				existingVotes.some(vote => uniqueChoices.includes(vote.choice))
			) {
				throw new ApiError(pollVoteErrors.alreadyVoted);
			}

			const votes = uniqueChoices.map(choice => ({
				id: this.idService.gen(createdAt.getTime()),
				noteId: note.id,
				userId: me.id,
				choice,
			}));

			await pollVotesRepository.insert(votes);
			for (const choice of uniqueChoices) {
				await pollsRepository.query(
					'UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2',
					[choice + 1, note.id],
				);
			}

			return {
				poll,
				votes: votes as MiPollVote[],
			};
		});

		for (const vote of result.votes) {
			this.globalEventService.publishNoteStream(note, 'pollVoted', {
				choice: vote.choice,
				userId: me.id,
			});
		}

		if (note.userHost != null) {
			const pollOwner = await this.usersRepository.findOneByOrFail({ id: note.userId }) as MiRemoteUser;
			for (const vote of result.votes) {
				this.queueService.deliver(
					me,
					this.apRendererService.addContext(await this.apRendererService.renderVote(me, vote, note, result.poll, pollOwner)),
					pollOwner.inbox,
					false,
				);
			}
		}

		this.pollService.deliverQuestionUpdate(note.id);
	}
}
