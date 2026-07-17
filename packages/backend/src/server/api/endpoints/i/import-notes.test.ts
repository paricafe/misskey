/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import ImportNotesEndpoint, { meta } from './import-notes.js';

const me = { id: 'user-id' } as MiLocalUser;

function createEndpoint(file: { id: string; size: number } | null) {
	const driveFilesRepository = {
		findOneBy: vi.fn().mockResolvedValue(file),
	};
	const queueService = {
		createImportNotesJob: vi.fn(),
	};
	const roleService = {
		getUserPolicies: vi.fn().mockResolvedValue({ canImportNotes: true }),
	};
	const endpoint = new ImportNotesEndpoint(
		driveFilesRepository as never,
		queueService as never,
		roleService as never,
	);

	return { endpoint, driveFilesRepository, queueService };
}

describe('api:i/import-notes', () => {
	test('only imports a drive file owned by the requesting user', async () => {
		const { endpoint, driveFilesRepository, queueService } = createEndpoint({ id: 'fileid1234567890', size: 1 });

		await endpoint.exec({ fileId: 'fileid1234567890', type: 'Mastodon' }, me, null);

		expect(driveFilesRepository.findOneBy).toHaveBeenCalledWith({ id: 'fileid1234567890', userId: me.id });
		expect(queueService.createImportNotesJob).toHaveBeenCalledWith(me, 'fileid1234567890', 'Mastodon');
	});

	test('returns the public no-such-file error when the owned file is unavailable', async () => {
		const { endpoint } = createEndpoint(null);

		await expect(endpoint.exec({ fileId: 'fileid1234567890' }, me, null)).rejects.toMatchObject({
			code: meta.errors.noSuchFile.code,
			id: meta.errors.noSuchFile.id,
		});
	});
});
