/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { StatusError } from '@/misc/status-error.js';
import { NOTE_HISTORY_LIMIT_ERROR_ID, NOTE_NO_CONTENT_ERROR_ID, NOTE_NOT_FOUND_ERROR_ID } from '@/core/NoteUpdateService.js';
import { ApInboxService } from './ApInboxService.js';
import { ApDbResolverService } from './ApDbResolverService.js';
import type { MiRemoteUser } from '@/models/User.js';

describe(ApInboxService, () => {
	test('keeps a successful activity independent of a rejected background actor refresh', async () => {
		const refresh = Promise.withResolvers<void>();
		const updatePerson = vi.fn().mockReturnValue(refresh.promise);
		const warn = vi.fn();
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, { apPersonService: { updatePerson }, logger: { warn } });
		Object.defineProperty(service, 'performOneActivity', { value: vi.fn().mockResolvedValue('ok') });
		const actor = { uri: 'https://remote.example/users/alice', lastFetchedAt: null } as MiRemoteUser;

		await expect(service.performActivity(actor, { type: 'Create' })).resolves.toBe('ok');
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(updatePerson).toHaveBeenCalledWith(actor.uri);

		refresh.reject(new StatusError('410 Gone', 410));
		await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('410')));
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test('rejects a Post update whose attributed author differs from the signed activity actor', async () => {
		const apNoteService = {
			updateNote: vi.fn(),
		};
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			apResolverService: {
				createResolver: vi.fn().mockResolvedValue({
					resolve: vi.fn().mockResolvedValue({
						id: 'https://remote.example/notes/1',
						type: 'Note',
						attributedTo: 'https://remote.example/users/bob',
						updated: '2025-02-01T00:00:00.000Z',
						content: '<p>edited</p>',
					}),
				}),
			},
			apNoteService,
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
			},
		});

		const result = await (service as unknown as {
			update: (
				actor: { uri: string },
				activity: { actor: string; object: string },
			) => Promise<string>;
		}).update(
			{ uri: 'https://remote.example/users/alice' },
			{
				actor: 'https://remote.example/users/alice',
				object: 'https://remote.example/notes/1',
			},
		);

		expect(result).toBe('skip: actor does not match object author');
		expect(apNoteService.updateNote).not.toHaveBeenCalled();
	});

	test('dispatches a Post update when the canonical object author matches the signed activity actor', async () => {
		const object = {
			id: 'https://remote.example/notes/1',
			type: 'Note',
			attributedTo: 'https://remote.example/users/alice',
			updated: '2025-02-01T00:00:00.000Z',
			content: '<p>edited</p>',
		};
		const apNoteService = {
			updateNote: vi.fn(),
		};
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			apResolverService: {
				createResolver: vi.fn().mockResolvedValue({
					resolve: vi.fn().mockResolvedValue(object),
				}),
			},
			apNoteService,
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
			},
		});

		const result = await (service as unknown as {
			update: (
				actor: { uri: string },
				activity: { actor: string; object: string },
			) => Promise<string>;
		}).update(
			{ uri: 'https://remote.example/users/alice' },
			{
				actor: 'https://remote.example/users/alice',
				object: 'https://remote.example/notes/1',
			},
		);

		expect(result).toBe('ok: Post updated');
		expect(apNoteService.updateNote).toHaveBeenCalledWith(object, expect.anything());
	});

	test('rejects a Question update whose attributed author differs from the signed activity actor', async () => {
		const apQuestionService = {
			updateQuestion: vi.fn().mockResolvedValue(undefined),
		};
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			apResolverService: {
				createResolver: vi.fn().mockResolvedValue({
					resolve: vi.fn().mockResolvedValue({
						id: 'https://remote.example/notes/poll',
						type: 'Question',
						attributedTo: 'https://remote.example/users/bob',
						updated: '2025-02-01T00:00:00.000Z',
					}),
				}),
			},
			apQuestionService,
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
			},
		});

		const result = await (service as unknown as {
			update: (
				actor: { uri: string },
				activity: { actor: string; object: string },
			) => Promise<string>;
		}).update(
			{ uri: 'https://remote.example/users/alice' },
			{
				actor: 'https://remote.example/users/alice',
				object: 'https://remote.example/notes/poll',
			},
		);

		expect(result).toBe('skip: actor does not match object author');
		expect(apQuestionService.updateQuestion).not.toHaveBeenCalled();
	});

	function createPostUpdate(object: Record<string, unknown>, updateNote: ReturnType<typeof vi.fn>, resolve = vi.fn().mockResolvedValue(object)) {
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			apResolverService: {
				createResolver: vi.fn().mockResolvedValue({
					resolve,
				}),
			},
			apNoteService: { updateNote },
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
			},
		});

		return () => (service as unknown as {
			update: (
				actor: { uri: string },
				activity: { actor: string; object: string },
			) => Promise<string>;
		}).update(
			{ uri: 'https://remote.example/users/alice' },
			{
				actor: 'https://remote.example/users/alice',
				object: 'https://remote.example/notes/1',
			},
		);
	}

	const post = {
		id: 'https://remote.example/notes/1',
		type: 'Note',
		attributedTo: 'https://remote.example/users/alice',
		updated: '2025-02-01T00:00:00.000Z',
		content: '<p>edited</p>',
	};

	test.each([404, 410])('skips an Update whose object URI resolves to HTTP %s', async (status) => {
		const updateNote = vi.fn();
		const resolve = vi.fn().mockRejectedValue(new StatusError('Not available', status));

		await expect(createPostUpdate(post, updateNote, resolve)()).resolves.toBe(`skip: ${status}`);
		expect(resolve).toHaveBeenCalledWith(post.id);
		expect(updateNote).not.toHaveBeenCalled();
	});

	test.each([
		['HTTP 429', new StatusError('Too Many Requests', 429)],
		['HTTP 503', new StatusError('Service Unavailable', 503)],
		['an unknown error', new Error('connection failed')],
	])('keeps an Update retryable when object resolution fails with %s', async (_label, error) => {
		const updateNote = vi.fn();
		const resolve = vi.fn().mockRejectedValue(error);

		await expect(createPostUpdate(post, updateNote, resolve)()).rejects.toBe(error);
		expect(updateNote).not.toHaveBeenCalled();
	});

	test('skips a Post update whose attributedTo has no author id', async () => {
		const updateNote = vi.fn();

		await expect(createPostUpdate({ ...post, attributedTo: [] }, updateNote)()).resolves.toBe('skip: actor does not match object author');
		expect(updateNote).not.toHaveBeenCalled();
	});

	test('returns the skip reason of a Post update that applies to no stored note', async () => {
		const updateNote = vi.fn().mockResolvedValue('skip: note is not registered');

		await expect(createPostUpdate(post, updateNote)()).resolves.toBe('skip: note is not registered');
	});

	test.each([
		NOTE_NOT_FOUND_ERROR_ID,
		NOTE_NO_CONTENT_ERROR_ID,
		NOTE_HISTORY_LIMIT_ERROR_ID,
	])('skips a Post update rejected with the permanent edit error %s', async (id) => {
		const updateNote = vi.fn().mockRejectedValue(new IdentifiableError(id, 'cannot apply'));

		await expect(createPostUpdate(post, updateNote)()).resolves.toBe('skip: cannot apply');
	});

	test('skips a Post update whose author cannot be fetched permanently', async () => {
		const updateNote = vi.fn().mockRejectedValue(new StatusError('Gone', 410));

		await expect(createPostUpdate(post, updateNote)()).resolves.toBe('skip: 410');
	});

	test.each([
		['a retryable HTTP error', new StatusError('Too Many Requests', 429)],
		['an unknown error', new Error('database is unavailable')],
	])('keeps a Post update retryable after %s', async (_label, error) => {
		const updateNote = vi.fn().mockRejectedValue(error);

		await expect(createPostUpdate(post, updateNote)()).rejects.toBe(error);
	});
});

