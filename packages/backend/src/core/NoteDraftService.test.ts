/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteDraftService } from './NoteDraftService.js';
import { QueueService } from './QueueService.js';

describe(NoteDraftService, () => {
	function createService() {
		const drafts = { countBy: vi.fn().mockResolvedValue(0), insertOne: vi.fn(async (draft) => draft), createQueryBuilder: vi.fn() };
		const queue = { getJob: vi.fn().mockResolvedValue(null), add: vi.fn().mockResolvedValue({}) };
		const logger = { error: vi.fn() };
		const service = new NoteDraftService(null as never, drafts as never, null as never, null as never, null as never, null as never,
			{ getUserPolicies: vi.fn().mockResolvedValue({ noteDraftLimit: 20, scheduledNoteLimit: 10 }) } as never,
			{ gen: () => 'draft' } as never, null as never, { postScheduledNoteQueue: queue } as never, { getLogger: () => logger } as never);
		const draft = { id: 'draft', scheduledAt: new Date(Date.now() + 60_000), scheduleRevision: 2, isActuallyScheduled: true };
		return { service, drafts, queue, draft, logger };
	}

	test('does not acknowledge scheduling before Redis accepts the job', async () => {
		const { service, queue, draft } = createService();
		let accept!: () => void;
		queue.add.mockImplementation(() => new Promise(resolve => { accept = () => resolve({}); }));
		const completed = vi.fn();
		const scheduling = service.schedule(draft).then(completed);
		await vi.waitFor(() => expect(queue.add).toHaveBeenCalledOnce());
		expect(completed).not.toHaveBeenCalled();
		accept();
		await scheduling;
		expect(completed).toHaveBeenCalledOnce();
	});

	test('accepts one persisted schedule when enqueue fails and recovers that same draft later', async () => {
		const { service, drafts, queue, draft, logger } = createService();
		vi.spyOn(service, 'validate').mockResolvedValue();
		queue.add.mockRejectedValueOnce(new Error('Redis unavailable'));
		const accepted = await service.create({ id: 'author' } as never, draft as never);
		expect(accepted).toMatchObject({ id: 'draft', isActuallyScheduled: true, scheduleRevision: 1 });
		expect(drafts.insertOne).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft', isActuallyScheduled: true, scheduleRevision: 1 }));
		expect(logger.error).toHaveBeenCalledWith({ message: expect.stringContaining('schedule recovery'), error: expect.any(Error) });
		const page = { where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), addOrderBy: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValueOnce([accepted]).mockResolvedValueOnce([]) };
		drafts.createQueryBuilder.mockReturnValue(page);
		await service.recoverSchedules();
		expect(queue.add).toHaveBeenLastCalledWith('draft', { noteDraftId: 'draft', scheduleRevision: 1 }, expect.objectContaining({ jobId: 'draft-1' }));
		expect(drafts.insertOne).toHaveBeenCalledOnce();
	});

	test('propagates an enqueue failure to the recovery worker', async () => {
		const { service, queue, draft } = createService();
		queue.add.mockRejectedValue(new Error('Redis unavailable'));
		await expect(service.schedule(draft)).rejects.toThrow('Redis unavailable');
	});

	test('uses a stable versioned job ID and immediately enqueues overdue drafts', async () => {
		const { service, queue, draft } = createService();
		draft.scheduledAt = new Date(1);
		await service.schedule(draft);
		expect(queue.add).toHaveBeenCalledWith('draft', { noteDraftId: 'draft', scheduleRevision: 2 }, expect.objectContaining({ jobId: 'draft-2', delay: 0, attempts: 5 }));
	});

	test('retries a failed job and leaves an active job alone', async () => {
		const { service, queue, draft } = createService();
		const retry = vi.fn();
		queue.getJob.mockResolvedValue({ getState: async () => 'failed', retry });
		await service.schedule(draft);
		expect(retry).toHaveBeenCalledWith('failed');
		queue.getJob.mockResolvedValue({ getState: async () => 'active', retry });
		await service.schedule(draft);
		expect(retry).toHaveBeenCalledOnce();
		expect(queue.add).not.toHaveBeenCalled();
	});

	test('does not try to remove an active superseded job', async () => {
		const { service, queue } = createService();
		const remove = vi.fn();
		queue.getJob.mockResolvedValue({ isActive: async () => true, remove });
		await service.clearSchedule('draft', 2);
		expect(remove).not.toHaveBeenCalled();
	});

	test('recovers persisted schedules in bounded pages with a stable cursor', async () => {
		const { service, drafts, draft } = createService();
		const page = { where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), addOrderBy: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValueOnce([draft]).mockResolvedValueOnce([]) };
		drafts.createQueryBuilder.mockReturnValue(page);
		const schedule = vi.spyOn(service, 'schedule').mockResolvedValue();
		await service.recoverSchedules();
		expect(page.take).toHaveBeenCalledWith(100);
		expect(page.andWhere).toHaveBeenCalledWith('(draft."scheduledAt", draft.id) > (:scheduledAt, :id)', { scheduledAt: draft.scheduledAt, id: draft.id });
		expect(schedule).toHaveBeenCalledWith(draft);
	});

	test('bounds the amount of work in one recovery sweep', async () => {
		const { service, drafts, draft } = createService();
		const page = { where: vi.fn().mockReturnThis(), andWhere: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), addOrderBy: vi.fn().mockReturnThis(), take: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValue([draft]) };
		drafts.createQueryBuilder.mockReturnValue(page);
		vi.spyOn(service, 'schedule').mockResolvedValue();
		await service.recoverSchedules();
		expect(page.getMany).toHaveBeenCalledTimes(10);
	});

	test('does not complete module startup before recovery registration succeeds', async () => {
		const service = Object.create(QueueService.prototype) as QueueService;
		let register!: () => void;
		const upsert = vi.fn(() => new Promise<void>(resolve => { register = resolve; }));
		Object.assign(service, { systemQueue: { upsertJobScheduler: upsert } });
		const completed = vi.fn();
		const starting = service.onModuleInit().then(completed);
		expect(upsert).toHaveBeenCalledWith('recoverScheduledNotes', { pattern: '* * * * *', immediately: true }, expect.objectContaining({ opts: expect.objectContaining({ attempts: 5 }) }));
		expect(completed).not.toHaveBeenCalled();
		register();
		await starting;
		expect(completed).toHaveBeenCalledOnce();
	});

	test('fails module startup if recovery registration fails', async () => {
		const service = Object.create(QueueService.prototype) as QueueService;
		Object.assign(service, { systemQueue: { upsertJobScheduler: vi.fn().mockRejectedValue(new Error('Registration failed')) } });
		await expect(service.onModuleInit()).rejects.toThrow('Registration failed');
	});
});
