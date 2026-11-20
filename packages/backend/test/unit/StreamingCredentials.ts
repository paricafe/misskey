/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { AuthenticateService, type StreamingCredential } from '@/server/api/AuthenticateService.js';
import { MiAccessToken, MiApp, MiUser, miRepository, type MiRepository } from '@/models/_.js';
import { genAidx } from '@/misc/id/aidx.js';
import { initTestDb } from '../utils.js';

test('rechecks native, OAuth and legacy app credentials against one database snapshot', async () => {
	const db = await initTestDb(true);
	const runner = db.createQueryRunner();
	await runner.startTransaction();
	try {
		const users = runner.manager.getRepository(MiUser).extend(miRepository as MiRepository<MiUser>);
		const tokens = runner.manager.getRepository(MiAccessToken).extend(miRepository as MiRepository<MiAccessToken>);
		const apps = runner.manager.getRepository(MiApp).extend(miRepository as MiRepository<MiApp>);
		const service = new AuthenticateService(users, tokens, apps, {} as never);
		try {
			const userId = genAidx(Date.now());
			const appId = genAidx(Date.now());
			const native = { userId, token: genAidx(Date.now()), accessTokenId: null, permissions: [] };
			const direct = { userId, token: 'direct-token', accessTokenId: genAidx(Date.now()), permissions: ['read:account'] };
			const legacy = { userId, token: 'LEGACY-HASH', accessTokenId: genAidx(Date.now()), permissions: ['read:drive'] };
			await users.insert({ id: userId, username: userId, usernameLower: userId, token: native.token });
			await apps.insert({ id: appId, name: 'Legacy', description: '', secret: 'secret', permission: ['read:drive'] });
			await tokens.insert([
				{ id: direct.accessTokenId, userId, token: direct.token, hash: 'direct-hash', permission: direct.permissions },
				{ id: legacy.accessTokenId, userId, appId, token: 'legacy-token', hash: 'legacy-hash', permission: ['read:account'] },
			]);
			const handshake = { fresh: true, updateLastUsedAt: false, timeoutMs: 10_000 };
			expect((await service.authenticate(native.token, handshake))[0]?.id).toBe(userId);
			expect((await service.authenticate(legacy.token, handshake))[1]?.permission).toEqual(['read:drive']);
			expect((await service.authenticate(direct.token, handshake))[1]?.id).toBe(direct.accessTokenId);
			const credentials: StreamingCredential[] = [
				native, direct, legacy, { ...direct, token: 'DIRECT-HASH' }, { ...legacy, token: 'legacy-token' },
				{ ...direct, permissions: ['read:drive'] }, { ...legacy, permissions: ['read:account'] },
				{ ...native, token: 'incorrect' }, { ...direct, userId: genAidx(Date.now()) },
				{ ...direct, token: 'DIRECT-TOKEN' },
			];
			expect(await service.verifyStreamingCredentials(credentials, 10_000)).toEqual(new Set([0, 1, 2, 3, 4]));
			const query = runner.query.bind(runner);
			const slow = vi.spyOn(runner, 'query').mockImplementation((sql, params) =>
				query(sql.replace('SELECT c.position', 'SELECT c.position, pg_sleep(2)'), params));
			try {
				await runner.query("SET LOCAL statement_timeout = '0'");
				await expect(service.verifyStreamingCredentials([native], 100)).rejects.toMatchObject({ code: '57014' });
				expect(await runner.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '0' }]);
				await runner.query("SET LOCAL statement_timeout = '50ms'");
				await expect(service.verifyStreamingCredentials([native], 10_000)).rejects.toMatchObject({ code: '57014' });
				expect(await runner.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '50ms' }]);
			} finally {
				slow.mockRestore();
				await runner.query('SET LOCAL statement_timeout = DEFAULT');
			}
			expect(await service.verifyStreamingCredentials([native], 10_000)).toEqual(new Set([0]));
			await users.update(userId, { token: genAidx(Date.now()) });
			await apps.update(appId, { permission: [] });
			expect(await service.verifyStreamingCredentials(credentials, 10_000)).toEqual(new Set([1, 3]));
			await users.update(userId, { isSuspended: true });
			expect(await service.verifyStreamingCredentials(credentials, 10_000)).toEqual(new Set());
			await users.update(userId, { isSuspended: false, isDeleted: true });
			expect(await service.verifyStreamingCredentials(credentials, 10_000)).toEqual(new Set());
			await users.update(userId, { isDeleted: false });
			await tokens.delete(direct.accessTokenId);
			expect(await service.verifyStreamingCredentials(credentials, 10_000)).toEqual(new Set());
		} finally {
			service.dispose();
		}
	} finally {
		await runner.rollbackTransaction();
		await runner.release();
		await db.destroy();
	}
});
