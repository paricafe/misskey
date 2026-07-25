/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
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
});
