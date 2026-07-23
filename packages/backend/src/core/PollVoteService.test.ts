/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MiPoll } from '@/models/Poll.js';
import { MiPollVote } from '@/models/PollVote.js';
import { PollVoteService } from './PollVoteService.js';

type FailurePoint = 'insert' | 'firstUpdate' | 'secondUpdate';

function createService(options: {
	multiple?: boolean;
	choices?: string[];
	expiresAt?: Date | null;
	existingChoices?: number[];
	blocked?: boolean;
	failurePoint?: FailurePoint;
	remote?: boolean;
	hasPoll?: boolean;
	noteMissing?: boolean;
} = {}) {
	const me = { id: 'voter-id' };
	const note = {
		id: 'note-id',
		userId: 'poll-owner-id',
		userHost: options.remote === true ? 'remote.example' : null,
		hasPoll: options.hasPoll ?? true,
	};
	let persistedPoll = {
		noteId: note.id,
		expiresAt: options.expiresAt ?? null,
		multiple: options.multiple ?? true,
		choices: options.choices ?? ['red', 'green', 'blue'],
		votes: (options.choices ?? ['red', 'green', 'blue']).map(() => 0),
	};
	let persistedVotes = (options.existingChoices ?? []).map((choice, index) => ({
		id: `existing-${index}`,
		noteId: note.id,
		userId: me.id,
		choice,
	}));
	let transactionPoll = persistedPoll;
	let transactionVotes = persistedVotes;
	let updateCount = 0;
	let id = 0;
	const order: string[] = [];

	const pollsRepository = {
		findOneByOrFail: vi.fn(async () => {
			order.push('poll:read');
			return { ...transactionPoll, choices: [...transactionPoll.choices], votes: [...transactionPoll.votes] };
		}),
		query: vi.fn(async (sql: string, parameters: unknown[]) => {
			if (sql.includes('pg_advisory_xact_lock')) {
				order.push('lock');
				return [];
			}

			order.push('poll:update');
			updateCount++;
			const [index, noteId] = parameters as [number, string];
			if (noteId !== note.id) throw new Error('unexpected note');
			transactionPoll.votes[index - 1]++;
			if (
				(options.failurePoint === 'firstUpdate' && updateCount === 1) ||
				(options.failurePoint === 'secondUpdate' && updateCount === 2)
			) {
				throw new Error('forced update failure');
			}
			return [];
		}),
	};
	const pollVotesRepository = {
		findBy: vi.fn(async () => {
			order.push('votes:read');
			return transactionVotes.map(vote => ({ ...vote }));
		}),
		insert: vi.fn(async (rows: Array<{ id: string; noteId: string; userId: string; choice: number }>) => {
			order.push('votes:insert');
			transactionVotes.push(...rows.map(row => ({ ...row })));
			if (options.failurePoint === 'insert') throw new Error('forced insert failure');
			return {};
		}),
		manager: {
			transaction: vi.fn(async (callback: (manager: { getRepository: (entity: unknown) => unknown }) => Promise<unknown>) => {
				transactionPoll = { ...persistedPoll, choices: [...persistedPoll.choices], votes: [...persistedPoll.votes] };
				transactionVotes = persistedVotes.map(vote => ({ ...vote }));
				updateCount = 0;
				order.push('transaction:start');
				try {
					const result = await callback({
						getRepository: entity => {
							if (entity === MiPoll) return pollsRepository;
							if (entity === MiPollVote) return pollVotesRepository;
							throw new Error('unexpected repository');
						},
					});
					persistedPoll = transactionPoll;
					persistedVotes = transactionVotes;
					order.push('commit');
					return result;
				} catch (error) {
					order.push('rollback');
					throw error;
				}
			}),
		},
	};
	const usersRepository = {
		findOneByOrFail: vi.fn().mockResolvedValue({
			id: note.userId,
			host: 'remote.example',
			inbox: 'https://remote.example/inbox',
		}),
	};
	const notesRepository = {
		findOneBy: options.noteMissing === true
			? vi.fn().mockResolvedValue(null)
			: vi.fn().mockResolvedValue(note),
	};
	const userBlockingService = {
		checkBlocked: vi.fn().mockResolvedValue(options.blocked ?? false),
	};
	const globalEventService = {
		publishNoteStream: vi.fn(() => order.push('event')),
	};
	const queueService = {
		deliver: vi.fn(() => {
			order.push('deliver');
			return Promise.resolve();
		}),
	};
	const apRendererService = {
		renderVote: vi.fn(async (_user, vote: { id: string }) => ({ id: `activity-${vote.id}` })),
		addContext: vi.fn(value => value),
	};
	const pollService = {
		deliverQuestionUpdate: vi.fn(() => {
			order.push('question:update');
			return Promise.resolve();
		}),
	};
	const idService = {
		gen: vi.fn(() => `vote-${++id}`),
	};
	const service = new PollVoteService(
		usersRepository as never,
		notesRepository as never,
		pollVotesRepository as never,
		idService as never,
		queueService as never,
		pollService as never,
		apRendererService as never,
		globalEventService as never,
		userBlockingService as never,
	);

	return {
		service,
		me,
		note,
		pollsRepository,
		pollVotesRepository,
		usersRepository,
		notesRepository,
		userBlockingService,
		globalEventService,
		queueService,
		apRendererService,
		pollService,
		idService,
		order,
		persisted: () => ({
			poll: persistedPoll,
			votes: persistedVotes,
		}),
	};
}

