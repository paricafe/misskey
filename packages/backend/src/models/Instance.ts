/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, PrimaryColumn, Index, Column } from 'typeorm';
import { id } from './util/id.js';

@Entity('instance')
export class MiInstance {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column('timestamp with time zone', {
		comment: 'The caught date of the Instance.',
	})
	public firstRetrievedAt: Date;

	@Index({ unique: true })
	@Column('varchar', {
		length: 128,
		comment: 'The host of the Instance.',
	})
	public host: string;

	@Column('integer', {
		default: 0,
		comment: 'The count of the users of the Instance.',
	})
	public usersCount: number;

	@Column('integer', {
		default: 0,
		comment: 'The count of the notes of the Instance.',
	})
	public notesCount: number;

	@Column('integer', {
		default: 0,
	})
	public followingCount: number;

	@Column('integer', {
		default: 0,
	})
	public followersCount: number;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public latestRequestReceivedAt: Date | null;

	@Column('boolean', {
		default: false,
	})
	public isNotResponding: boolean;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public notRespondingSince: Date | null;

	@Index()
	@Column('enum', {
		default: 'none',
		enum: ['none', 'manuallySuspended', 'goneSuspended', 'autoSuspendedForNotResponding'],
	})
	public suspensionState: 'none' | 'manuallySuspended' | 'goneSuspended' | 'autoSuspendedForNotResponding';

	@Column('varchar', {
		length: 64, nullable: true,
		comment: 'The software of the Instance.',
	})
	public softwareName: string | null;

	@Column('varchar', {
		length: 64, nullable: true,
	})
	public softwareVersion: string | null;

	@Column('boolean', {
		nullable: true,
	})
	public openRegistrations: boolean | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public name: string | null;

	@Column('varchar', {
		length: 4096, nullable: true,
	})
	public description: string | null;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public maintainerName: string | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public maintainerEmail: string | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public iconUrl: string | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public faviconUrl: string | null;

	@Column('varchar', {
		length: 64, nullable: true,
	})
	public themeColor: string | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public infoUpdatedAt: Date | null;

	@Column('varchar', {
		length: 16384, default: '',
	})
	public moderationNote: string;
}
