/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as Redis from 'ioredis';
import { expect, test, vi } from 'vitest';
import { loadConfig } from '@/config.js';
import { CredentialRevocationService } from '@/core/CredentialRevocationService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { genAidx } from '@/misc/id/aidx.js';
import { generateNativeUserToken, nativeTokenFingerprint } from '@/misc/token.js';
import { MiAccessToken, MiApp, MiSwSubscription, MiUser, MiUserProfile, miRepository, type MiRepository } from '@/models/_.js';
import { MiCredentialRevocation } from '@/models/CredentialRevocation.js';
import { AuthenticateService } from '@/server/api/AuthenticateService.js';
import RegenerateToken from '@/server/api/endpoints/i/regenerate-token.js';
import RevokeToken from '@/server/api/endpoints/i/revoke-token.js';
import { CredentialRevocation1795196263875 } from '../../migration/1795196263875-CredentialRevocation.js';
import { initTestDb } from '../utils.js';

test('commits rotations and revocations during a publisher outage, then publishes each committed event across workers', async () => {
	const config = { ...loadConfig(), host: randomUUID() };
	const db = await initTestDb();
	const reader = await initTestDb(true);
	const users = db.getRepository(MiUser).extend(miRepository as MiRepository<MiUser>);
	const profiles = db.getRepository(MiUserProfile).extend(miRepository as MiRepository<MiUserProfile>);
	const access = db.getRepository(MiAccessToken).extend(miRepository as MiRepository<MiAccessToken>);
	const auth = new AuthenticateService(reader.getRepository(MiUser).extend(miRepository as MiRepository<MiUser>),
		reader.getRepository(MiAccessToken).extend(miRepository as MiRepository<MiAccessToken>), reader.getRepository(MiApp).extend(miRepository as MiRepository<MiApp>), {} as never);
	const pending = db.getRepository(MiCredentialRevocation);
	const unavailable = new Redis.Redis({ ...config.redisForPubsub, lazyConnect: true });
	const redis = new Redis.Redis(config.redisForPubsub);
	const subscriber = redis.duplicate();
	const messages: { channel: string; message: { type: string; body: Record<string, string> | null } }[] = [];
	subscriber.on('message', (_, message) => messages.push(JSON.parse(message)));
	const failed = new CredentialRevocationService(db, new GlobalEventService(config, unavailable));
	const events = new GlobalEventService(config, redis);
	const restarted = new CredentialRevocationService(reader, events);
	const rotate = new RegenerateToken(users, profiles, failed);
	const revoke = new RevokeToken(access, failed);
	const id = genAidx(Date.now());
	const first = generateNativeUserToken();
	const thirdParty = { id: genAidx(Date.now()), userId: id, token: randomUUID(), hash: randomUUID() };
	const subscription = { id: genAidx(Date.now()), userId: id, endpoint: 'https://localhost/push', auth: 'auth', publickey: 'key' };

	try {
		await users.insert({ id, username: id, usernameLower: id, token: first });
		await profiles.insert({ userId: id, password: await bcrypt.hash('test', 4) });
		await db.manager.insert(MiSwSubscription, subscription);
		await access.insert(thirdParty);
		const [me] = await auth.authenticate(first);
		await rotate.exec({ password: 'test', pushSubscription: subscription }, me!, null);
		const second = (await users.findOneByOrFail({ id })).token!;
		await rotate.exec({ password: 'test' }, me!, null);
		const current = (await users.findOneByOrFail({ id })).token!;
		await revoke.exec({ tokenId: thirdParty.id }, me!, null);
		await failed.dispatch();
		const rows = await pending.find({ where: { userId: id }, order: { id: 'ASC' } });
		expect(rows.map(row => row.credentialId)).toEqual([nativeTokenFingerprint(first), nativeTokenFingerprint(second), thirdParty.id]);
		for (const secret of [first, second, current, thirdParty.token]) expect(JSON.stringify(rows)).not.toContain(secret);
		expect(await db.manager.countBy(MiSwSubscription, { id: subscription.id })).toBe(0);
		for (const stale of [first, second, thirdParty.token]) await expect(auth.authenticate(stale)).rejects.toThrow();
		expect((await auth.authenticate(current))[0]?.id).toBe(id);
		expect(messages).toHaveLength(0);

		await restarted.dispatch();
		expect(await pending.countBy({ userId: id })).toBe(3);
		await subscriber.subscribe(config.host);
		await events.publishCredentialRevocation(rows[1]);
		await Promise.all([restarted.dispatch(), new CredentialRevocationService(db, events).dispatch()]);
		await vi.waitFor(() => expect(messages).toHaveLength(5));
		expect(await pending.countBy({ userId: id })).toBe(0);
		expect(messages.filter(m => m.channel === 'internal').map(m => m.message.body)).toEqual(expect.arrayContaining([
			{ id, oldTokenHash: nativeTokenFingerprint(second) },
			{ id, oldTokenHash: nativeTokenFingerprint(first) },
			{ id: thirdParty.id, userId: id },
		]));
		for (const secret of [first, second, current, thirdParty.token]) expect(JSON.stringify(messages)).not.toContain(secret);
		expect((await auth.authenticate(current))[0]?.id).toBe(id);

		await events.publishCredentialRevocation({ ...rows[2], id: rows[0].id, credentialId: genAidx(Date.now()) });
		await vi.waitFor(() => expect(messages).toHaveLength(6));

		await db.manager.insert(MiSwSubscription, subscription);
		await expect(db.transaction(async manager => {
			const nested = new RegenerateToken(manager.withRepository(users), profiles, failed);
			await nested.exec({ password: 'test', pushSubscription: subscription }, me!, null);
			throw new Error('rollback');
		})).rejects.toThrow('rollback');
		expect((await auth.authenticate(current))[0]?.id).toBe(id);
		expect(await db.manager.countBy(MiSwSubscription, { id: subscription.id })).toBe(1);
		expect(await pending.countBy({ userId: id })).toBe(0);

		await access.insert(thirdParty);
		await expect(db.transaction(async manager => {
			await failed.deleteAccessTokens(manager, { id: thirdParty.id });
			throw new Error('rollback');
		})).rejects.toThrow('rollback');
		expect(await access.countBy({ id: thirdParty.id })).toBe(1);
		expect(await pending.countBy({ userId: id })).toBe(0);
	} finally {
		await Promise.all([failed.onApplicationShutdown(), restarted.onApplicationShutdown()]);
		await pending.delete({ userId: id });
		await users.delete(id);
		auth.dispose();
		unavailable.disconnect();
		subscriber.disconnect();
		redis.disconnect();
		await Promise.all([db.destroy(), reader.destroy()]);
	}
});

test('refuses to revert the outbox while it contains committed work', async () => {
	const db = await initTestDb(true);
	const runner = db.createQueryRunner();
	const migration = new CredentialRevocation1795196263875();
	try {
		await runner.startTransaction();
		await runner.query('CREATE TEMPORARY TABLE credential_revocation (id integer)');
		await runner.query('INSERT INTO pg_temp.credential_revocation VALUES (1)');
		await runner.query('SAVEPOINT revert');
		await expect(migration.down(runner)).rejects.toThrow('Deliver pending credential revocations');
		await runner.query('ROLLBACK TO SAVEPOINT revert');
		expect(await runner.query('SELECT * FROM pg_temp.credential_revocation')).toEqual([{ id: 1 }]);
		await runner.query('DELETE FROM pg_temp.credential_revocation');
		await migration.down(runner);
		expect(await runner.query("SELECT to_regclass('pg_temp.credential_revocation') AS outbox")).toEqual([{ outbox: null }]);
	} finally {
		await runner.rollbackTransaction();
		await runner.release();
		await db.destroy();
	}
});
