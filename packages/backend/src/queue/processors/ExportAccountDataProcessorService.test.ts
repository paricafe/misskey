/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ExportAccountDataProcessorService } from './ExportAccountDataProcessorService.js';

function setup(addFile: () => Promise<unknown>, profile: Record<string, unknown> = { email: 'alice@example.com', emailVerified: true }) {
	const user = { id: 'user', username: 'alice', host: null, token: 'native-token' };
	const emptyRepository = {
		find: vi.fn().mockResolvedValue([]),
		findBy: vi.fn().mockResolvedValue([]),
	};
	const logger = { info: vi.fn(), succ: vi.fn(), error: vi.fn() };
	const driveService = { addFile: vi.fn(addFile) };
	const emailService = { sendEmail: vi.fn() };
	const service = new ExportAccountDataProcessorService(
		{ host: 'local.example' } as never,
		{ findOneBy: vi.fn().mockResolvedValue(user) } as never,
		{ findOneBy: vi.fn().mockResolvedValue({ userId: user.id, ...profile }) } as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		emptyRepository as never,
		{} as never,
		driveService as never,
		{} as never,
		{} as never,
		{} as never,
		emailService as never,
		{ logger: { createSubLogger: () => logger } } as never,
	);
	const tempDir = () => {
		const message = logger.info.mock.calls.map(([text]) => String(text)).find(text => text.startsWith('Temp dir is '));
		return message?.slice('Temp dir is '.length);
	};
	return { service, driveService, emailService, tempDir };
}

describe('ExportAccountDataProcessorService archive delivery', () => {
	// Temporary files are only removed in production.
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
		// Role upload policies must not reject the generated zip archive.
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
});
