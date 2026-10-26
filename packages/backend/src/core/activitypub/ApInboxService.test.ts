/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { StatusError } from '@/misc/status-error.js';
import { NOTE_HISTORY_LIMIT_ERROR_ID, NOTE_NO_CONTENT_ERROR_ID, NOTE_NOT_FOUND_ERROR_ID } from '@/core/NoteUpdateService.js';
import { ApInboxService } from './ApInboxService.js';

describe(ApInboxService, () => {
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

	function createPostUpdate(object: Record<string, unknown>, updateNote: ReturnType<typeof vi.fn>) {
		const service = Object.create(ApInboxService.prototype) as ApInboxService;
		Object.assign(service, {
			apResolverService: {
				createResolver: vi.fn().mockResolvedValue({
					resolve: vi.fn().mockResolvedValue(object),
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
