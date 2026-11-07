/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MiUser } from '@/models/User.js';
import { MiUserNotePining } from '@/models/UserNotePining.js';
import { ApPersonService } from './ApPersonService.js';

function createService(noteIds = ['first', 'second']) {
	const user = { id: 'remote-user', uri: 'https://remote.example/users/alice', featured: 'https://remote.example/featured' };
	const manager = {
		findOneOrFail: vi.fn().mockResolvedValue(user),
		delete: vi.fn().mockResolvedValue(undefined),
		insert: vi.fn().mockResolvedValue(undefined),
	};
	const committed = vi.fn();
	const rolledBack = vi.fn();
	const transaction = vi.fn(async (work: (value: typeof manager) => Promise<void>) => {
		try {
			await work(manager);
			committed();
		} catch (error) {
			rolledBack(error);
			throw error;
		}
	});
	const resolver = {
		resolveCollection: vi.fn().mockResolvedValue({
			type: 'OrderedCollection',
			orderedItems: noteIds.map(id => ({ type: 'Note', id })),
		}),
		resolve: vi.fn(async (object: unknown) => object),
	};
	const service = Object.create(ApPersonService.prototype) as ApPersonService;
	Object.assign(service, {
		usersRepository: { findOneByOrFail: vi.fn().mockResolvedValue(user) },
		userEntityService: { isRemoteUser: () => true },
		logger: { info: vi.fn() },
		apResolverService: { createResolver: vi.fn().mockResolvedValue(resolver) },
		apNoteService: { resolveNote: vi.fn(async (note: { id: string }) => note) },
		idService: { gen: vi.fn((time: number) => String(time)) },
		db: { transaction },
	});
	return { service, manager, user, committed, rolledBack };
}

describe('remote featured notes', () => {
	test('preserves order and stores each resolved note only once', async () => {
		const { service, manager } = createService(['first', 'first', 'second']);
		let time = 10_000;
		vi.spyOn(Date, 'now').mockImplementation(() => time += 2000);
		await service.updateFeatured('remote-user');

		expect(manager.insert.mock.calls.map(call => call[1].noteId)).toEqual(['first', 'second']);
		expect(Number(manager.insert.mock.calls[1][1].id)).toBeLessThan(Number(manager.insert.mock.calls[0][1].id));
		expect(manager.insert).toHaveBeenCalledWith(MiUserNotePining, expect.objectContaining({ userId: 'remote-user' }));
	});

	test('waits for the cross-worker user lock before replacing pins', async () => {
		const { service, manager, user, committed } = createService();
		const locked = Promise.withResolvers<unknown>();
		manager.findOneOrFail.mockReturnValueOnce(locked.promise);
		const pending = service.updateFeatured(user.id);
		await vi.waitFor(() => expect(manager.findOneOrFail).toHaveBeenCalledWith(MiUser, {
			where: { id: user.id, isDeleted: false }, lock: { mode: 'pessimistic_write' },
		}));
		expect(manager.delete).not.toHaveBeenCalled();
		expect(committed).not.toHaveBeenCalled();
		locked.resolve(user);
		await pending;
	});

	test('does not commit or start the next insertion while an insertion is pending', async () => {
		const { service, manager, committed } = createService();
		const inserted = Promise.withResolvers<void>();
		manager.insert.mockReturnValueOnce(inserted.promise);
		const pending = service.updateFeatured('remote-user');
		await vi.waitFor(() => expect(manager.insert).toHaveBeenCalledTimes(1));
		expect(committed).not.toHaveBeenCalled();
		inserted.resolve();
		await pending;
		expect(manager.insert).toHaveBeenCalledTimes(2);
		expect(committed).toHaveBeenCalledOnce();
	});

	test('propagates an insertion failure through the transaction and stops subsequent writes', async () => {
		const { service, manager, committed, rolledBack } = createService();
		const error = new Error('insert failed');
		manager.insert.mockRejectedValueOnce(error);

		await expect(service.updateFeatured('remote-user')).rejects.toBe(error);
		expect(manager.insert).toHaveBeenCalledTimes(1);
		expect(committed).not.toHaveBeenCalled();
		expect(rolledBack).toHaveBeenCalledWith(error);
	});
});
