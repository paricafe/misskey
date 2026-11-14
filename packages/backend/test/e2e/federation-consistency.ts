/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Queue, Worker } from 'bullmq';
import { loadConfig } from '@/config.js';
import { QueueService } from '@/core/QueueService.js';
import type { DataSource } from 'typeorm';
import type * as Misskey from 'misskey-js';
import { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import { MiPoll } from '@/models/Poll.js';
import { MiPollVote } from '@/models/PollVote.js';
import { MiInstance } from '@/models/Instance.js';
import { IdService } from '@/core/IdService.js';
import { PollVoteService } from '@/core/PollVoteService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { InboxProcessorService } from '@/queue/processors/InboxProcessorService.js';
import { initTestDb, post, signup } from '../utils.js';

describe('federation database consistency', () => {
	let db: DataSource;
	let owner: Misskey.entities.SignupResponse;
	let voter: MiUser;
	const idService = new IdService({ id: 'aidx' } as never);

	beforeAll(async () => {
		db = await initTestDb(true);
		owner = await signup({ username: 'consistency_owner' });
		const account = await signup({ username: 'consistency_voter' });
		await db.getRepository(MiUser).update(account.id, {
			host: 'remote.example',
			uri: 'https://remote.example/users/voter',
			inbox: 'https://remote.example/inbox',
		});
		voter = await db.getRepository(MiUser).findOneByOrFail({ id: account.id });
	});

	afterAll(async () => { await db?.destroy(); });

	test('serializes concurrent choices from the same remote actor on a single-choice poll', async () => {
		const note = await post(owner, { poll: { choices: ['A', 'B'], multiple: false } });
		const publishNoteStream = vi.fn();
		const service = new PollVoteService(
			db.getRepository(MiUser) as never,
			db.getRepository(MiNote) as never,
			db.getRepository(MiPollVote) as never,
			idService,
			{ deliver: vi.fn() } as never,
			{ deliverQuestionUpdate: vi.fn().mockResolvedValue(undefined) } as never,
			{} as never,
			{ publishNoteStream } as never,
			{ checkBlocked: vi.fn().mockResolvedValue(false) } as never,
			{ isVisibleForMe: vi.fn().mockResolvedValue(true) } as never,
		);

		const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => service.vote(note.id, [index % 2], voter)));
		expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
		for (const result of results) {
			if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'ALREADY_VOTED' });
		}
		const votes = await db.getRepository(MiPollVote).findBy({ noteId: note.id, userId: voter.id });
		const poll = await db.getRepository(MiPoll).findOneByOrFail({ noteId: note.id });
		expect(votes).toHaveLength(1);
		expect(poll.votes.reduce((total, count) => total + count, 0)).toBe(1);
		expect(poll.votes[votes[0].choice]).toBe(1);
		expect(publishNoteStream).toHaveBeenCalledOnce();
	});

	test.each([
		['autoSuspendedForNotResponding', 'none'],
		['manuallySuspended', 'manuallySuspended'],
		['goneSuspended', 'goneSuspended'],
		['none', 'none'],
	] as const)('applies a buffered auto-resume to current database state %s as %s', async (currentState, expectedState) => {
		const id = idService.gen();
		const instances = db.getRepository(MiInstance);
		await instances.insert({ id, host: `${id}.example`, firstRetrievedAt: new Date(), suspensionState: 'autoSuspendedForNotResponding' });
		const federatedInstanceService = Object.create(FederatedInstanceService.prototype) as FederatedInstanceService;
		const cacheSet = vi.fn();
		Object.assign(federatedInstanceService, { instancesRepository: instances, federatedInstanceCache: { set: cacheSet } });
		const inbox = Object.create(InboxProcessorService.prototype) as InboxProcessorService;
		Object.assign(inbox, { federatedInstanceService });
		const receivedAt = new Date(Date.now() - 1000);

		await instances.update(id, { suspensionState: currentState });
		await inbox.performUpdateInstance(id, { latestRequestReceivedAt: receivedAt, shouldUnsuspend: true });

		const instance = await instances.findOneByOrFail({ id });
		expect(instance.suspensionState).toBe(expectedState);
		expect(instance.latestRequestReceivedAt!.getTime()).toBeGreaterThanOrEqual(receivedAt.getTime());
		expect(cacheSet).toHaveBeenCalledWith(instance.host, expect.objectContaining({ suspensionState: expectedState }));
	});
});

describe('account deletion queue recovery', () => {
	test('deduplicates pending work while completed and failed retained jobs allow recovery', async () => {
		const options = { connection: { ...loadConfig().redisForJobQueue, keyPrefix: undefined }, prefix: `test-delete-${randomUUID()}` };
		const queue = new Queue('delete-account', options);
		const worker = new Worker('delete-account', async job => {
			if (job.data.user.id === 'failure') throw new Error('forced deletion failure');
		}, { ...options, autorun: false });
		const service = Object.create(QueueService.prototype) as QueueService;
		Object.assign(service, { dbQueue: queue });
		let running: Promise<void> | undefined;
		try {
			const original = await service.createDeleteAccountJob({ id: 'account' });
			const duplicate = await service.createDeleteAccountJob({ id: 'account' });
			expect(duplicate.id).toBe(original.id);
			running = worker.run();
			await vi.waitFor(async () => expect(await original.getState()).toBe('completed'), { timeout: 10_000 });
			await worker.pause();
			expect(await queue.getJob(original.id!)).toBeDefined();
			const recovered = await service.createDeleteAccountJob({ id: 'account' });
			expect(recovered.id).not.toBe(original.id);
			expect(await recovered.getState()).toBe('waiting');

			const failing = await service.createDeleteAccountJob({ id: 'failure' });
			worker.resume();
			await vi.waitFor(async () => expect(await failing.getState()).toBe('failed'), { timeout: 10_000 });
			await worker.pause();
			expect(await queue.getJob(failing.id!)).toBeDefined();
			const retried = await service.createDeleteAccountJob({ id: 'failure' });
			expect(retried.id).not.toBe(failing.id);
			expect(await retried.getState()).toBe('waiting');
		} finally {
			await worker.close();
			await running;
			await queue.obliterate({ force: true });
			await queue.close();
		}
	});
});
