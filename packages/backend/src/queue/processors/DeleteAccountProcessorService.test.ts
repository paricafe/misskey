/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MemoryKVCache } from '@/misc/cache.js';
import { CacheService } from '@/core/CacheService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { DeleteAccountProcessorService } from './DeleteAccountProcessorService.js';

function createService() {
	const user = { id: 'old-user', uri: 'https://remote.example/users/alice', host: 'remote.example', isDeleted: true };
	let storedUser: typeof user | null = user;
	const usersRepository = {
		findOneBy: vi.fn(async () => storedUser),
		delete: vi.fn(async () => { storedUser = null; }),
	};
	const publishInternalEvent = vi.fn();
	const service = Object.create(DeleteAccountProcessorService.prototype) as DeleteAccountProcessorService;
	Object.assign(service, {
		logger: { info: vi.fn(), succ: vi.fn() },
		usersRepository,
		notesRepository: { find: vi.fn().mockResolvedValue([]) },
		noteReactionsRepository: { find: vi.fn().mockResolvedValue([]) },
		driveFilesRepository: { find: vi.fn().mockResolvedValue([]) },
		pagesRepository: { find: vi.fn().mockResolvedValue([]) },
		userProfilesRepository: { findOneByOrFail: vi.fn().mockResolvedValue({ email: null }) },
		globalEventService: { publishInternalEvent },
	});
	return { user, usersRepository, publishInternalEvent, service };
}

describe('completed account deletion', () => {
	test('invalidates the cached actor after removing its database row', async () => {
		const { user, usersRepository, publishInternalEvent, service } = createService();
		const userByIdCache = new MemoryKVCache<typeof user>(300_000);
		const localUserByIdCache = new MemoryKVCache<typeof user>(300_000);
		const uriPersonCache = new MemoryKVCache<typeof user>(300_000);
		userByIdCache.set(user.id, user);
		uriPersonCache.set(user.uri, user);
		const cache = Object.create(CacheService.prototype) as CacheService;
		Object.assign(cache, { usersRepository, userByIdCache, localUserByIdCache, uriPersonCache });
		let invalidation: Promise<void> | undefined;
		publishInternalEvent.mockImplementation((type, body) => {
			invalidation = (cache as unknown as { onMessage(channel: string, data: string): Promise<void> }).onMessage('', JSON.stringify({ channel: 'internal', message: { type, body } }));
		});
		try {
			await service.process({ data: { user: { id: user.id } } } as never);
			await invalidation;
			expect(userByIdCache.get(user.id)).toBeUndefined();
			expect(uriPersonCache.get(user.uri)).toBeUndefined();
			const apPerson = Object.create(ApPersonService.prototype) as ApPersonService;
			Object.assign(apPerson, { config: { url: 'https://local.example' }, cacheService: cache, usersRepository });
			const restored = { ...user, id: 'new-user', isDeleted: false };
			Object.defineProperty(apPerson, 'createPerson', { value: vi.fn().mockResolvedValue(restored) });
			await expect(apPerson.resolvePerson(user.uri, {} as never)).resolves.toBe(restored);
		} finally {
			userByIdCache.dispose();
			localUserByIdCache.dispose();
			uriPersonCache.dispose();
		}
	});

	test('does not publish completion when deleting the database row fails', async () => {
		const { user, usersRepository, publishInternalEvent, service } = createService();
		usersRepository.delete.mockRejectedValue(new Error('database unavailable'));
		await expect(service.process({ data: { user: { id: user.id } } } as never)).rejects.toThrow('database unavailable');
		expect(publishInternalEvent).not.toHaveBeenCalled();
	});
});
