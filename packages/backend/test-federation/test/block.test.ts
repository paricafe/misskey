import { describe, test, beforeAll, vi } from 'vitest';
import { deepStrictEqual, rejects, strictEqual } from 'node:assert';
import * as Misskey from 'misskey-js';
import { assertNotificationReceived, createAccount, type LoginUser, resolveRemoteNote, resolveRemoteUser, sleep, WAIT_FOR_FEDERATION } from './utils.js';

describe('Block', () => {
	async function waitForBlocked(blocked: LoginUser, blockerId: string): Promise<void> {
		await vi.waitFor(async () => {
			const blocker = await blocked.client.request('users/show', { userId: blockerId });
			strictEqual(blocker.isBlocked, true);
		}, WAIT_FOR_FEDERATION);
	}

	async function waitForUnblocked(blocked: LoginUser, blockerId: string): Promise<void> {
		await vi.waitFor(async () => {
			const blocker = await blocked.client.request('users/show', { userId: blockerId });
			strictEqual(blocker.isBlocked, false);
		}, WAIT_FOR_FEDERATION);
	}

	describe('Check follow', () => {
		let alice: LoginUser, bob: LoginUser;
		let bobInA: Misskey.entities.UserDetailedNotMe, aliceInB: Misskey.entities.UserDetailedNotMe;

		beforeAll(async () => {
			[alice, bob] = await Promise.all([
				createAccount('a.test'),
				createAccount('b.test'),
			]);

			[bobInA, aliceInB] = await Promise.all([
				resolveRemoteUser('b.test', bob.id, alice),
				resolveRemoteUser('a.test', alice.id, bob),
			]);
		});

		test('Cannot follow if blocked', async () => {
			await alice.client.request('blocking/create', { userId: bobInA.id });
			await waitForBlocked(bob, aliceInB.id);
			await rejects(
				async () => await bob.client.request('following/create', { userId: aliceInB.id }),
				(err: any) => {
					strictEqual(err.code, 'BLOCKED');
					return true;
				},
			);

			const following = await bob.client.request('users/following', { userId: bob.id });
			strictEqual(following.length, 0);
			const followers = await alice.client.request('users/followers', { userId: alice.id });
			strictEqual(followers.length, 0);
		});

		test('Can follow if unblocked', async () => {
			await alice.client.request('blocking/delete', { userId: bobInA.id });
			await waitForUnblocked(bob, aliceInB.id);
			await bob.client.request('following/create', { userId: aliceInB.id });
			await vi.waitFor(async () => {
				const following = await bob.client.request('users/following', { userId: bob.id });
				strictEqual(following.length, 1);
				const followers = await alice.client.request('users/followers', { userId: alice.id });
				strictEqual(followers.length, 1);
			}, WAIT_FOR_FEDERATION);
		});

		test.skip('Remove follower when block them', async () => {
			test('before block', async () => {
				const following = await bob.client.request('users/following', { userId: bob.id });
				strictEqual(following.length, 1);
				const followers = await alice.client.request('users/followers', { userId: alice.id });
				strictEqual(followers.length, 1);
			});

			await alice.client.request('blocking/create', { userId: bobInA.id });
			await sleep();

			test('after block', async () => {
				const following = await bob.client.request('users/following', { userId: bob.id });
				strictEqual(following.length, 0);
				const followers = await alice.client.request('users/followers', { userId: alice.id });
				strictEqual(followers.length, 0);
			});
		});
	});

	describe('Check reply', () => {
		let alice: LoginUser, bob: LoginUser;
		let bobInA: Misskey.entities.UserDetailedNotMe, aliceInB: Misskey.entities.UserDetailedNotMe;

		beforeAll(async () => {
			[alice, bob] = await Promise.all([
				createAccount('a.test'),
				createAccount('b.test'),
			]);

			[bobInA, aliceInB] = await Promise.all([
				resolveRemoteUser('b.test', bob.id, alice),
				resolveRemoteUser('a.test', alice.id, bob),
			]);
		});

		test('Cannot reply if blocked', async () => {
			await alice.client.request('blocking/create', { userId: bobInA.id });
			await waitForBlocked(bob, aliceInB.id);

			const note = (await alice.client.request('notes/create', { text: 'a' })).createdNote;
			const resolvedNote = await resolveRemoteNote('a.test', note.id, bob);
			await rejects(
				async () => await bob.client.request('notes/create', { text: 'b', replyId: resolvedNote.id }),
				(err: any) => {
					strictEqual(err.code, 'CANNOT_REPLY_TO_AN_INVISIBLE_NOTE');
					return true;
				},
			);
		});

		test('Can reply if unblocked', async () => {
			await alice.client.request('blocking/delete', { userId: bobInA.id });
			await sleep();

			const note = (await alice.client.request('notes/create', { text: 'a' })).createdNote;
			const resolvedNote = await resolveRemoteNote('a.test', note.id, bob);
			const reply = (await bob.client.request('notes/create', { text: 'b', replyId: resolvedNote.id })).createdNote;

			await resolveRemoteNote('b.test', reply.id, alice);
		});
	});

	describe('Check reaction', () => {
		let alice: LoginUser, bob: LoginUser;
		let bobInA: Misskey.entities.UserDetailedNotMe, aliceInB: Misskey.entities.UserDetailedNotMe;

		beforeAll(async () => {
			[alice, bob] = await Promise.all([
				createAccount('a.test'),
				createAccount('b.test'),
			]);

			[bobInA, aliceInB] = await Promise.all([
				resolveRemoteUser('b.test', bob.id, alice),
				resolveRemoteUser('a.test', alice.id, bob),
			]);
		});

		test('Cannot reaction if blocked', async () => {
			await alice.client.request('blocking/create', { userId: bobInA.id });
			await waitForBlocked(bob, aliceInB.id);

			const note = (await alice.client.request('notes/create', { text: 'a' })).createdNote;
			const resolvedNote = await resolveRemoteNote('a.test', note.id, bob);
			await rejects(
				async () => await bob.client.request('notes/reactions/create', { noteId: resolvedNote.id, reaction: '😅' }),
				(err: any) => {
					strictEqual(err.code, 'YOU_HAVE_BEEN_BLOCKED');
					return true;
				},
			);
		});

		test('Can react if unblocked', async () => {
			await alice.client.request('blocking/delete', { userId: bobInA.id });
			await waitForUnblocked(bob, aliceInB.id);
			const note = (await alice.client.request('notes/create', { text: 'a' })).createdNote;
			const resolvedNote = await resolveRemoteNote('a.test', note.id, bob);
			await bob.client.request('notes/reactions/create', { noteId: resolvedNote.id, reaction: '😅' });
			await vi.waitFor(async () => {
				const updated = await alice.client.request('notes/show', { noteId: note.id });
				deepStrictEqual(updated.reactions, { '😅': 1 });
			}, WAIT_FOR_FEDERATION);
		});
	});

	describe('Check mention', () => {
		let alice: LoginUser, bob: LoginUser;
		let bobInA: Misskey.entities.UserDetailedNotMe, aliceInB: Misskey.entities.UserDetailedNotMe;

		beforeAll(async () => {
			[alice, bob] = await Promise.all([
				createAccount('a.test'),
				createAccount('b.test'),
			]);

			[bobInA, aliceInB] = await Promise.all([
				resolveRemoteUser('b.test', bob.id, alice),
				resolveRemoteUser('a.test', alice.id, bob),
			]);
		});

		test('Can mention and notified even if blocked', async () => {
			await alice.client.request('blocking/create', { userId: bobInA.id });
			await waitForBlocked(bob, aliceInB.id);

			const text = `@${alice.username}@a.test plz unblock me!`;
			await assertNotificationReceived(
				'a.test', alice,
				async () => await bob.client.request('notes/create', { text }),
				notification => notification.type === 'mention' && notification.userId === bobInA.id && notification.note.text === text,
				true,
			);
		});
	});
});