describe(PollVoteService, () => {
	test('rejects the complete request when one choice is invalid', async () => {
		const { service, note, me, pollVotesRepository, persisted } = createService();

		await expect(service.vote(note.id, [0, 999], me as never)).rejects.toMatchObject({ code: 'INVALID_CHOICE' });

		expect(pollVotesRepository.insert).not.toHaveBeenCalled();
		expect(persisted().votes).toHaveLength(0);
	});

	test('rejects multiple choices for a single-choice poll', async () => {
		const { service, note, me, pollVotesRepository, persisted } = createService({ multiple: false });

		await expect(service.vote(note.id, [0, 1], me as never)).rejects.toMatchObject({ code: 'INVALID_CHOICE' });

		expect(pollVotesRepository.insert).not.toHaveBeenCalled();
		expect(persisted().votes).toHaveLength(0);
	});

	test('inserts every requested choice for a multiple-choice poll', async () => {
		const { service, note, me, pollsRepository, pollVotesRepository, persisted } = createService();

		await service.vote(note.id, [0, 1], me as never);

		expect(pollVotesRepository.insert).toHaveBeenCalledWith([
			expect.objectContaining({ choice: 0 }),
			expect.objectContaining({ choice: 1 }),
		]);
		expect(pollsRepository.query).toHaveBeenCalledWith(
			expect.stringContaining('votes[$1]'),
			[1, note.id],
		);
		expect(pollsRepository.query).toHaveBeenCalledWith(
			expect.stringContaining('votes[$1]'),
			[2, note.id],
		);
		expect(persisted().votes.map(vote => vote.choice)).toEqual([0, 1]);
		expect(persisted().poll.votes).toEqual([1, 1, 0]);
	});

	test('deduplicates repeated choices before inserting or publishing', async () => {
		const { service, note, me, pollVotesRepository, globalEventService, persisted } = createService();

		await service.vote(note.id, [1, 1, 1], me as never);

		expect(pollVotesRepository.insert).toHaveBeenCalledWith([
			expect.objectContaining({ choice: 1 }),
		]);
		expect(globalEventService.publishNoteStream).toHaveBeenCalledTimes(1);
		expect(persisted().votes.map(vote => vote.choice)).toEqual([1]);
	});

	test('rejects the complete request when one requested choice was already voted', async () => {
		const { service, note, me, pollVotesRepository, persisted } = createService({ existingChoices: [1] });

		await expect(service.vote(note.id, [0, 1], me as never)).rejects.toMatchObject({ code: 'ALREADY_VOTED' });

		expect(pollVotesRepository.insert).not.toHaveBeenCalled();
		expect(persisted().votes.map(vote => vote.choice)).toEqual([1]);
	});

	test('allows a new choice on a multiple-choice poll after a different existing vote', async () => {
		const { service, note, me, persisted } = createService({ existingChoices: [2] });

		await service.vote(note.id, [0, 1], me as never);

		expect(persisted().votes.map(vote => vote.choice)).toEqual([2, 0, 1]);
	});

	test('rejects any additional vote on a single-choice poll', async () => {
		const { service, note, me, pollVotesRepository } = createService({ multiple: false, existingChoices: [2] });

		await expect(service.vote(note.id, [0], me as never)).rejects.toMatchObject({ code: 'ALREADY_VOTED' });

		expect(pollVotesRepository.insert).not.toHaveBeenCalled();
	});

	test('rejects an expired poll without inserting', async () => {
		const { service, note, me, pollVotesRepository } = createService({ expiresAt: new Date(Date.now() - 1000) });

		await expect(service.vote(note.id, [0], me as never)).rejects.toMatchObject({ code: 'ALREADY_EXPIRED' });

		expect(pollVotesRepository.insert).not.toHaveBeenCalled();
	});

	test('rejects a voter blocked by the poll author before starting a transaction', async () => {
		const { service, note, me, pollVotesRepository } = createService({ blocked: true });

		await expect(service.vote(note.id, [0], me as never)).rejects.toMatchObject({ code: 'YOU_HAVE_BEEN_BLOCKED' });

		expect(pollVotesRepository.manager.transaction).not.toHaveBeenCalled();
		expect(pollVotesRepository.insert).not.toHaveBeenCalled();
	});

	test('preserves the native no-such-note error', async () => {
		const { service, note, me, pollVotesRepository } = createService({ noteMissing: true });

		await expect(service.vote(note.id, [0], me as never)).rejects.toMatchObject({
			code: 'NO_SUCH_NOTE',
			id: 'ecafbd2e-c283-4d6d-aecb-1a0a33b75396',
		});
		expect(pollVotesRepository.manager.transaction).not.toHaveBeenCalled();
	});

	test('preserves the native no-poll error', async () => {
		const { service, note, me, pollVotesRepository } = createService({ hasPoll: false });

		await expect(service.vote(note.id, [0], me as never)).rejects.toMatchObject({
			code: 'NO_POLL',
			id: '5f979967-52d9-4314-a911-1c673727f92f',
		});
		expect(pollVotesRepository.manager.transaction).not.toHaveBeenCalled();
	});

	test.each([
		['an insert failure', 'insert'],
		['the first counter update failing', 'firstUpdate'],
		['a later counter update failing', 'secondUpdate'],
	] as const)('rolls back all vote rows and counters when %s', async (_label, failurePoint) => {
		const { service, note, me, globalEventService, queueService, pollService, persisted } = createService({ failurePoint });

		await expect(service.vote(note.id, [0, 1], me as never)).rejects.toThrow(/forced (?:insert|update) failure/);

		expect(persisted().votes).toHaveLength(0);
		expect(persisted().poll.votes).toEqual([0, 0, 0]);
		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(queueService.deliver).not.toHaveBeenCalled();
		expect(pollService.deliverQuestionUpdate).not.toHaveBeenCalled();
	});

	test('locks before re-reading poll and votes, then runs every side effect after commit', async () => {
		const {
			service,
			note,
			me,
			pollsRepository,
			globalEventService,
			queueService,
			pollService,
			order,
		} = createService({ remote: true });

		await service.vote(note.id, [0, 2], me as never);

		expect(pollsRepository.query).toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_xact_lock(hashtextextended($1, 0))'),
			[JSON.stringify([note.id, me.id])],
		);
		const lockKey = pollsRepository.query.mock.calls.find(([sql]) => sql.includes('pg_advisory_xact_lock'))?.[1][0];
		expect(lockKey).not.toContain('\0');
		expect(order.indexOf('lock')).toBeLessThan(order.indexOf('poll:read'));
		expect(order.indexOf('lock')).toBeLessThan(order.indexOf('votes:read'));
		expect(order.indexOf('commit')).toBeLessThan(order.indexOf('event'));
		expect(order.indexOf('commit')).toBeLessThan(order.indexOf('deliver'));
		expect(order.indexOf('commit')).toBeLessThan(order.indexOf('question:update'));
		expect(globalEventService.publishNoteStream).toHaveBeenCalledTimes(2);
		expect(queueService.deliver).toHaveBeenCalledTimes(2);
		expect(pollService.deliverQuestionUpdate).toHaveBeenCalledTimes(1);
	});
});
