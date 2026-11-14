/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MiSystemWebhook } from '@/models/SystemWebhook.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { id } from './util/id.js';
import { MiUser } from './User.js';

export type RecipientMethod = 'email' | 'webhook';

@Entity('abuse_report_notification_recipient')
export class MiAbuseReportNotificationRecipient {
	@PrimaryColumn(id())
	public id: string;

	@Index('IDX_abuse_report_notification_recipient_isActive')
	@Column('boolean', {
		default: true,
	})
	public isActive: boolean;

	@Column('timestamp with time zone', {
		default: () => 'CURRENT_TIMESTAMP',
	})
	public updatedAt: Date;

	@Column('varchar', {
		length: 255,
	})
	public name: string;

	@Index('IDX_abuse_report_notification_recipient_method')
	@Column('varchar', {
		length: 64,
	})
	public method: RecipientMethod;

	@Index('IDX_abuse_report_notification_recipient_userId')
	@Column({
		...id(),
		nullable: true,
		default: null,
	})
	public userId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'userId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_abuse_report_notification_recipient_userId1' })
	public user: MiUser | null;

	@ManyToOne(() => MiUserProfile, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'userId', referencedColumnName: 'userId', foreignKeyConstraintName: 'FK_abuse_report_notification_recipient_userId2' })
	public userProfile: MiUserProfile | null;

	@Index('IDX_abuse_report_notification_recipient_systemWebhookId')
	@Column({
		...id(),
		nullable: true,
		default: null,
	})
	public systemWebhookId: string | null;

	@ManyToOne(() => MiSystemWebhook, {
		onDelete: 'CASCADE',
	})
	@JoinColumn({ name: 'systemWebhookId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_abuse_report_notification_recipient_systemWebhookId' })
	public systemWebhook: MiSystemWebhook | null;
}
