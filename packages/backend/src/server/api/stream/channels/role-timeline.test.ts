/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import type { Packed } from '@/misc/json-schema.js';
import { RoleTimelineChannel } from './role-timeline.js';

describe('RoleTimelineChannel isAvailable coalescing', () => {
	function createChannels(count: number, rolesRepository: { exists: ReturnType<typeof vi.fn> }) {
		const noteStreamingHidingService = {
			filter: vi.fn(async (note: Packed<'Note'>) => note),
		};
		const noteEntityService = {
			withMyRenoteReaction: vi.fn(async (note: Packed<'Note'>) => note),
		};

		const subscriber = new EventEmitter();
		subscriber.setMaxListeners(count + 20);
		const sentMessages: Array<{ channelId: string; type: string; noteId: string }> = [];

		const channels = Array.from({ length: count }, (_, i) => {
			const connection = {
				user: null,
				userProfile: null,
				following: {},
				userIdsWhoMeMuting: new Set<string>(),
				userIdsWhoMeMutingRenotes: new Set<string>(),
				userIdsWhoBlockingMe: new Set<string>(),
				userMutedInstances: new Set<string>(),
				followingChannels: new Set<string>(),
				mutingChannels: new Set<string>(),
				subscriber,
				sendMessageToWs: vi.fn((_type: string, body: { id: string; type: string; body: { id: string } }) => {
					sentMessages.push({ channelId: body.id, type: body.type, noteId: body.body.id });
				}),
			};
			return new RoleTimelineChannel(
				{ id: `ch-${i}`, connection } as never,
				rolesRepository as never,
				noteEntityService as never,
				noteStreamingHidingService as never,
			);
		});

		return { channels, subscriber, sentMessages };
	}

	function makeNote(id: string): Packed<'Note'> {
		return {
			id,
			visibility: 'public',
			userId: 'author-1',
			user: { id: 'author-1', host: null, requireSigninToViewContents: false },
			renote: null,
			reply: null,
		} as unknown as Packed<'Note'>;
	}

	test('coalesces 100 concurrent subscribers into one DB exists query per broadcast', async () => {
		const resolvers: Array<(value: boolean) => void> = [];
		const rolesRepository = {
			exists: vi.fn(() => new Promise<boolean>(resolve => {
				resolvers.push(resolve);
			})),
		};
		const { channels, subscriber, sentMessages } = createChannels(100, rolesRepository);

		const initPromises = channels.map(ch => ch.init({ roleId: 'role-1' }));
		await vi.waitFor(() => expect(rolesRepository.exists).toHaveBeenCalledTimes(1));
		resolvers.shift()!(true);
		const initResults = await Promise.all(initPromises);
		expect(initResults.every(Boolean)).toBe(true);

		subscriber.emit('roleTimelineStream:role-1', { type: 'note', body: makeNote('note-1') });
		await vi.waitFor(() => expect(rolesRepository.exists).toHaveBeenCalledTimes(2));
		resolvers.shift()!(true);

		await vi.waitFor(() => expect(sentMessages).toHaveLength(100));
	});

	test('does not reuse an already-dispatched check when a second event arrives after the role becomes private', async () => {
		const resolvers: Array<(value: boolean) => void> = [];
		const rolesRepository = {
			exists: vi.fn(() => new Promise<boolean>(resolve => {
				resolvers.push(resolve);
			})),
		};
		const { channels, subscriber, sentMessages } = createChannels(5, rolesRepository);

		const initPromises = channels.map(ch => ch.init({ roleId: 'role-1' }));
		await vi.waitFor(() => expect(rolesRepository.exists).toHaveBeenCalledTimes(1));
		resolvers.shift()!(true);
		await Promise.all(initPromises);

		subscriber.emit('roleTimelineStream:role-1', { type: 'note', body: makeNote('note-before-private') });
		await vi.waitFor(() => expect(rolesRepository.exists).toHaveBeenCalledTimes(2));

		subscriber.emit('roleTimelineStream:role-1', { type: 'note', body: makeNote('note-after-private') });
		await vi.waitFor(() => expect(rolesRepository.exists).toHaveBeenCalledTimes(3));

		const resolveFirstEvent = resolvers.shift()!;
		const resolveSecondEvent = resolvers.shift()!;
		resolveSecondEvent(false);
		resolveFirstEvent(true);

		await vi.waitFor(() => expect(sentMessages).toHaveLength(5));
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(sentMessages.every(m => m.noteId === 'note-before-private')).toBe(true);
	});
});
