/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import type { MiRemoteUser } from '@/models/User.js';
import { ApDeliverManagerService } from './ApDeliverManagerService.js';
import type { IActivity } from './type.js';

const actor = { id: 'local-user', host: null };
const activity = { type: 'Create', actor: 'https://local.example/users/local-user' } as IActivity;

function remoteUser(inbox: string | null, sharedInbox: string | null = null): MiRemoteUser {
	return { inbox, sharedInbox } as MiRemoteUser;
}

function createService(rows: { inbox: string | null; isSharedInbox: boolean }[] = []) {
	// Build the real PostgreSQL query without opening a database connection.
	const query = new DataSource({ type: 'postgres' }).createQueryBuilder().from('following', 'following');
	const getRawMany = vi.spyOn(query, 'getRawMany').mockResolvedValue(rows);
	const followings = { createQueryBuilder: vi.fn().mockReturnValue(query) };
	const deliverMany = vi.fn().mockResolvedValue(undefined);
	const service = new ApDeliverManagerService(followings as never, {} as never, { deliverMany } as never);
	return { service, followings, query, getRawMany, deliverMany };
}

describe(ApDeliverManagerService, () => {
	test('queries unique effective inboxes and keeps shared declarations independent of follower order', async () => {
		const { service, query, deliverMany } = createService([
			{ inbox: 'https://remote.example/shared', isSharedInbox: true },
			{ inbox: 'https://legacy.example/users/alice/inbox', isSharedInbox: false },
		]);

		await service.deliverToFollowers(actor, activity);

		expect(query.getQueryAndParameters()).toEqual([
			'SELECT COALESCE(following."followerSharedInbox", following."followerInbox") AS "inbox", BOOL_OR(following."followerSharedInbox" IS NOT NULL) AS "isSharedInbox" FROM "following" "following" WHERE following."followeeId" = $1 AND following."followerHost" IS NOT NULL GROUP BY COALESCE(following."followerSharedInbox", following."followerInbox")',
			[actor.id],
		]);
		expect(deliverMany).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, activity, new Map([
			['https://remote.example/shared', true],
			['https://legacy.example/users/alice/inbox', false],
		]));
	});

	test('rejects followers without either inbox before enqueueing any delivery', async () => {
		const { service, deliverMany } = createService([
			{ inbox: 'https://remote.example/shared', isSharedInbox: true },
			{ inbox: null, isSharedInbox: false },
		]);
		const manager = service.createDeliverManager(actor, activity);
		manager.addDirectRecipe(remoteUser('https://another.example/inbox'));
		manager.addFollowersRecipe();

		await expect(manager.execute()).rejects.toThrow('inbox is null');
		expect(deliverMany).not.toHaveBeenCalled();
	});

	test('processes followers before direct recipes and only queries once for duplicate follower recipes', async () => {
		const sharedInbox = 'https://remote.example/shared';
		const { service, getRawMany, deliverMany } = createService([{ inbox: sharedInbox, isSharedInbox: true }]);
		const manager = service.createDeliverManager(actor, activity);
		manager.addDirectRecipe(remoteUser('https://remote.example/users/alice/inbox', sharedInbox));
		manager.addFollowersRecipe();
		manager.addFollowersRecipe();

		await manager.execute();

		expect(getRawMany).toHaveBeenCalledOnce();
		expect(deliverMany).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, activity, new Map([[sharedInbox, true]]));
	});

	test('keeps the direct-recipe override when its private inbox matches an existing shared target', async () => {
		const inbox = 'https://remote.example/inbox';
		const { service, deliverMany } = createService([{ inbox, isSharedInbox: true }]);
		const manager = service.createDeliverManager(actor, activity);
		manager.addFollowersRecipe();
		manager.addDirectRecipe(remoteUser(inbox));

		await manager.execute();

		expect(deliverMany).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, activity, new Map([[inbox, false]]));
	});

	test('skips a direct recipe whose shared URL is already an individual follower target', async () => {
		const inbox = 'https://remote.example/inbox';
		const { service, deliverMany } = createService([{ inbox, isSharedInbox: false }]);
		const manager = service.createDeliverManager(actor, activity);
		manager.addFollowersRecipe();
		manager.addDirectRecipe(remoteUser('https://remote.example/users/alice/inbox', inbox));

		await manager.execute();

		expect(deliverMany).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, activity, new Map([[inbox, false]]));
	});

	test('deduplicates direct recipients and skips missing private inboxes without querying followers', async () => {
		const inbox = 'https://remote.example/users/alice/inbox';
		const { service, followings, deliverMany } = createService();

		await service.deliverToUsers(actor, activity, [
			remoteUser(inbox),
			remoteUser(inbox),
			remoteUser(null, 'https://remote.example/shared'),
		]);

		expect(followings.createQueryBuilder).not.toHaveBeenCalled();
		expect(deliverMany).toHaveBeenCalledExactlyOnceWith({ id: actor.id }, activity, new Map([[inbox, false]]));
	});
});