describe('remote account deletion recovery', () => {
	function createDeletionService() {
		let exists = true;
		let isDeleted = false;
		const update = vi.fn(async (where: { id: string; isDeleted?: boolean }) => {
			if (!exists || (where.isDeleted != null && where.isDeleted !== isDeleted)) return { affected: 0 };
			isDeleted = true;
			return { affected: 1 };
		});
		const createDeleteAccountJob = vi.fn().mockResolvedValue({ name: 'deleteAccount', id: 'job' });
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			logger: { info: vi.fn() },
			usersRepository: { update, existsBy: vi.fn(async () => exists) },
			queueService: { createDeleteAccountJob },
			globalEventService: { publishInternalEvent: vi.fn() },
		});
		const actor = { id: 'remote-user', uri: 'https://remote.example/users/alice' };
		const remove = () => (service as unknown as { deleteActor(actor: unknown, uri: string): Promise<string> }).deleteActor(actor, actor.uri);
		return { remove, createDeleteAccountJob, actor, deleted: () => isDeleted, finish: () => { exists = false; } };
	}

	test('keeps the actor authenticatable when enqueue fails and retries deletion', async () => {
		const { remove, createDeleteAccountJob, actor, deleted } = createDeletionService();
		const resolver = Object.create(ApDbResolverService.prototype) as ApDbResolverService;
		Object.assign(resolver, {
			publicKeyCache: { fetch: vi.fn().mockResolvedValue({ userId: actor.id, keyPem: 'public-key' }) },
			cacheService: { findUserById: vi.fn(async () => ({ ...actor, isDeleted: deleted() })) },
		});
		createDeleteAccountJob.mockRejectedValueOnce(new Error('Redis unavailable'));
		await expect(remove()).rejects.toThrow('Redis unavailable');
		expect(deleted()).toBe(false);
		await expect(resolver.getAuthUserFromKeyId(`${actor.uri}#key`)).resolves.toMatchObject({ user: { id: actor.id } });
		await expect(remove()).resolves.toBe('ok: queued deleteAccount job');
		expect(deleted()).toBe(true);
		await expect(resolver.getAuthUserFromKeyId(`${actor.uri}#key`)).resolves.toBeNull();
		expect(createDeleteAccountJob).toHaveBeenCalledTimes(2);
	});

	test('does not recreate work once the account was physically deleted', async () => {
		const { remove, createDeleteAccountJob, finish } = createDeletionService();
		finish();
		await expect(remove()).resolves.toBe('skip: actor not found');
		expect(createDeleteAccountJob).not.toHaveBeenCalled();
	});
});

describe('announce target retry classification', () => {
	function createAnnounceService(error: Error) {
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			relayService: { isRelayActor: vi.fn().mockResolvedValue(false) },
			utilityService: { isFederationAllowedUri: () => true },
			redisClient: { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn().mockResolvedValue(1) },
			apNoteService: { fetchNote: vi.fn().mockResolvedValue(null), resolveNote: vi.fn().mockRejectedValue(error) },
		});
		return () => (service as unknown as { announceNote(actor: unknown, activity: unknown, target: unknown): Promise<string> }).announceNote(
			{ id: 'actor', uri: 'https://remote.example/users/alice' },
			{ id: 'https://remote.example/activities/1' },
			{ id: 'https://target.example/notes/1' },
		);
	}

	test.each([429, 503])('preserves retryable target HTTP %s failures', async (status) => {
		const error = new StatusError('Temporary failure', status);
		await expect(createAnnounceService(error)()).rejects.toBe(error);
	});

	test.each([404, 410])('skips permanently unavailable target HTTP %s', async (status) => {
		await expect(createAnnounceService(new StatusError('Gone', status))()).resolves.toContain(`- ${status}`);
	});
});
