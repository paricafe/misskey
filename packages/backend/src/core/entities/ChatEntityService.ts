/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiUser, ChatMessagesRepository, MiChatMessage, ChatRoomsRepository, MiChatRoom, MiChatRoomInvitation, ChatRoomInvitationsRepository, MiChatRoomMembership, ChatRoomMembershipsRepository } from '@/models/_.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { Packed } from '@/misc/json-schema.js';
import type { } from '@/models/Blocking.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { UserEntityService } from './UserEntityService.js';
import { DriveFileEntityService } from './DriveFileEntityService.js';
import { In } from 'typeorm';

@Injectable()
export class ChatEntityService {
	constructor(
		@Inject(DI.chatMessagesRepository)
		private chatMessagesRepository: ChatMessagesRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomInvitationsRepository)
		private chatRoomInvitationsRepository: ChatRoomInvitationsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		private userEntityService: UserEntityService,
		private driveFileEntityService: DriveFileEntityService,
		private idService: IdService,
	) {
	}

	@bindThis
	public async packMessageDetailed(
		src: MiChatMessage['id'] | MiChatMessage,
		me?: { id: MiUser['id'] },
		options?: {
			_hint_?: {
				packedFiles?: Map<MiChatMessage['fileId'], Packed<'DriveFile'> | null>;
				packedUsers?: Map<MiChatMessage['id'], Packed<'UserLite'>>;
				packedRooms?: Map<MiChatMessage['toRoomId'], Packed<'ChatRoom'> | null>;
			};
		},
	): Promise<Packed<'ChatMessage'>> {
		const packedUsers = options?._hint_?.packedUsers;
		const packedFiles = options?._hint_?.packedFiles;
		const packedRooms = options?._hint_?.packedRooms;

		const message = typeof src === 'object' ? src : await this.chatMessagesRepository.findOneByOrFail({ id: src });

		const reactions: { user: Packed<'UserLite'> | null; reaction: string; }[] = [];

		for (const record of message.reactions) {
			const [userId, reaction] = record.split('/');
			reactions.push({
				user: packedUsers?.get(userId) ?? (await this.userEntityService.pack(userId).catch(() => null)),
				reaction,
			});
		}

		return {
			id: message.id,
			createdAt: this.idService.parse(message.id).date.toISOString(),
			text: message.text,
			fromUserId: message.fromUserId,
			fromUser: packedUsers?.get(message.fromUserId) ?? (await this.userEntityService.pack(message.fromUser ?? message.fromUserId, me)),
			toUserId: message.toUserId,
			toUser: message.toUserId ? (packedUsers?.get(message.toUserId) ?? (await this.userEntityService.pack(message.toUser ?? message.toUserId, me))) : undefined,
			toRoomId: message.toRoomId,
			toRoom: message.toRoomId ? (packedRooms?.get(message.toRoomId) ?? (await this.packRoom(message.toRoom ?? message.toRoomId, me))) : undefined,
			fileId: message.fileId,
			file: message.fileId
				? (packedFiles?.has(message.fileId) ? (packedFiles.get(message.fileId) ?? null) : (await this.driveFileEntityService.pack(message.file ?? message.fileId)))
				: null,
			reactions: reactions.filter((r): r is { user: Packed<'UserLite'>; reaction: string; } => r.user != null),
		};
	}

	private async packMessageFilesMap(messages: MiChatMessage[]): Promise<Map<MiChatMessage['fileId'], Packed<'DriveFile'> | null>> {
		const loadedFiles = new Map<string, NonNullable<MiChatMessage['file']>>();
		const missingFileIds = new Set<string>();
		for (const message of messages) {
			if (message.file != null) {
				loadedFiles.set(message.file.id, message.file);
				missingFileIds.delete(message.file.id);
			} else if (message.fileId != null && !loadedFiles.has(message.fileId)) {
				missingFileIds.add(message.fileId);
			}
		}

		const [packedLoaded, packedByIds] = await Promise.all([
			loadedFiles.size > 0 ? this.driveFileEntityService.packMany([...loadedFiles.values()]) : [],
			missingFileIds.size > 0 ? this.driveFileEntityService.packManyByIdsMap([...missingFileIds]) : new Map<string, Packed<'DriveFile'> | null>(),
		]);

		const map = new Map<MiChatMessage['fileId'], Packed<'DriveFile'> | null>(packedByIds);
		for (const file of packedLoaded) {
			map.set(file.id, file);
		}
		return map;
	}

	@bindThis
	public async packMessagesDetailed(
		messages: MiChatMessage[],
		me: { id: MiUser['id'] },
	) {
		if (messages.length === 0) return [];

		const usersById = new Map<MiUser['id'], MiUser | MiUser['id']>();
		const addUser = (user: MiUser | MiUser['id'] | null | undefined) => {
			if (user == null) return;
			if (typeof user === 'string') {
				if (!usersById.has(user)) usersById.set(user, user);
			} else {
				usersById.set(user.id, user);
			}
		};

		for (const m of messages) {
			addUser(m.fromUser ?? m.fromUserId);
			addUser(m.toUser ?? m.toUserId);
			for (const reaction of m.reactions) {
				addUser(reaction.split('/')[0]);
			}
		}

		const [packedUsers, packedFiles, packedRooms] = await Promise.all([
			this.userEntityService.packMany([...usersById.values()], me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.packMessageFilesMap(messages),
			this.packRooms(messages.map(m => m.toRoom ?? m.toRoomId).filter(x => x != null), me)
				.then(rooms => new Map(rooms.map(r => [r.id, r]))),
		]);

		return Promise.all(messages.map(message => this.packMessageDetailed(message, me, { _hint_: { packedUsers, packedFiles, packedRooms } })));
	}

	@bindThis
	public async packMessageLiteFor1on1(
		src: MiChatMessage['id'] | MiChatMessage,
		options?: {
			_hint_?: {
				packedFiles: Map<MiChatMessage['fileId'], Packed<'DriveFile'> | null>;
			};
		},
	): Promise<Packed<'ChatMessageLiteFor1on1'>> {
		const packedFiles = options?._hint_?.packedFiles;

		const message = typeof src === 'object' ? src : await this.chatMessagesRepository.findOneByOrFail({ id: src });

		const reactions: { reaction: string; }[] = [];

		for (const record of message.reactions) {
			const [, reaction] = record.split('/');
			reactions.push({
				reaction,
			});
		}

		return {
			id: message.id,
			createdAt: this.idService.parse(message.id).date.toISOString(),
			text: message.text,
			fromUserId: message.fromUserId,
			toUserId: message.toUserId!,
			fileId: message.fileId,
			file: message.fileId
				? (packedFiles?.has(message.fileId) ? (packedFiles.get(message.fileId) ?? null) : (await this.driveFileEntityService.pack(message.file ?? message.fileId)))
				: null,
			reactions,
		};
	}

	@bindThis
	public async packMessagesLiteFor1on1(
		messages: MiChatMessage[],
	) {
		if (messages.length === 0) return [];

		const packedFiles = await this.packMessageFilesMap(messages);

		return Promise.all(messages.map(message => this.packMessageLiteFor1on1(message, { _hint_: { packedFiles } })));
	}

	@bindThis
	public async packMessageLiteForRoom(
		src: MiChatMessage['id'] | MiChatMessage,
		options?: {
			_hint_?: {
				packedFiles: Map<MiChatMessage['fileId'], Packed<'DriveFile'> | null>;
				packedUsers: Map<MiUser['id'], Packed<'UserLite'>>;
			};
		},
	): Promise<Packed<'ChatMessageLiteForRoom'>> {
		const packedFiles = options?._hint_?.packedFiles;
		const packedUsers = options?._hint_?.packedUsers;

		const message = typeof src === 'object' ? src : await this.chatMessagesRepository.findOneByOrFail({ id: src });

		const reactions: { user: Packed<'UserLite'> | null; reaction: string; }[] = [];

		for (const record of message.reactions) {
			const [userId, reaction] = record.split('/');
			reactions.push({
				user: packedUsers?.get(userId) ?? (await this.userEntityService.pack(userId).catch(() => null)),
				reaction,
			});
		}

		return {
			id: message.id,
			createdAt: this.idService.parse(message.id).date.toISOString(),
			text: message.text,
			fromUserId: message.fromUserId,
			fromUser: packedUsers?.get(message.fromUserId) ?? (await this.userEntityService.pack(message.fromUser ?? message.fromUserId)),
			toRoomId: message.toRoomId!,
			fileId: message.fileId,
			file: message.fileId
				? (packedFiles?.has(message.fileId) ? (packedFiles.get(message.fileId) ?? null) : (await this.driveFileEntityService.pack(message.file ?? message.fileId)))
				: null,
			reactions: reactions.filter((r): r is { user: Packed<'UserLite'>; reaction: string; } => r.user != null),
		};
	}

	@bindThis
	public async packMessagesLiteForRoom(
		messages: MiChatMessage[],
	) {
		if (messages.length === 0) return [];

		const usersById = new Map<MiUser['id'], MiUser | MiUser['id']>();
		for (const m of messages) {
			if (m.fromUser != null) {
				usersById.set(m.fromUser.id, m.fromUser);
			} else if (!usersById.has(m.fromUserId)) {
				usersById.set(m.fromUserId, m.fromUserId);
			}
			for (const reaction of m.reactions) {
				const reactedUserId = reaction.split('/')[0];
				if (!usersById.has(reactedUserId)) usersById.set(reactedUserId, reactedUserId);
			}
		}

		const [packedUsers, packedFiles] = await Promise.all([
			this.userEntityService.packMany([...usersById.values()])
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.packMessageFilesMap(messages),
		]);

		return Promise.all(messages.map(message => this.packMessageLiteForRoom(message, { _hint_: { packedFiles, packedUsers } })));
	}

	@bindThis
	public async packRoom(
		src: MiChatRoom['id'] | MiChatRoom,
		me?: { id: MiUser['id'] },
		options?: {
			_hint_?: {
				packedOwners: Map<MiChatRoom['id'], Packed<'UserLite'>>;
				myMemberships?: Map<MiChatRoom['id'], MiChatRoomMembership | null | undefined>;
				myInvitations?: Map<MiChatRoom['id'], MiChatRoomInvitation | null | undefined>;
			};
		},
	): Promise<Packed<'ChatRoom'>> {
		const room = typeof src === 'object' ? src : await this.chatRoomsRepository.findOneByOrFail({ id: src });

		const membership = me && me.id !== room.ownerId
			? (options?._hint_?.myMemberships?.has(room.id)
				? (options._hint_.myMemberships.get(room.id) ?? null)
				: (await this.chatRoomMembershipsRepository.findOneBy({ roomId: room.id, userId: me.id })))
			: null;
		const invitation = me && me.id !== room.ownerId
			? (options?._hint_?.myInvitations?.has(room.id)
				? (options._hint_.myInvitations.get(room.id) ?? null)
				: (await this.chatRoomInvitationsRepository.findOneBy({ roomId: room.id, userId: me.id })))
			: null;

		return {
			id: room.id,
			createdAt: this.idService.parse(room.id).date.toISOString(),
			name: room.name,
			description: room.description,
			ownerId: room.ownerId,
			owner: options?._hint_?.packedOwners.get(room.ownerId) ?? (await this.userEntityService.pack(room.owner ?? room.ownerId, me)),
			isMuted: membership != null ? membership.isMuted : false,
			invitationExists: invitation != null,
		};
	}

	@bindThis
	public async packRooms(
		rooms: (MiChatRoom | MiChatRoom['id'])[],
		me: { id: MiUser['id'] },
	) {
		if (rooms.length === 0) return [];

		const loadedRoomsById = new Map<MiChatRoom['id'], MiChatRoom>();
		const missingRoomIds = new Set<MiChatRoom['id']>();
		for (const room of rooms) {
			if (typeof room === 'string') {
				if (!loadedRoomsById.has(room)) missingRoomIds.add(room);
			} else {
				loadedRoomsById.set(room.id, room);
				missingRoomIds.delete(room.id);
			}
		}
		const _rooms = [...loadedRoomsById.values()];
		if (missingRoomIds.size > 0) {
			_rooms.push(
				...(await this.chatRoomsRepository.find({
					where: {
						id: In([...missingRoomIds]),
					},
					relations: { owner: true },
				})),
			);
		}

		const owners = _rooms.map(x => x.owner ?? x.ownerId);
		const nonOwnedRoomIds = _rooms.filter(r => r.ownerId !== me.id).map(r => r.id);

		const [packedOwners, myMemberships, myInvitations] = await Promise.all([
			this.userEntityService.packMany(owners, me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			nonOwnedRoomIds.length > 0
				? this.chatRoomMembershipsRepository.find({
					where: {
						roomId: In(nonOwnedRoomIds),
						userId: me.id,
					},
				}).then(memberships => {
					const byRoomId = new Map(memberships.map(m => [m.roomId, m]));
					return new Map<MiChatRoom['id'], MiChatRoomMembership | null>(
						nonOwnedRoomIds.map(id => [id, byRoomId.get(id) ?? null]),
					);
				})
				: new Map<MiChatRoom['id'], MiChatRoomMembership | null>(),
			nonOwnedRoomIds.length > 0
				? this.chatRoomInvitationsRepository.find({
					where: {
						roomId: In(nonOwnedRoomIds),
						userId: me.id,
					},
				}).then(invitations => {
					const byRoomId = new Map(invitations.map(i => [i.roomId, i]));
					return new Map<MiChatRoom['id'], MiChatRoomInvitation | null>(
						nonOwnedRoomIds.map(id => [id, byRoomId.get(id) ?? null]),
					);
				})
				: new Map<MiChatRoom['id'], MiChatRoomInvitation | null>(),
		]);

		return Promise.all(_rooms.map(room => this.packRoom(room, me, { _hint_: { packedOwners, myMemberships, myInvitations } })));
	}

	@bindThis
	public async packRoomInvitation(
		src: MiChatRoomInvitation['id'] | MiChatRoomInvitation,
		me: { id: MiUser['id'] },
		options?: {
			_hint_?: {
				packedRooms: Map<MiChatRoomInvitation['roomId'], Packed<'ChatRoom'>>;
				packedUsers: Map<MiChatRoomInvitation['id'], Packed<'UserLite'>>;
			};
		},
	): Promise<Packed<'ChatRoomInvitation'>> {
		const invitation = typeof src === 'object' ? src : await this.chatRoomInvitationsRepository.findOneByOrFail({ id: src });

		return {
			id: invitation.id,
			createdAt: this.idService.parse(invitation.id).date.toISOString(),
			roomId: invitation.roomId,
			room: options?._hint_?.packedRooms.get(invitation.roomId) ?? (await this.packRoom(invitation.room ?? invitation.roomId, me)),
			userId: invitation.userId,
			user: options?._hint_?.packedUsers.get(invitation.userId) ?? (await this.userEntityService.pack(invitation.user ?? invitation.userId, me)),
		};
	}

	@bindThis
	public async packRoomInvitations(
		invitations: MiChatRoomInvitation[],
		me: { id: MiUser['id'] },
	) {
		if (invitations.length === 0) return [];

		const [packedRooms, packedUsers] = await Promise.all([
			this.packRooms(invitations.map(i => i.room ?? i.roomId), me)
				.then(rooms => new Map(rooms.map(r => [r.id, r]))),
			this.userEntityService.packMany(invitations.map(i => i.user ?? i.userId), me)
				.then(users => new Map(users.map(u => [u.id, u]))),
		]);

		return Promise.all(invitations.map(invitation => this.packRoomInvitation(invitation, me, { _hint_: { packedRooms, packedUsers } })));
	}

	@bindThis
	public async packRoomMembership(
		src: MiChatRoomMembership['id'] | MiChatRoomMembership,
		me: { id: MiUser['id'] },
		options?: {
			populateUser?: boolean;
			populateRoom?: boolean;
			_hint_?: {
				packedRooms: Map<MiChatRoomMembership['roomId'], Packed<'ChatRoom'>>;
				packedUsers: Map<MiChatRoomMembership['id'], Packed<'UserLite'>>;
			};
		},
	): Promise<Packed<'ChatRoomMembership'>> {
		const membership = typeof src === 'object' ? src : await this.chatRoomMembershipsRepository.findOneByOrFail({ id: src });

		return {
			id: membership.id,
			createdAt: this.idService.parse(membership.id).date.toISOString(),
			userId: membership.userId,
			user: options?.populateUser ? (options._hint_?.packedUsers.get(membership.userId) ?? (await this.userEntityService.pack(membership.user ?? membership.userId, me))) : undefined,
			roomId: membership.roomId,
			room: options?.populateRoom ? (options._hint_?.packedRooms.get(membership.roomId) ?? (await this.packRoom(membership.room ?? membership.roomId, me))) : undefined,
		};
	}

	@bindThis
	public async packRoomMemberships(
		memberships: MiChatRoomMembership[],
		me: { id: MiUser['id'] },
		options: {
			populateUser?: boolean;
			populateRoom?: boolean;
		} = {},
	) {
		if (memberships.length === 0) return [];

		const users = memberships.map(x => x.user ?? x.userId);
		const rooms = memberships.map(x => x.room ?? x.roomId);

		const [packedUsers, packedRooms] = await Promise.all([
			this.userEntityService.packMany(users, me)
				.then(users => new Map(users.map(u => [u.id, u]))),
			this.packRooms(rooms, me)
				.then(rooms => new Map(rooms.map(r => [r.id, r]))),
		]);

		return Promise.all(memberships.map(membership => this.packRoomMembership(membership, me, { ...options, _hint_: { packedUsers, packedRooms } })));
	}
}
