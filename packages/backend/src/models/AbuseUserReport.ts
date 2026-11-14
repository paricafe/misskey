/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

export type AbuseReportResolveType = 'accept' | 'reject';

@Entity('abuse_user_report')
export class MiAbuseUserReport {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column(id())
	public targetUserId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public targetUser: MiUser | null;

	@Index()
	@Column(id())
	public reporterId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public reporter: MiUser | null;

	@Column({
		...id(),
		nullable: true,
	})
	public assigneeId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'SET NULL',
	})
	@JoinColumn()
	public assignee: MiUser | null;

	@Index()
	@Column('boolean', {
		default: false,
	})
	public resolved: boolean;

	@Column('boolean', {
		default: false,
	})
	public forwarded: boolean;

	@Column('varchar', {
		length: 2048,
	})
	public comment: string;

	@Column('varchar', {
		length: 8192, default: '',
	})
	public moderationNote: string;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public resolvedAs: AbuseReportResolveType | null;

	@Index()
	@Column('varchar', {
		length: 128, nullable: true,
		comment: '[Denormalized]',
	})
	public targetUserHost: string | null;

	@Index()
	@Column('varchar', {
		length: 128, nullable: true,
		comment: '[Denormalized]',
	})
	public reporterHost: string | null;
}
