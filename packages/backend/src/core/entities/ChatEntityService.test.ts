/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiChatMessage } from '@/models/ChatMessage.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiChatRoomInvitation } from '@/models/ChatRoomInvitation.js';
import type { MiUser } from '@/models/User.js';
import { ChatEntityService } from './ChatEntityService.js';

describe('ChatEntityService batching', () => {
	function createService() {
		const chatMessagesRepository = { findOneByOrFail: vi.fn() };
		const chatRoomsRepository = {
			find: vi.fn().mockResolvedValue([]),
			findOneByOrFail: vi.fn(),
		};
		const chatRoomInvitationsRepository = {
			find: vi.fn().mockResolvedValue([]),
			findOneBy: vi.fn().mockResolvedValue(null),
			findOneByOrFail: vi.fn(),
		};
		const chatRoomMembershipsRepository = {
			find: vi.fn().mockResolvedValue([]),
			findOneBy: vi.fn().mockResolvedValue(null),
			findOneByOrFail: vi.fn(),
		};
		const userEntityService = {
			pack: vi.fn(async (src: MiUser | string) => ({ id: typeof src === 'string' ? src : src.id })),
			packMany: vi.fn(async (srcs: Array<MiUser | string>) => srcs.map(s => ({ id: typeof s === 'string' ? s : s.id }))),
		};
		const driveFileEntityService = {
			pack: vi.fn(),
			packMany: vi.fn(async (files: Array<{ id: string }>) => files.map(f => ({ id: f.id }))),
			packManyByIdsMap: vi.fn(async (ids: string[]) => new Map(ids.map(id => [id, id === 'file-missing' ? null : { id }]))),
		};
		const idService = {
			parse: () => ({ date: new Date('2026-01-01T00:00:00.000Z') }),
		};

		const service = new ChatEntityService(
			chatMessagesRepository as never,
			chatRoomsRepository as never,
			chatRoomInvitationsRepository as never,
			chatRoomMembershipsRepository as never,
			userEntityService as never,
			driveFileEntityService as never,
			idService as never,
		);

		return {
			service,
			chatRoomsRepository,
			chatRoomInvitationsRepository,
			chatRoomMembershipsRepository,
			userEntityService,
			driveFileEntityService,
		};
	}

	test('packMessagesDetailed batches me and unjoined fileIds without N+1 fallbacks', async () => {
		const { service, userEntityService, driveFileEntityService } = createService();
		const messages = [
			{
				id: 'm1',
				text: 'hi',
				fromUserId: 'me',
				toUserId: 'peer',
				toRoomId: null,
				fileId: 'file-unjoined',
				file: null,
				reactions: ['me/👍'],
			},
			{
				id: 'm2',
				text: 'yo',
				fromUserId: 'peer',
				toUserId: 'me',
				toRoomId: null,
				fileId: 'file-missing',
				file: null,
				reactions: [],
			},
		] as unknown as MiChatMessage[];

		const packed = await service.packMessagesDetailed(messages, { id: 'me' });

		expect(packed).toHaveLength(2);
		expect(packed[0].fromUser.id).toBe('me');
		expect(packed[0].file?.id).toBe('file-unjoined');
		expect(packed[1].file).toBeNull();
		expect(userEntityService.packMany).toHaveBeenCalledTimes(1);
		expect(userEntityService.pack).not.toHaveBeenCalled();
		expect(driveFileEntityService.packManyByIdsMap).toHaveBeenCalledTimes(1);
		expect(driveFileEntityService.pack).not.toHaveBeenCalled();
	});

	test('packRooms avoids N+1 membership and invitation fallbacks when none exist', async () => {
		const { service, chatRoomMembershipsRepository, chatRoomInvitationsRepository } = createService();
		const rooms = [
			{ id: 'r1', name: 'Room 1', description: '', ownerId: 'owner-1', owner: null },
			{ id: 'r2', name: 'Room 2', description: '', ownerId: 'owner-2', owner: null },
			{ id: 'r3', name: 'Owned', description: '', ownerId: 'me', owner: null },
		] as unknown as MiChatRoom[];

		chatRoomMembershipsRepository.find.mockResolvedValue([
			{ roomId: 'r1', userId: 'me', isMuted: true },
		]);
		chatRoomInvitationsRepository.find.mockResolvedValue([]);

		const packed = await service.packRooms(rooms, { id: 'me' });

		expect(packed.map(r => [r.id, r.isMuted, r.invitationExists])).toEqual([
			['r1', true, false],
			['r2', false, false],
			['r3', false, false],
		]);
		expect(chatRoomMembershipsRepository.find).toHaveBeenCalledTimes(1);
		expect(chatRoomInvitationsRepository.find).toHaveBeenCalledTimes(1);
		expect(chatRoomMembershipsRepository.findOneBy).not.toHaveBeenCalled();
		expect(chatRoomInvitationsRepository.findOneBy).not.toHaveBeenCalled();
	});

	test('packRoomInvitations batches rooms and users in parallel', async () => {
		const { service, chatRoomsRepository, userEntityService } = createService();
		chatRoomsRepository.find.mockResolvedValue([
			{ id: 'r1', name: 'Room 1', description: '', ownerId: 'owner-1', owner: null },
			{ id: 'r2', name: 'Room 2', description: '', ownerId: 'owner-2', owner: null },
		]);
		const invitations = [
			{ id: 'inv-1', roomId: 'r1', room: null, userId: 'u1', user: null },
			{ id: 'inv-2', roomId: 'r2', room: null, userId: 'u2', user: null },
		] as unknown as MiChatRoomInvitation[];

		const packed = await service.packRoomInvitations(invitations, { id: 'me' });

		expect(packed).toHaveLength(2);
		expect(chatRoomsRepository.find).toHaveBeenCalledTimes(1);
		expect(chatRoomsRepository.findOneByOrFail).not.toHaveBeenCalled();
		expect(userEntityService.pack).not.toHaveBeenCalled();
	});
});
