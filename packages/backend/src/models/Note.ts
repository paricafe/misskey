/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, Index, JoinColumn, Column, PrimaryColumn, ManyToOne } from 'typeorm';
import { noteVisibilities, noteReactionAcceptances } from '@/types.js';
import type { Packed } from '@/misc/json-schema.js';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiChannel } from './Channel.js';
import type { MiDriveFile } from './DriveFile.js';

@Index(['userId', 'id'])
@Index('IDX_note_search_text', { synchronize: false })
@Entity('note')
export class MiNote {
	@PrimaryColumn(id())
	public id: string;

	@Column('timestamp with time zone', {
		comment: 'The update time of the Note.',
		default: null,
	})
	public updatedAt: Date | null;

	@Column('jsonb', {
		default: null,
		select: false,
	})
	public history: {
		createdAt: string,
		text: string | null,
		cw?: string | null,
		mentions?: MiUser['id'][],
		fileIds?: string[],
		files?: Packed<'DriveFile'>[],
		sensitive?: boolean,
		emojis?: string[],
		emojiUrls?: Record<string, string>,
		poll?: Packed<'Note'>['poll'],
		pollVotersCount?: number,
		renoteId?: MiNote['id'] | null,
	}[] | null;

	@Index()
	@Column({
		...id(),
		nullable: true,
		comment: 'The ID of reply target.',
	})
	public replyId: MiNote['id'] | null;

	@ManyToOne(() => MiNote, {
		createForeignKeyConstraints: false,
	})
	@JoinColumn()
	public reply: MiNote | null;

	@Index()
	@Column({
		...id(),
		nullable: true,
		comment: 'The ID of renote target.',
	})
	public renoteId: MiNote['id'] | null;

	@ManyToOne(() => MiNote, {
		createForeignKeyConstraints: false,
	})
	@JoinColumn()
	public renote: MiNote | null;

	@Index()
	@Column('varchar', {
		length: 256, nullable: true,
	})
	public threadId: string | null;

	@Column('text', {
		nullable: true,
	})
	public text: string | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public name: string | null;

	@Column('text', {
		nullable: true,
	})
	public cw: string | null;

	@Column({
		...id(),
		comment: 'The ID of author.',
	})
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public user: MiUser | null;

	@Column('boolean', {
		default: false,
	})
	public localOnly: boolean;

	@Column('varchar', {
		length: 64, nullable: true,
	})
	public reactionAcceptance: typeof noteReactionAcceptances[number];

	@Column('smallint', {
		default: 0,
	})
	public renoteCount: number;

	@Column('smallint', {
		default: 0,
	})
	public repliesCount: number;

	@Column('smallint', {
		default: 0,
	})
	public clippedCount: number;

	@Column('smallint', {
		default: 0,
	})
	public pageCount: number;

	@Column('jsonb', {
		default: {},
	})
	public reactions: Record<string, number>;

	@Column('uuid', {
		nullable: true,
	})
	public lastReactionsBufferId: string | null;

	@Column('enum', { enum: noteVisibilities })
	public visibility: typeof noteVisibilities[number];

	@Index({ unique: true })
	@Column('varchar', {
		length: 512, nullable: true,
		comment: 'The URI of a note. it will be null when the note is local.',
	})
	public uri: string | null;

	@Column('varchar', {
		length: 512, nullable: true,
		comment: 'The human readable url of a note. it will be null when the note is local.',
	})
	public url: string | null;

	@Index('IDX_NOTE_FILE_IDS', { synchronize: false })
	@Column({
		...id(),
		array: true, default: '{}',
	})
	public fileIds: MiDriveFile['id'][];

	@Column('varchar', {
		length: 256, array: true, default: '{}',
	})
	public attachedFileTypes: string[];

	@Index('IDX_NOTE_VISIBLE_USER_IDS', { synchronize: false })
	@Column({
		...id(),
		array: true, default: '{}',
	})
	public visibleUserIds: MiUser['id'][];

	@Index('IDX_NOTE_MENTIONS', { synchronize: false })
	@Column({
		...id(),
		array: true, default: '{}',
	})
	public mentions: MiUser['id'][];

	@Column('text', {
		default: '[]',
	})
	public mentionedRemoteUsers: string;

	@Column('varchar', {
		length: 1024, array: true, default: '{}',
	})
	public reactionAndUserPairCache: string[];

	@Column('varchar', {
		length: 128, array: true, default: '{}',
	})
	public emojis: string[];

	@Index('IDX_NOTE_TAGS', { synchronize: false })
	@Column('varchar', {
		length: 128, array: true, default: '{}',
	})
	public tags: string[];

	@Column('boolean', {
		default: false,
	})
	public hasPoll: boolean;

	@Index()
	@Column({
		...id(),
		nullable: true,
		comment: 'The ID of source channel.',
	})
	public channelId: MiChannel['id'] | null;

	@ManyToOne(() => MiChannel, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public channel: MiChannel | null;

	@Index()
	@Column('varchar', {
		length: 128, nullable: true,
		comment: '[Denormalized]',
	})
	public userHost: string | null;

	@Column({
		...id(),
		nullable: true,
		comment: '[Denormalized]',
	})
	public replyUserId: MiUser['id'] | null;

	@Column('varchar', {
		length: 128, nullable: true,
		comment: '[Denormalized]',
	})
	public replyUserHost: string | null;

	@Column({
		...id(),
		nullable: true,
		comment: '[Denormalized]',
	})
	public renoteUserId: MiUser['id'] | null;

	@Column('varchar', {
		length: 128, nullable: true,
		comment: '[Denormalized]',
	})
	public renoteUserHost: string | null;

	@Column({
		...id(),
		nullable: true,
		comment: '[Denormalized]',
	})
	public renoteChannelId: MiChannel['id'] | null;

	constructor(data: Partial<MiNote>) {
		if (data == null) return;

		for (const [k, v] of Object.entries(data)) {
			(this as any)[k] = v;
		}
	}
}

export type IMentionedRemoteUsers = {
	uri: string;
	url?: string;
	username: string;
	host: string;
}[];
