/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ExportAccountDataProcessorService } from './ExportAccountDataProcessorService.js';

function setup(
	addFile: () => Promise<unknown>,
	profile: Record<string, unknown> = { email: 'alice@example.com', emailVerified: true },
	mutings: { id: string, muteeId: string }[] = [],
	otherUsers: Record<string, { username: string, host: string | null }> = {},
) {
	const user = { id: 'user', username: 'alice', host: null, token: 'native-token' };
	const emptyRepository = {
		find: vi.fn().mockResolvedValue([]),
		findBy: vi.fn().mockResolvedValue([]),
	};
	const mutingsRepository = {
		find: vi.fn().mockResolvedValueOnce(mutings).mockResolvedValue([]),
		findBy: vi.fn().mockResolvedValue([]),
	};
	const logger = { info: vi.fn(), succ: vi.fn(), error: vi.fn() };
	const driveService = { addFile: vi.fn(addFile) };
	const driveFilesRepository = { findBy: vi.fn().mockResolvedValue([]) };
	const downloadService = { downloadUrl: vi.fn(async (url: string, path: string) => fs.promises.writeFile(path, url)) };
	const emailService = { sendEmail: vi.fn() };
	const service = new ExportAccountDataProcessorService(
		{ host: 'local.example' } as never,
		{ findOneBy: vi.fn(({ id }: { id: string }) => Promise.resolve(id === user.id ? user : otherUsers[id] ?? null)) } as never,
		{ findOneBy: vi.fn().mockResolvedValue({ userId: user.id, ...profile }) } as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		mutingsRepository as never,
		emptyRepository as never,
		driveFilesRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		{ getFullApAccount: (username: string, host: string | null) => `${username}@${host ?? 'local.example'}` } as never,
		driveService as never,
		{} as never,
		{} as never,
		downloadService as never,
		emailService as never,
		{ logger: { createSubLogger: () => logger } } as never,
	);
	const tempDir = () => {
		const message = logger.info.mock.calls.map(([text]) => String(text)).find(text => text.startsWith('Temp dir is '));
		return message?.slice('Temp dir is '.length);
	};
	return { service, driveService, emailService, tempDir, driveFilesRepository, downloadService };
}

describe('ExportAccountDataProcessorService archive delivery', () => {
	beforeEach(() => {
		vi.stubEnv('NODE_ENV', 'production');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test('rejects and removes temporary files when storing the archive fails', async () => {
		const { service, emailService, tempDir } = setup(() => Promise.reject(new Error('drive unavailable')));

		await expect(service.process({ data: { user: { id: 'user' } } } as never)).rejects.toThrow('drive unavailable');

		expect(emailService.sendEmail).not.toHaveBeenCalled();
		expect(tempDir()).toBeDefined();
		await vi.waitFor(() => expect(fs.existsSync(tempDir()!)).toBe(false));
	});

	test('stores the archive and notifies the user', async () => {
		const { service, driveService, emailService, tempDir } = setup(() => Promise.resolve({ id: 'file', url: 'https://files.example/archive.zip' }));

		await service.process({ data: { user: { id: 'user' } } } as never);

		expect(driveService.addFile).toHaveBeenCalledOnce();
		expect(driveService.addFile).toHaveBeenCalledWith(expect.objectContaining({ skipPolicyCheck: true }));
		expect(emailService.sendEmail).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(fs.existsSync(tempDir()!)).toBe(false));
	});

	test('does not email the archive link to an unverified address', async () => {
		const { service, driveService, emailService } = setup(
			() => Promise.resolve({ id: 'file', url: 'https://files.example/archive.zip' }),
			{ email: 'typo@example.com', emailVerified: false },
		);

		await service.process({ data: { user: { id: 'user' } } } as never);

		expect(driveService.addFile).toHaveBeenCalledOnce();
		expect(emailService.sendEmail).not.toHaveBeenCalled();
	});

	test('writes valid JSON when a muted user no longer exists', async () => {
		const exported: Record<string, unknown> = {};
		const { service, tempDir } = setup(async () => {
			const dir = tempDir()!;
			for (const name of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
				exported[name] = JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf-8'));
			}
			return { id: 'file', url: 'https://files.example/archive.zip' };
		}, undefined, [{ id: 'm1', muteeId: 'deleted' }, { id: 'm2', muteeId: 'bob' }], { bob: { username: 'bob', host: 'remote.example' } });

		await service.process({ data: { user: { id: 'user' } } } as never);

		expect(exported['mutings.json']).toMatchObject({ metaVersion: 1, host: 'local.example', mutings: ['bob@remote.example'] });
		expect(Object.keys(exported).sort()).toEqual(['antennas.json', 'blockings.json', 'drive.json', 'favorites.json', 'followers.json', 'followings.json', 'ips.json', 'mutings.json', 'notes.json', 'profile.json', 'user.json']);
	});

	test('exports distinct bytes for same-named files in different folders', async () => {
		let exported: Array<{ fileName: string; file: { id: string; name: string } }> = [];
		const contents = new Map<string, string>();
		const { service, tempDir, driveFilesRepository } = setup(async () => {
			const dir = tempDir()!;
			exported = JSON.parse(fs.readFileSync(`${dir}/drive.json`, 'utf8')).drive;
			for (const entry of exported) contents.set(entry.file.id, fs.readFileSync(`${dir}/files/${entry.fileName}`, 'utf8'));
			return { id: 'archive', url: 'https://files.example/archive.zip' };
		});
		driveFilesRepository.findBy.mockResolvedValue([
			{ id: 'first', name: 'photo.jpg', type: 'image/jpeg', folderId: 'folder-a', url: 'https://files.example/first' },
			{ id: 'second', name: 'photo.jpg', type: 'image/jpeg', folderId: 'folder-b', url: 'https://files.example/second' },
		] as never);
		await service.process({ data: { user: { id: 'user' } } } as never);
		expect(new Set(exported.map(entry => entry.fileName)).size).toBe(2);
		expect(exported.map(entry => entry.file.name)).toEqual(['photo.jpg', 'photo.jpg']);
		expect(contents.get('first')).toBe('https://files.example/first');
		expect(contents.get('second')).toBe('https://files.example/second');
	});
});
